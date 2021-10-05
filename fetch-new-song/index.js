const AWS = require('aws-sdk');
const btoa = require('btoa');
const qs = require('qs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid'); // uuidv4()

var notificationTrackerTableName = process.env.NOTIFICATION_TRACKER_TABLE ? process.env.NOTIFICATION_TRACKER_TABLE : "NotificationTracker";
var watchedPlaylistsTableName = process.env.WATCHED_PLAYLISTS_TABLE ? process.env.WATCHED_PLAYLISTS_TABLE : "WatchedPlaylists";
var resourceBucket = "song-updater-resources";
var playlistFileKey = process.env.PLAYLIST_FILE_KEY ? process.env.PLAYLIST_FILE_KEY : "playlists.json";
var songTrackerTableName = process.env.SONG_TRACKER_TABLE ? process.env.SONG_TRACKER_TABLE : "SongTrackMapper";
var environmentFromStageVariable = "";
const ONE_DAY_IN_MILLISECONDS = 86400;

const spotifyBaseURL = "https://api.spotify.com/v1";

AWS.config.update({region: 'us-east-1'});
const documentClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

async function fetchSpotifyToken() {
    let config = {
	    method: "POST",
	    headers: {
	      "Content-Type": "application/x-www-form-urlencoded",
	      "Authorization": "Basic " + btoa(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET)
	    },
	    body: {
	      grant_type: 'client_credentials'
	    }
	}

	try {
		// url encode data to send to spotify
		config.body = qs.stringify(config.body);

		let res = await fetch('https://accounts.spotify.com/api/token', config);
		let data = await res.json();

		return data.access_token;
	} catch(err) {
		console.log(err);
		return err;
	}
}

async function getPlaylistArrayFromS3() {
    try {
        // Add to S3
        const getParams = {
            Bucket: resourceBucket,
            Key: playlistFileKey,
        }
        const data = await s3.getObject(getParams).promise();
        const jsonString = data.Body.toString('utf-8');
        console.log(`playlistArray jsonString from S3 ${jsonString}`);
        const playlistDictionary = JSON.parse(jsonString);
        return Object.keys(playlistDictionary);
    } catch (e) {
        console.log(`Error gettin json array from S3. Error => ${e.stack}`);
        throw e;
    }
}

function isTimeWithin24Hours(addedAtTimestamp) {
    let now = new Date().toISOString();
    now = Date.parse(now);
    const addedAtTimestampParsed = Date.parse(addedAtTimestamp);

    const dateDifferenceInHours = Math.trunc( (now - addedAtTimestampParsed) / 36e5 );
    // console.log(`TIME DIFFERENCE ${dateDifferenceInHours}`);
    return (dateDifferenceInHours < 24);
}

