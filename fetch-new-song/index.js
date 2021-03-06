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

const spotifyBaseURL = "https://api.spotify.com/v1";

AWS.config.update({region: 'us-east-1'});
const documentClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

// Allows me to get the next hour from current UTC time

function setGlobalVariables(stageVariables) {
    if (stageVariables && stageVariables.environment === 'qa') {
        console.log('===================== Setting QA environment =====================');
        notificationTrackerTableName = "NotificationTrackerQA";
        watchedPlaylistsTableName = "WatchedPlaylistsQA";
        playlistFileKey = "playlists-qa.json";
        songTrackerTableName = "SongTrackMapperQA";

        return;
    }
}

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

async function getTracksAddedInTheLast24Hours(playlistId) {
    const spotifyToken = await fetchSpotifyToken();
    console.log(spotifyToken);
    let newTracksArray = []
    const getPlaylistRequestConfig = {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${spotifyToken}`
      }
    };
    const response = await fetch(`${spotifyBaseURL}/playlists/${playlistId}/tracks`, getPlaylistRequestConfig);
    let playlistResponse;
    if (response.status === 200) {
        playlistResponse = await response.json();
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
async function addTrackToDynamo(trackItem, playlistId) {
    console.log(`In Add track to Dynamo`);
    // generate uuid for track and add to current playlist on WatchedPlaylists table
    // push song info with uuid
    const trackUUID = uuidv4();
    const timeInUTC = new Date().toISOString();

    console.log(`TrackItem => ${JSON.stringify(trackItem)}`);
    if (true) {

    }
    const dynamoTrackPutParams = {
        TableName: songTrackerTableName,
        Item: {
            id: trackUUID,
            lastModifiedTimestamp: timeInUTC,
            trackId: trackItem.track.id,
            uri: trackItem.track.uri,
            name: trackItem.track.name,
            artist: trackItem.track.artists[0].name // For now just return the first artist??
        },
    };
    await documentClient.put(dynamoTrackPutParams).promise();

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
    await documentClient.update(updatePlaylistWithTrackParam).promise();
}

// Method to update tracks on playlist AND tracks tables
async function updateTracks() {
    // get s3 array
    const playlistArray = await getPlaylistArrayFromS3();
    console.log(`Array ============= ${JSON.stringify(playlistArray)}`);

    for (const currentPlaylist of playlistArray) {
        // console.log("=============In FOR OF=============");
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
                for (const trackUUID of trackUUIDs) {
                    console.log("==============Inner FOR LOOP=============");
                    console.log(`==============Current Track ${trackUUID}=============`);
                    const dynamoTrackGetParams = {
                        TableName: songTrackerTableName,
                        Key: {id: trackUUID}
                    };
                    const trackData = await documentClient.get(dynamoTrackGetParams).promise();
                    const track = trackData.Item;

                    const lastModifiedTimestamp = track.lastModifiedTimestamp;
                    // compare time - https://stackoverflow.com/a/19225540/2620826
                    const lastModifiedTimestampParsedDate = Date.parse(lastModifiedTimestamp);
                    const timeWithin24Hours = isTimeWithin24Hours(lastModifiedTimestampParsedDate);
                    if (!timeWithin24Hours) { // If the song has been in the table for over 24hrs, delete
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

                    } else { // don't do anything
                        console.log(`Time dateDifferenceInHours => ===== ${dateDifferenceInHours}`);
                    }
                    console.log(`==============Done with ${trackUUID}=============`);
                }
            } else {
                // No new song
                console.log("==================NO NEW SONG==================");
            }
        } catch (e) {
            console.log(`error fetching playlist items for playlistID: ${currentPlaylist}. Error => ${e.stack}`);
            continue; // If error, just continue to next playlist
        }
    }
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
            ExpressionAttributeValues: {
                ":time": currentHour.toString()
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
                if (isThereNewTrack && currentDevice.deviceToken) {
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
                    let res = await fetch('https://ho7won2i0j.execute-api.us-east-1.amazonaws.com/QA/send-notifications', config);
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

// Gets the new tracks of a playlist and puts it in a "track" object
async function getNewTracks(playlistId) {
    let newTracks = []
    try {
        const getPlaylistParams = {
            TableName: watchedPlaylistsTableName,
            Key: {playlistId: playlistId}
        }
        const data = await documentClient.get(getPlaylistParams).promise();
        const playlist = data.Item;
        if (playlist && playlist.trackUUIDs) {
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
            for (const trackUUID of trackUUIDArray) {
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
                    newTracks.push(trackObjectToReturn);
                }
                // console.log(`TRACK OBJECTS ${newTracks}`);
            }
        }
    } catch (e) {
        console.log(`Some error occured in getNewTracks ${e.stack}`);
        return [];
    }
    newTracks = removeDuplicatesFromTrackArray(newTracks);
    return newTracks;
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
    // Set variables based on environment
    setGlobalVariables(event.stageVariables);
    environmentFromStageVariable = event.stageVariables;
    try {
        // Used to get all tracks from all watched playlists
        if (event.path && event.path === "/tracks/new") {
            let response = {
                headers: {
                    "Content-Type": "application/json"
                }
            }
            const header = event.headers;
            const deviceIdFromRequest = header["device-id"];
            const getParams = {
                TableName: notificationTrackerTableName,
                Key: {deviceId: deviceIdFromRequest}
            }
            const data = await documentClient.get(getParams).promise();
            const device = data.Item;
            if (!device.watchedPlaylists) {
                response.statusCode = 404; // Returning not found if there are no watched Playlists. Basically a hack and easier for the front end to parse
            } else {
                response.statusCode = 200;
                const playlistIdArray = device.watchedPlaylists.values;
                let tracks = []
                for (const playlistId of playlistIdArray) {
                    const currentTracks = await getNewTracks(playlistId);
                    tracks.push(...currentTracks)
                }
                response.body = JSON.stringify(tracks)
            }
            return response;
        }

        // Update Playlist and Tracks tables by removing tracks over 24 hours
        await updateTracks();

        // get

        // Find a way to consolidate? Can a playlist be added between when updateTracks() runs vs this runs?
        const playlists = await getPlaylistArrayFromS3();
        // const playlists = ["6omtoYWO4IMVgUNF0vNI8L"]; // test
        console.log(playlists);

        // Tracks to see if notification should be sent
        // let shouldSendNotificationCounter = 0;
        for (const currentPlaylistId of playlists) {
            console.log(`========>${currentPlaylistId}<========`);
            // Get spotify Token
            // TODO:Find best way to handle expired tokens. Handle 401 issues.
            const tracks = await getTracksAddedInTheLast24Hours(currentPlaylistId);
            if (tracks.length > 0) { // IF there's at least one track
                for (const trackItem of tracks) {
                    console.log(`Adding track to dynamo ${JSON.stringify(trackItem)}`);
                    if (trackItem.track) {
                        // putting this counter here to ensure there indeed is at least one track added to dynamo, that will be shown to the user when they click on the notification
                        // shouldSendNotificationCounter += 1;
                        await addTrackToDynamo(trackItem, currentPlaylistId);
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