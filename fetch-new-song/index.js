const AWS = require('aws-sdk');
const btoa = require('btoa');
const qs = require('qs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid'); // uuidv4()

const notificationTrackerTableName = "NotificationTracker";
const watchedPlaylistsTableName = "WatchedPlaylists";
const resourceBucket = "song-updater-resources";
const playlistFileKey = "playlists.json";
const songTrackerTableName = "SongTrackMapper";
const spotifyBaseURL = "https://api.spotify.com/v1";

AWS.config.update({region: 'us-east-1'});
const documentClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

// Allows me to get the next hour from current UTC time
/*const timeNow = new Date();
const timNowHourInUTC = timeNow.getUTCHours();
const preferredNotificationTimeToQuery = timNowHourInUTC;

const queryDynamoParam = {
    TableName : notificationTrackerTableName,
    KeyConditionExpression: "preferredNotificationTime = :time",
    ExpressionAttributeValues: {
        ":time": preferredNotificationTimeToQuery
    }
}

const dynamoResponse = await documentClient.query(queryDynamoParam).promise();
const devices = dynamoResponse.Items;
for (const currentDevice of devices) {
    if (currentDevice.watchedPlaylists) {

    }
}*/

async function fetchSpotifyToken() {
    const config = {
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
        const playlistDictionary = JSON.parse(jsonString);
        return Object.keys(playlistDictionary);
    } catch (e) {
        console.log(`Error gettin json array from S3. Error => ${e.stack}`);
        throw e;
    }
}

function isTimeWithin24Hours(addedAtTimestamp) {
    const now = new Date();
    const addedAtTimestampParsed = Date.parse(addedAtTimestamp);

    const dateDifferenceInHours = (now - addedAtTimestampParsed) / 36e5;

    return (dateDifferenceInHours < 144);
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
async function addTrackToDynamo(trackItem, playlistId) {
    console.log(`In Add track to Dynamo`);
    // generate uuid for track and add to current playlist on WatchedPlaylists table
    // push song info with uuid
    const trackUUID = uuidv4();
    const timeInUTC = new Date().toISOString();


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
    // console.log(`Array ============= ${playlistArray}`);

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

exports.handler = async (event) => {
    try {
        // Update Playlist and Tracks tables by removing tracks over 24 hours
        await updateTracks();

        // Find a way to consolidate? Can a playlist be added between when updateTracks() runs vs this runs?
        const playlists = await getPlaylistArrayFromS3();
        // const playlists = ["6omtoYWO4IMVgUNF0vNI8L"]; // test
        console.log(playlists);
        for (const currentPlaylistId of playlists) {
            console.log(`========>${currentPlaylistId}<========`);
            // Get spotify Token
            // TODO:Find best way to handle expired tokens. Handle 401 issues.
            const tracks = await getTracksAddedInTheLast24Hours(currentPlaylistId);
            if (tracks.length > 0) { // IF there's at least one track
                for (const trackItem of tracks) {
                    console.log(`Adding track to dynamo ${JSON.stringify(trackItem)}`);
                    await addTrackToDynamo(trackItem, currentPlaylistId);
                }
            }
        }

    } catch (e) {
        console.log(`Some error occured => ${e.stack}`);
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