async function getTracksAddedInTheLast24Hours(playlistId, spotifyToken) {
    console.log(spotifyToken);
    let newTracksArray = []
    const getPlaylistRequestConfig = {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${spotifyToken}`
      }
    };
    const fetchTracksResponse = await fetch(`${spotifyBaseURL}/playlists/${playlistId}/tracks`, getPlaylistRequestConfig);
    let playlistResponse;
    if (fetchTracksResponse.status === 200) {
        playlistResponse = await fetchTracksResponse.json();
        let items = playlistResponse.items;
        // Filter array by added_at < 24hours and push results into newTracksArray with the aid of the spread operator
        newTracksArray.push(...(items.filter(item => isTimeWithin24Hours(item.added_at) )));
        while (playlistResponse.next && playlistResponse.next !== null) {
            console.log('Going through paginated urls');
            let paginatedResponse = await fetch(playlistResponse.next, getPlaylistRequestConfig);
            playlistResponse = await paginatedResponse.json();
            items = playlistResponse.items;
            newTracksArray.push(...(items.filter(item => isTimeWithin24Hours(item.added_at) )));
        }
    }
    console.log(`Leaving getTracksAddedInTheLast24Hour. Array => ${JSON.stringify(newTracksArray)}`);
    return newTracksArray;
}

// TODO: Use Batch write Item eventually?
// writes the new track to the playlist and track table with new songs in last 24 hoours
async function addTrackToDynamo(trackItem, playlistId, spotifyToken) {
    console.log(`In Add track to Dynamo`);
    // generate uuid for track and add to current playlist on WatchedPlaylists table
    // push song info with uuid
    const trackUUID = uuidv4();
    const now = new Date();
    const twentyFourHoursLater = Date.parse(new Date(now.setHours(now.getHours() + 24))) / 1000;
    const timeInUTC = now.toISOString();

    console.log(`TrackItem => ${JSON.stringify(trackItem)}`);

    // Fetch playlist title
    const getPlaylistRequestConfig = {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${spotifyToken}`
      }
    };
    const playlistResponse = await fetch(`${spotifyBaseURL}/playlists/${playlistId}`, getPlaylistRequestConfig);
    const playlistBody = await playlistResponse.json();

    // Add data to song table
    const dynamoTrackPutParams = {
        TableName: songTrackerTableName,
        Item: {
            id: trackUUID,
            lastModifiedTimestamp: timeInUTC,
            trackId: trackItem.track.id,
            uri: trackItem.track.uri,
            name: trackItem.track.name,
            artist: trackItem.track.artists[0].name, // For now just return the first artist??
            ttl: twentyFourHoursLater,
            playlistId: playlistId,
            playlistTitle: playlistBody.name
        },
    };
    console.log(`About to add song uuid to Song Tracker Table`);
    const updateSongTrackerResponse = await documentClient.put(dynamoTrackPutParams).promise();
    // Add uuid to playlist
    const updatePlaylistWithTrackParam = {
        TableName: watchedPlaylistsTableName,
        Key: {playlistId: playlistId},
        UpdateExpression: 'set lastModifiedTimestamp = :timestamp ADD trackUUIDs :track_uuid',
        ExpressionAttributeValues: {
            ":track_uuid": documentClient.createSet([trackUUID]),
            ":timestamp": timeInUTC
        }
    }
    const updateSetResponse = await documentClient.update(updatePlaylistWithTrackParam).promise();
    console.log(`Update param: ${JSON.stringify(updatePlaylistWithTrackParam)}`);
    console.log(`Update response ${JSON.stringify(updateSetResponse)}`);
    console.log(`Added ${trackUUID} to WatchedPlaylists Table`);
}

async function deleteSongUUIDFromPlaylistAndSongTable(trackUUID, currentPlaylist) {
    const deleteTrackParams = {
        TableName: songTrackerTableName,
        Key: {id: trackUUID}
    }
    const deletedData = await documentClient.delete(deleteTrackParams).promise();

    // Remove trackUUID from playlist table
    console.log(`==================REMOVING TRACK ${trackUUID} FROM SET==================`);
    const currentTimePlaylistTable = new Date().toISOString();
    const dynamoUpdateParams = {
        TableName: watchedPlaylistsTableName,
        Key: {playlistId: currentPlaylist},
        UpdateExpression: 'set lastModifiedTimestamp = :timestamp DELETE trackUUIDs :currentTrackUUID',
        ExpressionAttributeValues: {
            ":currentTrackUUID": documentClient.createSet([trackUUID]), // To remove an item from a set, you have to specify the item and encapsulate it in a set. createSet takes a list hence why [] is wrapped around the trackUUID needed to be deleted
            ":timestamp": currentTimePlaylistTable
        }
    }
    const dynamoDeleteResponse = await documentClient.update(dynamoUpdateParams).promise();
}

