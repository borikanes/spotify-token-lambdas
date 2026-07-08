const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('node:crypto');

var notificationTrackerTableName = process.env.NOTIFICATION_TRACKER_TABLE ? process.env.NOTIFICATION_TRACKER_TABLE : "NotificationTracker";
var watchedPlaylistsTableName = process.env.WATCHED_PLAYLISTS_TABLE ? process.env.WATCHED_PLAYLISTS_TABLE : "WatchedPlaylists";
var resourceBucket = "song-updater-resources";
var playlistFileKey = process.env.PLAYLIST_FILE_KEY ? process.env.PLAYLIST_FILE_KEY : "playlists.json";
var songTrackerTableName = process.env.SONG_TRACKER_TABLE ? process.env.SONG_TRACKER_TABLE : "SongTrackMapper";
var environmentFromStageVariable = "";
const ONE_DAY_IN_MILLISECONDS = 86400;

const spotifyBaseURL = "https://api.spotify.com/v1";

// removeUndefinedValues matches v2 DocumentClient leniency — without it, any undefined
// attribute (e.g. a missing playlist title) would make the whole put() throw
const documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: 'us-east-1' }),
    { marshallOptions: { removeUndefinedValues: true } }
);
const s3 = new S3Client({ region: 'us-east-1' });

// Playlists Spotify errored on during the current run, e.g. deleted/private playlists (404)
// or Spotify-owned playlists that are no longer accessible via the API.
// Module-level so getTracksAddedInTheLast24Hours can record into it; reset at the top of
// every invocation because module state survives warm Lambda restarts.
let failedPlaylists = [];

/**
 * Fetches a Spotify API access token using the client credentials flow.
 * Client credentials (not user OAuth) means the token can only read public playlists.
 *
 * @returns {Promise<string>} A Spotify access token.
 * @throws {Error} If Spotify rejects the request or returns no token — the whole run
 *   should abort in that case since every playlist fetch would 401 anyway.
 */
async function fetchSpotifyToken() {
    const config = {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString()
    };

    const res = await fetch('https://accounts.spotify.com/api/token', config);
    const data = await res.json();

    if (!res.ok || !data.access_token) {
        throw new Error(`Failed to fetch Spotify token. Status ${res.status}. Body => ${JSON.stringify(data)}`);
    }
    return data.access_token;
}

/**
 * Reads the dictionary of actively watched playlist IDs from S3 (written by
 * the playlist-table-handler lambda) and returns the IDs as an array.
 *
 * @returns {Promise<string[]>} Array of watched Spotify playlist IDs.
 * @throws Rethrows any S3/parse error — without the playlist file the cron has nothing to do.
 */
async function getPlaylistArrayFromS3() {
    try {
        const getParams = {
            Bucket: resourceBucket,
            Key: playlistFileKey,
        }
        const data = await s3.send(new GetObjectCommand(getParams));
        const jsonString = await data.Body.transformToString();
        console.log(`playlistArray jsonString from S3 ${jsonString}`);
        const playlistDictionary = JSON.parse(jsonString);
        return Object.keys(playlistDictionary);
    } catch (e) {
        console.log(`Error gettin json array from S3. Error => ${e.stack}`);
        throw e;
    }
}

/**
 * Checks whether a timestamp falls within the last 24 hours.
 *
 * @param {string} addedAtTimestamp - ISO 8601 timestamp (Spotify's track added_at).
 * @returns {boolean} True if the timestamp is less than 24 hours old.
 */
function isTimeWithin24Hours(addedAtTimestamp) {
    let now = new Date().toISOString();
    now = Date.parse(now);
    const addedAtTimestampParsed = Date.parse(addedAtTimestamp);

    const dateDifferenceInHours = Math.trunc( (now - addedAtTimestampParsed) / 36e5 );
    return (dateDifferenceInHours < 24);
}

/**
 * Fetches a playlist from Spotify (following pagination) and returns the track
 * items that were added in the last 24 hours, along with the playlist's title.
 *
 * If Spotify returns a non-200 for the playlist (deleted/private → 404, expired
 * token → 401, rate limit → 429), the playlist is recorded in failedPlaylists and
 * an empty track array is returned so one bad playlist can't kill the whole run.
 *
 * @param {string} playlistId - Spotify playlist ID.
 * @param {string} spotifyToken - Spotify API access token.
 * @returns {Promise<{tracks: Object[], playlistTitle: string}>} Track items added in the
 *   last 24 hours plus the playlist title; tracks is [] on error or when the playlist
 *   looks like a full Spotify-owned reload (anti-spam rule).
 */
