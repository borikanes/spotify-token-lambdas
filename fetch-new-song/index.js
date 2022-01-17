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
    const fetchTracksResponse = await fetch(`${spotifyBaseURL}/playlists/${playlistId}`, getPlaylistRequestConfig);
    let playlistResponseBody = await fetchTracksResponse.json();
    let playlistTracks = playlistResponseBody.tracks;

    /**if (fetchTracksResponse.status === 200) {
        let items = playlistTracks.items;

        do {
            console.log('Going through paginated urls');
            // Filter array by added_at < 24hours and push results into newTracksArray with the aid of the spread operator
            newTracksArray.push(...(items.filter(item => isTimeWithin24Hours(item.added_at) )));
            console.log('Going through paginated urls2');
            console.log(`next => ${JSON.stringify(playlistTracks)}`);
            let paginatedResponse = await fetch(playlistTracks.next, getPlaylistRequestConfig);
            console.log('Going through paginated urls3');
            playlistTracks = await paginatedResponse.json();
            console.log('Going through paginated urls4');
            items = playlistTracks.items;
        } while (playlistTracks.next && playlistTracks.next !== null);
    }*/

    if (fetchTracksResponse.status === 200) {
        let items = playlistTracks.items;
        // Filter array by added_at < 24hours and push results into newTracksArray with the aid of the spread operator
        newTracksArray.push(...(items.filter(item => isTimeWithin24Hours(item.added_at) )));
        while (playlistTracks.next && playlistTracks.next !== null) {
            console.log('Going through paginated urls');
            let paginatedResponse = await fetch(playlistTracks.next, getPlaylistRequestConfig);
            playlistTracks = await paginatedResponse.json();
            items = playlistTracks.items;
            newTracksArray.push(...(items.filter(item => isTimeWithin24Hours(item.added_at) )));
        }
    }

    // If spotify reloads 100% of their playlist, just ignore and return [].
    if (playlistResponseBody.tracks.total === newTracksArray.length && playlistResponseBody.owner.display_name === "Spotify") {
        console.log(`All tracks in playlist ${playlistId} is reloaded; weird spotify reload`);
        return [];
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
}

async function sendNotificationForCurrentTimeIfNeeded() {
    try {
        const now = new Date();
        const currentHour = now.getUTCHours();
        console.log(`Sending notifications to devices on ${currentHour.toString()} UTC time`);

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
        // TODO: Speed this up, do each device in parallel
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
                      bundleID: (process.env.ENV === 'qa') ? "me.borikanes.SongUpdaterQA" : "me.borikanes.SongUpdater"
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
        let songTrackerTableQueryParam = {
            TableName: songTrackerTableName,
            IndexName: "playlistId-index",
            KeyConditionExpression: "playlistId = :playlistId",
            ExpressionAttributeValues: {
                ":playlistId": playlistId
            }
        };
        const trackResponse = await documentClient.query(songTrackerTableQueryParam).promise();

        if (trackResponse && trackResponse.Items && trackResponse.Items.length > 0) {
            return true;
        }
    }
    console.log(`Returning false on playlistArray ${playlistArray} in doesAtLeastOnePlaylistHaveNewTrack`);
    return false;
}

// Gets the new tracks of a playlist and puts it in a "track" object
async function getNewTracks(playlistId) {
    let newTracks = [];
    try {
        let songTrackerTableQueryParam = {
            TableName: songTrackerTableName,
            IndexName: "playlistId-index",
            KeyConditionExpression: "playlistId = :playlistId",
            ExpressionAttributeValues: {
                ":playlistId": playlistId
            }
        };
        let trackResponse = {};
        do {
            trackResponse = await documentClient.query(songTrackerTableQueryParam).promise();
            const tracks = trackResponse.Items;
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

            songTrackerTableQueryParam.ExclusiveStartKey = trackResponse.LastEvaluatedKey;
        } while (typeof trackResponse.LastEvaluatedKey !== "undefined");

        newTracks = removeDuplicatesFromTrackArray(newTracks);
    } catch (e) {
        console.log(`Some error occured in getNewTracks ${e.stack}`);
        return [];
    }

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
                console.log(`Playlist Array in New: ${playlistIdArray}`);
                const getNewTracksFunctionArray = [];
                for (const playlistId of playlistIdArray) {
                    getNewTracksFunctionArray.push(getNewTracks(playlistId));
                }
                let getNewTracksPromiseAllResponse = await Promise.all(getNewTracksFunctionArray);
                let tracks = getNewTracksPromiseAllResponse.flat();
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
            const queriedSongs = songQueryResponse.Items ?? [];
            if (tracks.length > 0) { // IF there's at least one track
                for (const trackItem of tracks) {
                    if (trackItem.track) {
                        // Check if current track is in queried tracks from dynamo
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