async function updateTrackOnSongTable(trackUUID) {
    try {
        console.log(`==============Current Track ${trackUUID}=============`);
        const dynamoTrackGetParams = {
            TableName: songTrackerTableName,
            Key: {id: trackUUID}
        };
        const trackData = await documentClient.get(dynamoTrackGetParams).promise();
        const track = trackData.Item;
        if (!track) { // re-think this and consolidate since it's similar to deleteSongUUIDFromPlaylistAndSongTable
            console.log(`==================REMOVING TRACK ${trackUUID} FROM SET==================`);
            const currentTimePlaylistTable = new Date().toISOString();
            const dynamoUpdateParams = {
                TableName: watchedPlaylistsTableName,
                Key: {playlistId: currentPlaylist},
                UpdateExpression: 'set lastModifiedTimestamp = :timestamp DELETE trackUUIDs :currentTrackUUID',
                ExpressionAttributeValues: {
                    ":currentTrackUUID": documentClient.createSet([trackUUID]), // To remove an item from a set, you have to specify the item and encapsulate it in a set. createSet takes a list hence why [] is wrapped around the trackUUID needed to be deleted
                    ":timestamp": currentTimePlaylistTable
                }
            }
            const dynamoDeleteResponse = await documentClient.update(dynamoUpdateParams).promise();
        } else {
            const lastModifiedTimestamp = track.lastModifiedTimestamp;
            // compare time - https://stackoverflow.com/a/19225540/2620826
            const lastModifiedTimestampParsedDate = Date.parse(lastModifiedTimestamp);
            const timeWithin24Hours = isTimeWithin24Hours(lastModifiedTimestampParsedDate);
            if (!timeWithin24Hours) { // If the song has been in the table for over 24hrs, delete
                console.log(`=================Deleting ${trackUUID}....=================`);
                await deleteSongUUIDFromPlaylistAndSongTable(trackUUID, currentPlaylist);
            } else { // don't do anything
                console.log(`Time dateDifferenceInHours => ===== ${dateDifferenceInHours}`);
            }
        }
        console.log(`==============Done with ${trackUUID}=============`);
    } catch (e) { // Doing this so that if something doesn't exists and/or throws error, for some reason, it continues to the next one
        console.log(`Error in inner trackUUID for loop to update song UUIDs for track ${trackUUID} in Playlist: ${currentPlaylist}`);
    }
}

async function updateTracksDynamoOperations(currentPlaylist) {
    try {
        const dynamoGetParams = {
            TableName: watchedPlaylistsTableName,
            Key: {playlistId: currentPlaylist}
        };
        const data = await documentClient.get(dynamoGetParams).promise();
        const playlist = data.Item;

        if (playlist.trackUUIDs) { // If current playlist has trackUUID array
            console.log(`IN if statement for ${currentPlaylist}`);
            let trackUUIDs = playlist.trackUUIDs.values; // get object from string set
            let updateTrackInDynamoFunctionCalls = [];
            for (const trackUUID of trackUUIDs) {
                updateTrackInDynamoFunctionCalls.push(updateTrackOnSongTable(trackUUID));
            }
            await Promise.all(updateTrackInDynamoFunctionCalls);
        } else {
            // No new song
            console.log("==================NO NEW SONG==================");
        }
    } catch (e) {
        console.log(`error fetching playlist items for playlistID: ${currentPlaylist}. Error => ${e.stack}`);
    }
}

// Method to update tracks on playlist AND tracks tables
async function updateTracks(playlistArray) {
    console.log(`Array ============= ${JSON.stringify(playlistArray)}`);
    let updatePlaylistHelperFunctionCalls = [];
    for (const currentPlaylist of playlistArray) {
        // console.log("=============In FOR OF=============");
        updatePlaylistHelperFunctionCalls.push(updateTracksDynamoOperations(currentPlaylist));
    }
    await Promise.all(updatePlaylistHelperFunctionCalls);
}