async function getTracksAddedInTheLast24Hours(playlistId, spotifyToken) {
    let newTracksArray = []
    const getPlaylistRequestConfig = {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${spotifyToken}`
      }
    };
    const fetchTracksResponse = await fetch(`${spotifyBaseURL}/playlists/${playlistId}`, getPlaylistRequestConfig);
    const playlistResponseBody = await fetchTracksResponse.json();

    // Skip this playlist entirely on any Spotify error so the rest of the run continues.
    if (fetchTracksResponse.status !== 200) {
        console.log(`Skipping playlist ${playlistId}: Spotify returned ${fetchTracksResponse.status}. Body => ${JSON.stringify(playlistResponseBody)}`);
        failedPlaylists.push({ playlistId: playlistId, status: fetchTracksResponse.status });
        return { tracks: [], playlistTitle: "" };
    }
    const playlistTitle = playlistResponseBody.name;

    let playlistTracks = playlistResponseBody.tracks;
    let items = playlistTracks.items;
    // Filter array by added_at < 24hours and push results into newTracksArray with the aid of the spread operator
    newTracksArray.push(...(items.filter(item => isTimeWithin24Hours(item.added_at) )));
    while (playlistTracks.next && playlistTracks.next !== null) {
        console.log('Going through paginated urls');
        const paginatedResponse = await fetch(playlistTracks.next, getPlaylistRequestConfig);
        // On pagination errors, stop paginating and keep whatever tracks we already collected
        if (paginatedResponse.status !== 200) {
            console.log(`Pagination for playlist ${playlistId} failed with ${paginatedResponse.status}; continuing with ${newTracksArray.length} tracks collected so far`);
            failedPlaylists.push({ playlistId: playlistId, status: paginatedResponse.status });
            break;
        }
        playlistTracks = await paginatedResponse.json();
        items = playlistTracks.items;
        newTracksArray.push(...(items.filter(item => isTimeWithin24Hours(item.added_at) )));
    }

    // If spotify reloads 100% of their playlist, just ignore and return no tracks.
    if (playlistResponseBody.tracks.total === newTracksArray.length && playlistResponseBody.owner.display_name === "Spotify") {
        console.log(`All tracks in playlist ${playlistId} is reloaded; weird spotify reload`);
        return { tracks: [], playlistTitle };
    }

    console.log(`Leaving getTracksAddedInTheLast24Hour. Array => ${JSON.stringify(newTracksArray)}`);
    return { tracks: newTracksArray, playlistTitle };
}

// TODO: Use Batch write Item eventually?
/**
 * Writes a newly discovered track to the SongTrackMapper table with a 24-hour TTL.
 *
 * @param {Object} trackItem - Spotify playlist track item (contains .track details).
 * @param {string} playlistId - Spotify playlist ID the track belongs to.
 * @param {string} playlistTitle - Playlist title (already fetched with the tracks).
 * @returns {Promise<void>}
 * Side effects: one DynamoDB put.
 */
async function addTrackToDynamo(trackItem, playlistId, playlistTitle) {
    console.log(`In Add track to Dynamo`);
    // generate uuid for track and add to current playlist on WatchedPlaylists table
    // push song info with uuid
    const trackUUID = crypto.randomUUID();
    const now = new Date();
    const twentyFourHoursLater = Date.parse(new Date(now.setHours(now.getHours() + 24))) / 1000;
    const timeInUTC = now.toISOString();

    console.log(`TrackItem => ${JSON.stringify(trackItem)}`);

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
            playlistTitle: playlistTitle
        },
    };
    console.log(`About to add song uuid to Song Tracker Table`);
    await documentClient.send(new PutCommand(dynamoTrackPutParams));
}

/**
 * Sends an APN push notification (via the notification service endpoint) to every
 * device whose preferredNotificationTime matches the current UTC hour and whose
 * watched playlists have at least one new track.
 *
 * @returns {Promise<void>}
 * Side effects: DynamoDB queries and HTTP POSTs to the notification endpoint.
 * Errors are caught and logged — notification failures shouldn't fail the cron run.
 */
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
        const dynamoResponse = await documentClient.send(new QueryCommand(dynamoQueryParam));
        const devices = dynamoResponse.Items;
        // TODO: Speed this up, do each device in parallel
        for (const currentDevice of devices) {
            if (currentDevice.watchedPlaylists) {
                // SDK v3 returns DynamoDB string sets as native JS Sets, so convert to array
                const playlistIdArray = Array.from(currentDevice.watchedPlaylists);
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

/**
 * Checks whether at least one of the given playlists has a new track recorded
 * in the SongTrackMapper table.
 *
 * @param {string[]} playlistArray - Spotify playlist IDs to check.
 * @returns {Promise<boolean>} True as soon as any playlist has at least one new track.
 */
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
        const trackResponse = await documentClient.send(new QueryCommand(songTrackerTableQueryParam));

        if (trackResponse && trackResponse.Items && trackResponse.Items.length > 0) {
            return true;
        }
    }
    console.log(`Returning false on playlistArray ${playlistArray} in doesAtLeastOnePlaylistHaveNewTrack`);
    return false;
}

/**
 * Gets the new tracks of a playlist from the SongTrackMapper table (following
 * pagination) and maps them into the track shape the iOS app expects.
 *
 * @param {string} playlistId - Spotify playlist ID.
 * @returns {Promise<Object[]>} De-duplicated track objects; [] if the query fails.
 */
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
            trackResponse = await documentClient.send(new QueryCommand(songTrackerTableQueryParam));
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

/**
 * Removes duplicate tracks (same trackId) from a getNewTracks response.
 *
 * @param {Object[]} trackArray - Track objects that may contain duplicates.
 * @returns {Object[]} Tracks with duplicates removed, original order preserved.
 */
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

/**
 * Processes a single watched playlist for the cron run: fetches its tracks added in
 * the last 24 hours from Spotify, and writes the ones not already recorded to the
 * SongTrackMapper table.
 *
 * Safe to run in parallel with other playlists — all state is local. Any unexpected
 * exception is caught and recorded in failedPlaylists so one playlist can't fail a
 * whole batch.
 *
 * @param {string} playlistId - Spotify playlist ID.
 * @param {string} spotifyToken - Spotify API access token.
 * @returns {Promise<void>}
 * Side effects: Spotify API calls, DynamoDB query + puts.
 */
async function processPlaylist(playlistId, spotifyToken) {
    try {
        console.log(`========>${playlistId}<========`);
        const songTrackerTableQueryParam = {
            TableName: songTrackerTableName,
            IndexName: "playlistId-index",
            KeyConditionExpression: "playlistId = :playlistId",
            ExpressionAttributeValues: {
                ":playlistId": playlistId
            }
        };
        const [{ tracks, playlistTitle }, songQueryResponse] = await Promise.all([
            getTracksAddedInTheLast24Hours(playlistId, spotifyToken),
            documentClient.send(new QueryCommand(songTrackerTableQueryParam))
        ]);
        const queriedSongs = songQueryResponse.Items ?? [];
        for (const trackItem of tracks) {
            if (trackItem.track) {
                // Check if current track is in queried tracks from dynamo
                const getTrackFromPlaylistFilter = queriedSongs.filter(currentSong => currentSong.trackId === trackItem.track.id);
                if (getTrackFromPlaylistFilter.length === 0) {
                    console.log(`Adding track to dynamo ${JSON.stringify(trackItem)}`);
                    await addTrackToDynamo(trackItem, playlistId, playlistTitle);
                } else {
                    console.log(`Track ${trackItem.track.id} already tied to playlist ${playlistId}`);
                }
            }
        }
    } catch (e) {
        console.log(`Error processing playlist ${playlistId} => ${e.stack}`);
        failedPlaylists.push({ playlistId: playlistId, status: "exception" });
    }
}

/**
 * Lambda entry point. Serves two purposes:
 * - API Gateway GET /tracks/new: returns new tracks for the requesting device's watched playlists.
 * - EventBridge hourly cron (any other event): refreshes the SongTrackMapper table from
 *   Spotify and sends push notifications for the current UTC hour.
 *
 * @param {Object} event - API Gateway proxy event or EventBridge scheduled event.
 * @returns {Promise<Object>} API Gateway-style response object.
 * @throws Rethrows fatal errors (S3 read failure, Spotify token failure) so the
 *   invocation is marked as failed in CloudWatch.
 */
exports.handler = async (event) => {
    console.log(`Top of event`);
    // Set variables based on environment
    environmentFromStageVariable = event.stageVariables;
    // Reset per-run state since module scope persists across warm invocations
    failedPlaylists = [];

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
            const data = await documentClient.send(new GetCommand(getParams));
            const device = data.Item;
            if (!device.watchedPlaylists) {
                response.statusCode = 404; // Returning not found if there are no watched Playlists. Basically a hack and easier for the front end to parse
            } else {
                response.statusCode = 200;
                // SDK v3 returns DynamoDB string sets as native JS Sets, so convert to array
                const playlistIdArray = Array.from(device.watchedPlaylists);
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

        // TODO:Find best way to handle expired tokens. Handle 401 issues.
        const spotifyToken = await fetchSpotifyToken();
        // Process playlists in parallel batches; batches run sequentially to keep the
        // Spotify request rate modest and avoid 429 rate limiting
        const BATCH_SIZE = 10;
        for (let i = 0; i < playlists.length; i += BATCH_SIZE) {
            const batch = playlists.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(playlistId => processPlaylist(playlistId, spotifyToken)));
        }

        // Surface playlists Spotify errored on so stale/blocked ones are easy to spot in CloudWatch
        if (failedPlaylists.length > 0) {
            console.log(`Failed playlists this run: ${JSON.stringify(failedPlaylists)}`);
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