async function sendNotificationForCurrentTimeIfNeeded() {
    try {
        const now = new Date();
        const currentHour = now.getUTCHours();
        console.log(`Sending notifications to devices on ${currentHour.toString()} UTC time`);
        // const currentHour = "0";

        // Get all devices with current Hour aka preferredNotificationTime
        const dynamoQueryParam = {
            TableName: notificationTrackerTableName,
            IndexName: "preferredNotificationTimeIndex",
            KeyConditionExpression: "preferredNotificationTime = :time",
            FilterExpression: "stopNotification = :stopNotificationBooleanString",
            ExpressionAttributeValues: {
                ":time": currentHour.toString(),
                ":stopNotificationBooleanString": "false"
            }
        };

        const dynamoResponse = await documentClient.query(dynamoQueryParam).promise();
        const devices = dynamoResponse.Items;
        for (const currentDevice of devices) {
            if (currentDevice.watchedPlaylists) {
                // Get set values and check if at least one playlist has a new song
                const playlistIdArray = currentDevice.watchedPlaylists.values;
                const isThereNewTrack = await doesAtLeastOnePlaylistHaveNewTrack(playlistIdArray);
                console.log(`About to get into await if statement. isThereNewTrack is ${isThereNewTrack}`);
                if (isThereNewTrack === true && currentDevice.deviceToken) {
                    console.log(`Creating APN payload for ${currentDevice.deviceToken}`);
                    // Construct request to send notification to currentDevice
                    const apnPayload = {
                      message: "You have a new song to listen to! Open the app and head over to the New song tab to view them.",
                      deviceToken: currentDevice.deviceToken,
                      bundleID: (environmentFromStageVariable === 'qa') ? "me.borikanes.SongUpdaterQA" : "me.borikanes.SongUpdater"
                    }
                    const config = {
                	    method: "POST",
                	    headers: {
                	      "Content-Type": "application/json"
                	    },
                	    body: JSON.stringify(apnPayload)
                	}
                    const environmentForURL = (environmentFromStageVariable === 'qa') ? "QA" : "prod"
                    let res = await fetch(`https://ho7won2i0j.execute-api.us-east-1.amazonaws.com/${environmentForURL}/send-notifications`, config);
            		let data = await res.json();
                    if (data.statusCode === 200) {
                        console.log(`Sent notification to ${currentDevice.deviceId}`);
                    } else {
                        // Figure out what to do here? maybe
                        console.log(`Notification not sent. Got ${res.status} for ${currentDevice.deviceId}`);
                    }
                }
            }
            // else don't send, on to the next device
        }
    } catch (e) {
        console.log(`Error while sending Notification ${e.stack}`);
    }
}

async function doesAtLeastOnePlaylistHaveNewTrack(playlistArray) {
    for (const playlistId of playlistArray) {
        const dynamoGetParams = {
            TableName: watchedPlaylistsTableName,
            Key: {playlistId: playlistId}
        };
        const data = await documentClient.get(dynamoGetParams).promise();
        const playlist = data.Item;

        if (playlist.trackUUIDs) {
            return true;
        }
    }
    console.log(`Returning false on playlistArray ${playlistArray} in doesAtLeastOnePlaylistHaveNewTrack`);
    return false;
}

async function fetchTrackFromSpotifyAndConstructTrackObject(trackUUID, playlistId, getPlaylistRequestConfig) {
    console.log(`In fetch Track from spotify`);
    const getTrackParams = {
        TableName: songTrackerTableName,
        Key: {
            id: trackUUID
        }
    }

    const [trackData, playlistResponse] = await Promise.all([documentClient.get(getTrackParams).promise(), fetch(`${spotifyBaseURL}/playlists/${playlistId}`, getPlaylistRequestConfig)]);

    const track = trackData.Item;
    // If everything in the promise all is truly successful
    if (track && playlistResponse.status === 200) {
        const playlistBody = await playlistResponse.json();

        const trackObjectToReturn = {
            title: track.name,
            trackId: track.trackId,
            artist: track.artist,
            songURI: track.uri,
            playlistTitle: playlistBody.name
        }

        return trackObjectToReturn
    }
    return {};
}

// Gets the new tracks of a playlist and puts it in a "track" object
async function getNewTracks(playlistId) {
    console.log(`Playlist getting new tracks for =====> ${playlistId}`);
    let newTracks = []
    try {
        const getPlaylistParams = {
            TableName: watchedPlaylistsTableName,
            Key: {playlistId: playlistId}
        }
        console.log(`Dynamo Param ====> ${JSON.stringify(getPlaylistParams)}`);
        const data = await documentClient.get(getPlaylistParams).promise();
        const playlist = data.Item;
        if (playlist && playlist.trackUUIDs) {
            console.log(`Playlist has Track UUIDS`);
            // Get plalyist name for curent plalyist
            const spotifyToken = await fetchSpotifyToken();
            console.log(spotifyToken);
            const getPlaylistRequestConfig = {
              method: 'get',
              headers: {
                'Authorization': `Bearer ${spotifyToken}`
              }
            };

            // Loop through all tracks
            const trackUUIDArray = playlist.trackUUIDs.values;
            let getNewTracksHelperCalls = [];
            for (const trackUUID of trackUUIDArray) {
                console.log(`In track uuid array for loop`);
                getNewTracksHelperCalls.push(fetchTrackFromSpotifyAndConstructTrackObject(trackUUID, playlistId, getPlaylistRequestConfig));
            }

            const trackResponse = await Promise.all(getNewTracksHelperCalls);
            console.log(`TRACK RESPONSE => ${JSON.stringify(trackResponse)}`);
            const filteredTrackResponse = trackResponse.filter(trackObject => Object.keys(trackObject).length !== 0)
            newTracks = filteredTrackResponse
        }
    } catch (e) {
        console.log(`Some error occured in getNewTracks ${e.stack}`);
        return [];
    }
    newTracks = removeDuplicatesFromTrackArray(newTracks);
    return newTracks;
}

async function getNewTracksImproved(playlistId) {
    try {
        let songTrackerTableQueryParam = {
            TableName: songTrackerTableName,
            IndexName: "playlistId-index",
            KeyConditionExpression: "playlistId = :playlistId",
            ExpressionAttributeValues: {
                ":playlistId": playlistId
            }
        };

        const trackResponse = await documentClient.query(songTrackerTableQueryParam).promise();
        const tracks = trackResponse.Items;
        let newTracks = [];
        console.log(`Query Result ${JSON.stringify(trackResponse)}`);
        console.log(`Query ITEM Result ${JSON.stringify(tracks)}`);
        for (const track of tracks) {
            newTracks.push({
                title: track.name,
                trackId: track.trackId,
                artist: track.artist,
                songURI: track.uri,
                playlistTitle: track.playlistTitle
            })
        }
        // console.log(`newTracks before ${JSON.stringify(newTracks)}`);
        newTracks = removeDuplicatesFromTrackArray(newTracks);
        // console.log(`newTracks after ${JSON.stringify(newTracks)}`);
    } catch (e) {
        console.log(`Some error occured in getNewTracks ${e.stack}`);
        return [];
    }
}

// Removes duplicate tracks from getNewTracks response
function removeDuplicatesFromTrackArray(trackArray) {
    if (trackArray.length === 0) {
        return [];
    }
    // else
    let duplicateCheckerSet = new Set();
    let uniqueTrackArray = [];
    for (const track of trackArray) {
        if (track.trackId && !duplicateCheckerSet.has(track.trackId)) {
            duplicateCheckerSet.add(track.trackId);
            uniqueTrackArray.push(track);
        }
    }
    return uniqueTrackArray;
}



exports.handler = async (event) => {
    console.log(`Top of event`);
    // Set variables based on environment
    environmentFromStageVariable = event.stageVariables;
    try {
        // Used to get all tracks from all watched playlists
        if (event.path && event.path === "/tracks/new") {
            console.log(`In tracks New`);
            let response = {
                headers: {
                    "Content-Type": "application/json"
                }
            }
            const header = event.headers;
            const deviceIdFromRequest = header["device-id"];
            console.log(`Device Id in track New`);
            const getParams = {
                TableName: notificationTrackerTableName,
                Key: {deviceId: deviceIdFromRequest}
            }
            console.log(`New Tracks before get deviceId`);
            console.log(`Get params: ${JSON.stringify(getParams)}`);
            const data = await documentClient.get(getParams).promise();
            console.log(`New Tracks after get deviceId`);
            const device = data.Item;
            if (!device.watchedPlaylists) {
                response.statusCode = 404; // Returning not found if there are no watched Playlists. Basically a hack and easier for the front end to parse
            } else {
                response.statusCode = 200;
                const playlistIdArray = device.watchedPlaylists.values;
                console.log(`Playlist Array in New: ${playlistIdArray}`);
                // let tracks = []
                const getNewTracksFunctionArray = [];
                for (const playlistId of playlistIdArray) {
                    getNewTracksFunctionArray.push(getNewTracksImproved(playlistId));
                }

                let getNewTracksPromiseAllResponse = await Promise.all(getNewTracksFunctionArray);
                console.log(`RESPONSE BEFORE FLAT ${getNewTracksPromiseAllResponse}`);
                let tracks = getNewTracksPromiseAllResponse.flat();
                console.log(`RESPONSE AFTER FLAT ${tracks}`);
                response.body = JSON.stringify(tracks)
            }
            console.log(`New tracks Response ${response.body}`);
            return response;
        }

        // Find a way to consolidate? Can a playlist be added between when updateTracks() runs vs this runs?
        const playlists = await getPlaylistArrayFromS3();
        // const playlists = ["6omtoYWO4IMVgUNF0vNI8L"]; // test
        console.log(playlists);

        // Update Playlist and Tracks tables by removing tracks over 24 hours
        // await updateTracks(playlists);
        let songTrackerTableQueryParam = {
            TableName: songTrackerTableName,
            IndexName: "playlistId-index",
            KeyConditionExpression: "playlistId = :playlistId",
            // FilterExpression: "stopNotification = :stopNotificationBooleanString",
        };
        // Tracks to see if notification should be sent
        // let shouldSendNotificationCounter = 0;
        const spotifyToken = await fetchSpotifyToken();
        for (const currentPlaylistId of playlists) {
            console.log(`========>${currentPlaylistId}<========`);
            // Get spotify Token
            // TODO:Find best way to handle expired tokens. Handle 401 issues.
            songTrackerTableQueryParam.ExpressionAttributeValues = {
                ":playlistId": currentPlaylistId
            };
            const [tracks, songQueryResponse] = await Promise.all([getTracksAddedInTheLast24Hours(currentPlaylistId, spotifyToken), documentClient.query(songTrackerTableQueryParam).promise()]);
            const queriedSongs = songQueryResponse.Items;
            if (tracks.length > 0) { // IF there's at least one track
                for (const trackItem of tracks) {
                    if (trackItem.track) {
                        // putting this counter here to ensure there indeed is at least one track added to dynamo, that will be shown to the user when they click on the notification
                        // shouldSendNotificationCounter += 1;
                        const getTrackFromPlaylistFilter = queriedSongs.filter(currentSong => currentSong.trackId === trackItem.track.id);
                        if (getTrackFromPlaylistFilter.length === 0) {
                            console.log(`Adding track to dynamo ${JSON.stringify(trackItem)}`);
                            await addTrackToDynamo(trackItem, currentPlaylistId, spotifyToken);
                        } else {
                            console.log(`Track ${trackItem.track.id} already tied to playlist ${currentPlaylistId}`);
                        }
                    }
                }
            }
        }
        console.log(`Calling send notification for current time............`);
        await sendNotificationForCurrentTimeIfNeeded();

        // if (shouldSendNotificationCounter > 0) {
        //
        //     shouldSendNotificationCounter = 0;
        // }
    } catch (e) {
        console.log(`Some error occured in main handler => ${e.stack}`);
        throw e;
    }

    const response = {
        statusCode: 200,
        body: {message: "Success"},
        headers: {
            "Content-Type": "application/json"
        }
    }

    return response
}

// Edge case
// - User mistakenly adds track to playlist - adds playlist, cron job runs and user immediately removes playlist - should song list be updated?