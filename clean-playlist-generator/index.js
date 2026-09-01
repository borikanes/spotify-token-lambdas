const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const crypto = require('node:crypto');

var cleanTrackMapperTableName = process.env.CLEAN_TRACK_MAPPER_TABLE ? process.env.CLEAN_TRACK_MAPPER_TABLE : "CleanTrackMapper";
var cleanPlaylistJobsTableName = process.env.CLEAN_PLAYLIST_JOBS_TABLE ? process.env.CLEAN_PLAYLIST_JOBS_TABLE : "CleanPlaylistJobs";
var notificationTrackerTableName = process.env.NOTIFICATION_TRACKER_TABLE ? process.env.NOTIFICATION_TRACKER_TABLE : "NotificationTracker";
var environmentFromStageVariable = {};

const spotifyBaseURL = "https://api.spotify.com/v1";
const ADD_TRACKS_BATCH_SIZE = 100; // Spotify's hard limit per add-tracks call

const documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: 'us-east-1' }),
    { marshallOptions: { removeUndefinedValues: true } }
);
const lambdaClient = new LambdaClient({ region: 'us-east-1' });

/**
 * Fetches a Spotify API access token using the client credentials flow.
 * Client credentials (not user OAuth) means the token can only read public
 * catalog data — used here for reading playlist tracks and running searches,
 * neither of which needs a specific user's identity.
 *
 * @returns {Promise<string>} A Spotify access token.
 * @throws {Error} If Spotify rejects the request or returns no token.
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
 * Fetches every track in a playlist (following pagination) using a client-credentials
 * token, so the source playlist must be publicly readable.
 *
 * @param {string} playlistId - Spotify playlist ID.
 * @param {string} clientToken - Client-credentials Spotify access token.
 * @returns {Promise<{tracks: Object[], playlistTitle: string}>} All playlist track items and the playlist's title.
 * @throws {Error} If Spotify returns a non-200 for the playlist or any pagination page.
 */
async function getAllPlaylistTracks(playlistId, clientToken) {
    const headers = { Authorization: `Bearer ${clientToken}` };
    const res = await fetch(`${spotifyBaseURL}/playlists/${playlistId}`, { headers });
    const body = await res.json();
    if (res.status !== 200) {
        throw new Error(`Failed to fetch playlist ${playlistId}. Status ${res.status}. Body => ${JSON.stringify(body)}`);
    }

    const playlistTitle = body.name;
    let tracksPage = body.tracks;
    const items = [...tracksPage.items];

    while (tracksPage.next) {
        const pageRes = await fetch(tracksPage.next, { headers });
        if (pageRes.status !== 200) {
            throw new Error(`Pagination failed for playlist ${playlistId}. Status ${pageRes.status}`);
        }
        tracksPage = await pageRes.json();
        items.push(...tracksPage.items);
    }

    return { tracks: items, playlistTitle };
}

/**
 * Searches Spotify's catalog for a non-explicit version of a track, requiring an
 * exact (case-insensitive) name and primary-artist match to avoid false positives
 * like unrelated remixes or covers surfacing under the same title.
 *
 * This is a first-pass heuristic — there is no Spotify API concept linking an
 * explicit track to its clean edit, so exact name/artist match is the best signal
 * available short of manual curation.
 *
 * @param {Object} track - Spotify track object (from a playlist item) to find a clean version of.
 * @param {string} clientToken - Client-credentials Spotify access token.
 * @returns {Promise<{searched: boolean, match: Object|null}>} `searched` is false when
 *   the request itself failed (rate limit, expired token, 5xx). Callers MUST NOT treat
 *   that as "no clean version exists" — the distinction is what keeps a transient
 *   Spotify error from being cached as a permanent negative.
 */
async function searchForCleanVersion(track, clientToken) {
    const primaryArtist = track.artists && track.artists[0] ? track.artists[0].name : '';
    const query = `track:${track.name} artist:${primaryArtist}`;
    const url = `${spotifyBaseURL}/search?type=track&limit=10&q=${encodeURIComponent(query)}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${clientToken}` } });
    if (res.status !== 200) {
        console.log(`Search FAILED (not a miss) for track ${track.id} with status ${res.status}`);
        return { searched: false, match: null };
    }
    const data = await res.json();
    const items = (data.tracks && data.tracks.items) || [];
    const normalizedArtist = primaryArtist.toLowerCase();
    const normalizedName = track.name.toLowerCase();

    const match = items.find(candidate =>
        candidate.explicit === false &&
        candidate.name.toLowerCase() === normalizedName &&
        candidate.artists.some(a => a.name.toLowerCase() === normalizedArtist)
    ) || null;
    return { searched: true, match };
}

/**
 * Resolves the clean-version URI for an explicit track, using the CleanTrackMapper
 * table as a shared, permanent cache across all users/playlists so the same track
 * is never searched twice — a Spotify track ID is stable, so a cached match (or a
 * cached "no clean version exists" result) is valid indefinitely.
 *
 * @param {Object} track - Spotify track object known to be explicit.
 * @param {string} clientToken - Client-credentials Spotify access token.
 * @returns {Promise<string|null>} The clean track's URI, or null if none exists.
 * Side effects: one DynamoDB get, and on a cache miss one DynamoDB put recording the result either way.
 */
async function resolveCleanTrackUri(track, clientToken) {
    const cached = await documentClient.send(new GetCommand({
        TableName: cleanTrackMapperTableName,
        Key: { explicitTrackId: track.id }
    }));

    if (cached.Item) {
        return cached.Item.status === 'no_clean_version' ? null : cached.Item.cleanTrackUri;
    }

    const { searched, match } = await searchForCleanVersion(track, clientToken);

    // A failed request is NOT evidence that no clean version exists. Caching it as
    // one would poison this shared, TTL-less table permanently for every user, so
    // leave the track unresolved and let a later run settle it.
    if (!searched) {
        return null;
    }

    const now = new Date().toISOString();

    await documentClient.send(new PutCommand({
        TableName: cleanTrackMapperTableName,
        Item: {
            explicitTrackId: track.id,
            cleanTrackId: match ? match.id : null,
            cleanTrackUri: match ? match.uri : null,
            status: match ? 'matched' : 'no_clean_version',
            matchMethod: match ? 'search_exact_name_artist' : null,
            resolvedAt: now
        }
    }));

    return match ? match.uri : null;
}

/**
 * Fetches the Spotify user ID for the account that owns the given access token.
 * Needed because playlist creation is scoped under /users/{user_id}/playlists.
 *
 * @param {string} userAccessToken - User-authorized Spotify access token.
 * @returns {Promise<string>} The Spotify user ID.
 * @throws {Error} If Spotify rejects the request (e.g. expired token).
 */
async function getSpotifyUserId(userAccessToken) {
    const res = await fetch(`${spotifyBaseURL}/me`, { headers: { Authorization: `Bearer ${userAccessToken}` } });
    const data = await res.json();
    if (res.status !== 200) {
        throw new Error(`Failed to fetch Spotify profile. Status ${res.status}. Body => ${JSON.stringify(data)}`);
    }
    return data.id;
}

/**
 * Creates a new playlist owned by the given Spotify user.
 *
 * @param {string} userAccessToken - User-authorized Spotify access token (needs playlist-modify scope).
 * @param {string} spotifyUserId - Spotify user ID to own the new playlist.
 * @param {string} name - Playlist name.
 * @param {boolean} isPublic - Whether the playlist should be public.
 * @returns {Promise<string>} The new playlist's Spotify ID.
 * @throws {Error} If Spotify rejects the creation request.
 */
async function createPlaylist(userAccessToken, spotifyUserId, name, isPublic) {
    const res = await fetch(`${spotifyBaseURL}/users/${spotifyUserId}/playlists`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${userAccessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name, public: isPublic })
    });
    const data = await res.json();
    if (res.status !== 201) {
        throw new Error(`Failed to create playlist. Status ${res.status}. Body => ${JSON.stringify(data)}`);
    }
    return data.id;
}

/**
 * Adds tracks to a playlist, batching at Spotify's 100-URIs-per-request limit.
 *
 * @param {string} userAccessToken - User-authorized Spotify access token.
 * @param {string} playlistId - Spotify ID of the playlist to add tracks to.
 * @param {string[]} uris - Track URIs to add, in order.
 * @returns {Promise<void>}
 * @throws {Error} If any batch request fails.
 */
async function addTracksToPlaylist(userAccessToken, playlistId, uris) {
    for (let i = 0; i < uris.length; i += ADD_TRACKS_BATCH_SIZE) {
        const batch = uris.slice(i, i + ADD_TRACKS_BATCH_SIZE);
        const res = await fetch(`${spotifyBaseURL}/playlists/${playlistId}/tracks`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${userAccessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ uris: batch })
        });
        if (res.status !== 201) {
            const data = await res.json();
            throw new Error(`Failed to add tracks to playlist ${playlistId}. Status ${res.status}. Body => ${JSON.stringify(data)}`);
        }
    }
}

/**
 * Creates the initial job record for a clean-playlist request.
 *
 * @param {string} jobId - Newly generated job ID.
 * @param {string} playlistId - Source Spotify playlist ID.
 * @param {string|undefined} deviceId - Requesting device's ID, for the completion push.
 * @param {boolean} isPublic - Whether the client asked for a public playlist.
 * @returns {Promise<void>}
 */
async function createJobRecord(jobId, playlistId, deviceId, isPublic) {
    await documentClient.send(new PutCommand({
        TableName: cleanPlaylistJobsTableName,
        Item: {
            jobId,
            status: 'pending',
            sourcePlaylistId: playlistId,
            deviceId: deviceId || null,
            // Recorded so a job's public/private outcome can be traced back to what
            // the client actually requested
            isPublic: !!isPublic,
            createdAt: new Date().toISOString()
        }
    }));
}

/**
 * Updates a job record's status and merges in any additional attributes.
 *
 * @param {string} jobId - Job ID to update.
 * @param {string} status - New status (pending/processing/complete/error).
 * @param {Object} [extra] - Additional attributes to set (e.g. newPlaylistId, tracksAdded).
 * @returns {Promise<void>}
 */
async function updateJobStatus(jobId, status, extra = {}) {
    const updateExpressionParts = ['#status = :status', 'updatedAt = :updatedAt'];
    const expressionAttributeNames = { '#status': 'status' };
    const expressionAttributeValues = { ':status': status, ':updatedAt': new Date().toISOString() };

    // Alias every dynamic key through ExpressionAttributeNames (not just #status) —
    // extra can include values like "error", which is itself a DynamoDB reserved word.
    for (const [key, value] of Object.entries(extra)) {
        const nameAlias = `#${key}`;
        updateExpressionParts.push(`${nameAlias} = :${key}`);
        expressionAttributeNames[nameAlias] = key;
        expressionAttributeValues[`:${key}`] = value;
    }

    await documentClient.send(new UpdateCommand({
        TableName: cleanPlaylistJobsTableName,
        Key: { jobId },
        UpdateExpression: `set ${updateExpressionParts.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
    }));
}

/**
 * Sends an APN push notification (via the existing notification service) letting
 * the requesting device know its clean playlist is ready. Mirrors the completion
 * pattern fetch-new-song uses for new-track notifications, but fires immediately
 * for a single device rather than on an hourly schedule.
 *
 * @param {string|undefined} deviceId - Device to notify; no-op if missing.
 * @param {string} playlistName - Name of the newly created playlist.
 * @param {number} trackCount - Number of tracks added.
 * @param {number} skippedCount - Number of explicit tracks skipped (no clean version found).
 * @param {string} newPlaylistId - Spotify ID of the new playlist, passed through the push so
 *   the app can deep link to it directly.
 * @returns {Promise<void>}
 * Errors are caught and logged — a failed notification shouldn't fail the job, which has already succeeded.
 */
async function sendJobCompletionNotification(deviceId, playlistName, trackCount, skippedCount, newPlaylistId) {
    if (!deviceId) {
        return;
    }
    try {
        const deviceResult = await documentClient.send(new GetCommand({
            TableName: notificationTrackerTableName,
            Key: { deviceId }
        }));
        const device = deviceResult.Item;
        if (!device || !device.deviceToken) {
            console.log(`No device token found for deviceId ${deviceId}; skipping completion push`);
            return;
        }

        const isQA = environmentFromStageVariable && environmentFromStageVariable.environment === 'qa';
        const skippedNote = skippedCount > 0 ? ` (${skippedCount} skipped — no clean version found)` : '';
        const apnPayload = {
            message: `Your clean playlist "${playlistName}" is ready with ${trackCount} songs${skippedNote}.`,
            deviceToken: device.deviceToken,
            bundleID: isQA ? "me.borikanes.SongUpdaterQA" : "me.borikanes.SongUpdater",
            // Without these the app can't tell this apart from a new-song push and
            // would wrongly badge the New Songs tab (see AppDelegate handling)
            notificationType: "cleanPlaylistReady",
            playlistId: newPlaylistId
        };

        const res = await fetch(`https://ho7won2i0j.execute-api.us-east-1.amazonaws.com/${isQA ? "QA" : "prod"}/send-notifications`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(apnPayload)
        });
        const data = await res.json();
        if (data.statusCode !== 200) {
            console.log(`Completion notification not sent for deviceId ${deviceId}. Got ${res.status}`);
        }
    } catch (e) {
        console.log(`Error sending completion notification => ${e.stack}`);
    }
}

/**
 * Asynchronously invokes this same Lambda function to run the actual clean-playlist
 * work in the background, so the API Gateway-facing request can return immediately
 * instead of blocking on however many Search API calls the playlist needs.
 *
 * @param {Object} payload - Worker event payload (see processCleanJob for shape).
 * @param {string} functionName - This function's own name, to self-invoke.
 * @returns {Promise<void>}
 */
async function invokeWorkerAsync(payload, functionName) {
    await lambdaClient.send(new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload))
    }));
}

/**
 * Handles POST /playlists/clean: validates the request, creates the job record,
 * and kicks off async processing. Returns immediately with the job ID.
 *
 * @param {Object} event - API Gateway proxy event.
 * @param {Object} context - Lambda context (used to get this function's own name for self-invoke).
 * @returns {Promise<Object>} API Gateway-style response: 202 + jobId on success, 400 on missing input.
 */
async function handleStartCleanJob(event, context) {
    const body = JSON.parse(event.body || '{}');
    const playlistId = body.playlistId;
    const isPublic = !!body.isPublic;
    const playlistName = body.playlistName;
    const headers = event.headers || {};
    // deviceId comes from the body because the iOS app's shared networking helper
    // only forwards a device-id header on GET calls, not POSTs; the header is still
    // accepted as a fallback for non-app callers (curl, tests).
    const deviceId = body.deviceId || headers['device-id'];
    const authHeader = headers['Authorization'] || headers['authorization'];

    if (!playlistId || !authHeader) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Missing playlistId or Authorization header' }),
            headers: { 'Content-Type': 'application/json' }
        };
    }

    const userAccessToken = authHeader.replace(/^Bearer\s+/i, '');
    const jobId = crypto.randomUUID();

    console.log(`Starting clean job ${jobId} for playlist ${playlistId} (isPublic=${isPublic}, deviceId=${deviceId})`);
    await createJobRecord(jobId, playlistId, deviceId, isPublic);
    await invokeWorkerAsync({
        action: 'processCleanJob',
        jobId,
        playlistId,
        isPublic,
        playlistName,
        deviceId,
        userAccessToken,
        // Threaded through explicitly: stageVariables only exist on the API
        // Gateway invocation, so the async self-invoke would otherwise default
        // to prod and send the completion push to the wrong APNs environment
        environment: environmentFromStageVariable.environment
    }, context.functionName);

    return {
        statusCode: 202,
        body: JSON.stringify({ jobId }),
        headers: { 'Content-Type': 'application/json' }
    };
}

/**
 * Handles GET /playlists/clean-jobs in two modes:
 * - `?jobId=...` returns one job — the polling fallback for clients that don't
 *   receive (or have disabled) the completion push notification.
 * - a `device-id` header with no jobId returns that device's completed jobs,
 *   newest first, backing the app's "Clean" playlist list.
 *
 * @param {Object} event - API Gateway proxy event.
 * @returns {Promise<Object>} API Gateway-style response: 200 + job record or job array,
 *   404 if a requested job isn't found, 400 if neither jobId nor device-id was supplied.
 */
async function handleGetJobStatus(event) {
    const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
    const deviceId = (event.headers || {})['device-id'];

    if (!jobId && deviceId) {
        return await listJobsForDevice(deviceId);
    }

    if (!jobId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Missing jobId query parameter or device-id header' }),
            headers: { 'Content-Type': 'application/json' }
        };
    }

    const result = await documentClient.send(new GetCommand({ TableName: cleanPlaylistJobsTableName, Key: { jobId } }));
    if (!result.Item) {
        return {
            statusCode: 404,
            body: JSON.stringify({ message: 'Job not found' }),
            headers: { 'Content-Type': 'application/json' }
        };
    }

    return {
        statusCode: 200,
        body: JSON.stringify(result.Item),
        headers: { 'Content-Type': 'application/json' }
    };
}

/**
 * Lists the clean playlists a device has successfully generated, newest first.
 *
 * Only `complete` jobs are returned — failed/in-flight jobs have no playlist to
 * show and would just be noise in the list.
 *
 * @param {string} deviceId - Requesting device's ID.
 * @returns {Promise<Object>} API Gateway-style 200 with an array of
 *   `{ jobId, newPlaylistId, newPlaylistName, tracksAdded, tracksSkipped, isPublic, createdAt }`.
 */
async function listJobsForDevice(deviceId) {
    // ScanIndexForward:false gives newest-first straight from the index, since the
    // GSI's range key is createdAt.
    // Paginated because FilterExpression is applied AFTER the 1MB read limit: a
    // device with many failed jobs could otherwise have its completed ones split
    // across pages and silently truncated.
    const queryParams = {
        TableName: cleanPlaylistJobsTableName,
        IndexName: 'deviceId-index',
        KeyConditionExpression: 'deviceId = :deviceId',
        FilterExpression: '#status = :complete',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':deviceId': deviceId, ':complete': 'complete' },
        ScanIndexForward: false
    };
    const items = [];
    let result;
    do {
        result = await documentClient.send(new QueryCommand(queryParams));
        items.push(...(result.Items || []));
        queryParams.ExclusiveStartKey = result.LastEvaluatedKey;
    } while (result.LastEvaluatedKey);

    const jobs = items.map(item => ({
        jobId: item.jobId,
        newPlaylistId: item.newPlaylistId,
        newPlaylistName: item.newPlaylistName,
        // Absent on jobs created before source names were recorded — the app
        // renders the origin line only when it's present
        sourcePlaylistName: item.sourcePlaylistName,
        sourcePlaylistId: item.sourcePlaylistId,
        tracksAdded: item.tracksAdded,
        tracksSkipped: item.tracksSkipped,
        isPublic: item.isPublic,
        createdAt: item.createdAt
    }));

    return {
        statusCode: 200,
        body: JSON.stringify(jobs),
        headers: { 'Content-Type': 'application/json' }
    };
}

/**
 * Handles DELETE /playlists/clean-jobs?jobId=... — forgets a generated playlist.
 *
 * Called after the app has unfollowed the playlist on Spotify, so the list only
 * ever shows playlists the user still has. Deleting the record does NOT touch
 * Spotify; the client owns that half (it holds the user token).
 *
 * @param {Object} event - API Gateway proxy event.
 * @returns {Promise<Object>} API Gateway-style 200 on success, 400 without a jobId.
 */
async function handleDeleteJob(event) {
    const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
    if (!jobId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Missing jobId query parameter' }),
            headers: { 'Content-Type': 'application/json' }
        };
    }

    await documentClient.send(new DeleteCommand({
        TableName: cleanPlaylistJobsTableName,
        Key: { jobId }
    }));
    console.log(`Deleted clean job record ${jobId}`);

    return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Deleted' }),
        headers: { 'Content-Type': 'application/json' }
    };
}

/**
 * The actual clean-playlist work, run via async self-invocation so it's not bound
 * by API Gateway's ~29s timeout. Reads the source playlist, resolves a clean URI
 * for every explicit track (via the shared CleanTrackMapper cache, falling back to
 * search on a miss), creates the new playlist under the requesting user, adds the
 * resulting tracks, and notifies the device when done.
 *
 * Only the final playlist-create/add-tracks calls use the user's access token —
 * every read/search call uses a separately fetched client-credentials token, so
 * job duration isn't bounded by the user's token lifetime.
 *
 * @param {Object} jobEvent - Worker payload from handleStartCleanJob: { jobId, playlistId, isPublic, playlistName, deviceId, userAccessToken }.
 * @returns {Promise<void>}
 * Side effects: Spotify API calls, DynamoDB job/cache writes, and (on success) a push notification.
 * Errors are caught and recorded on the job record rather than thrown, since nothing is waiting on this invocation's return value.
 */
async function processCleanJob(jobEvent) {
    const { jobId, playlistId, isPublic, playlistName, deviceId, userAccessToken } = jobEvent;
    try {
        await updateJobStatus(jobId, 'processing');

        const clientToken = await fetchSpotifyToken();
        const { tracks, playlistTitle } = await getAllPlaylistTracks(playlistId, clientToken);
        // Source titles often carry trailing whitespace, which would render as
        // "Name  (Clean)" with a double space. Capped because Spotify rejects
        // playlist names over 100 characters — a long source title plus the
        // " (Clean)" suffix can cross that on its own.
        const SPOTIFY_MAX_PLAYLIST_NAME = 100;
        const finalName = (playlistName || `${(playlistTitle || '').trim()} (Clean)`)
            .slice(0, SPOTIFY_MAX_PLAYLIST_NAME);

        let skippedCount = 0;
        // Counted so a playlist that needed no cleaning can be reported as such,
        // rather than silently handing the user an identical copy to manage.
        let explicitCount = 0;
        const finalUris = [];
        // Source playlists frequently contain the same track more than once, and two
        // different explicit tracks can also resolve to the same clean recording.
        // Either way the generated playlist shouldn't list a song twice.
        const seenUris = new Set();
        let duplicateCount = 0;

        const addUri = (uri) => {
            if (seenUris.has(uri)) {
                duplicateCount += 1;
                return;
            }
            seenUris.add(uri);
            finalUris.push(uri);
        };

        for (const item of tracks) {
            const track = item.track;
            if (!track) {
                continue;
            }
            if (!track.explicit) {
                addUri(track.uri);
                continue;
            }
            explicitCount += 1;
            const cleanUri = await resolveCleanTrackUri(track, clientToken);
            if (cleanUri) {
                addUri(cleanUri);
            } else {
                skippedCount += 1;
            }
        }
        if (duplicateCount > 0) {
            console.log(`Job ${jobId}: dropped ${duplicateCount} duplicate track(s)`);
        }

        // Creating an empty playlist leaves the user litter to clean up, so report
        // it instead. The app maps this code to a plain-language explanation.
        if (finalUris.length === 0) {
            console.log(`Job ${jobId}: nothing to add (${skippedCount} skipped); not creating an empty playlist`);
            await updateJobStatus(jobId, 'error', { error: 'NO_CLEAN_VERSIONS' });
            return;
        }

        // Nothing was explicit, so the "clean" copy would be identical to the
        // source. Creating it would leave the user with a redundant playlist and
        // no indication of why, so report it instead. Checked after the empty
        // case above, which also has no explicit tracks when the source is empty.
        if (explicitCount === 0) {
            console.log(`Job ${jobId}: source has no explicit tracks; not creating a duplicate playlist`);
            await updateJobStatus(jobId, 'error', { error: 'ALREADY_CLEAN' });
            return;
        }

        const spotifyUserId = await getSpotifyUserId(userAccessToken);
        const newPlaylistId = await createPlaylist(userAccessToken, spotifyUserId, finalName, isPublic);
        if (finalUris.length > 0) {
            await addTracksToPlaylist(userAccessToken, newPlaylistId, finalUris);
        }

        await updateJobStatus(jobId, 'complete', {
            newPlaylistId,
            // Stored so the app's result screen can name the playlist without
            // having to re-fetch it from Spotify
            newPlaylistName: finalName,
            // The playlist this was cleaned FROM, so the list can show its origin
            // (only the source's id was recorded before, which isn't displayable)
            sourcePlaylistName: (playlistTitle || '').trim(),
            tracksAdded: finalUris.length,
            tracksSkipped: skippedCount
        });
        await sendJobCompletionNotification(deviceId, finalName, finalUris.length, skippedCount, newPlaylistId);
    } catch (e) {
        console.log(`Error processing clean job ${jobId} => ${e.stack}`);
        await updateJobStatus(jobId, 'error', { error: e.message });
    }
}

/**
 * Lambda entry point. Serves three purposes:
 * - API Gateway POST /playlists/clean: starts a clean-playlist job, returns 202 + jobId.
 * - API Gateway GET /playlists/clean-jobs: returns a job's current status.
 * - Async self-invocation (event.action === 'processCleanJob'): runs the actual job.
 *
 * @param {Object} event - API Gateway proxy event, or a self-invoked worker payload.
 * @param {Object} context - Lambda context.
 * @returns {Promise<Object|void>} API Gateway-style response for HTTP paths; nothing for the async worker path.
 */
// Exported for unit tests only — not part of the lambda's runtime contract.
// The AWS clients are exposed so tests can stub `send` and assert on the commands
// built for them without touching DynamoDB or invoking a real Lambda.
exports._test = {
    searchForCleanVersion,
    resolveCleanTrackUri,
    processCleanJob,
    documentClient,
    lambdaClient
};

exports.handler = async (event, context) => {
    environmentFromStageVariable = event.stageVariables || {};

    if (event.action === 'processCleanJob') {
        // Self-invoked events carry no stageVariables, so restore the environment
        // from the payload handleStartCleanJob threaded through
        environmentFromStageVariable = { environment: event.environment };
        await processCleanJob(event);
        return;
    }

    try {
        if (event.path === '/playlists/clean' && event.httpMethod === 'POST') {
            return await handleStartCleanJob(event, context);
        }

        if (event.path === '/playlists/clean-jobs' && event.httpMethod === 'GET') {
            return await handleGetJobStatus(event);
        }

        if (event.path === '/playlists/clean-jobs' && event.httpMethod === 'DELETE') {
            return await handleDeleteJob(event);
        }

        return {
            statusCode: 404,
            body: JSON.stringify({ message: 'Not found' }),
            headers: { 'Content-Type': 'application/json' }
        };
    } catch (e) {
        console.log(`Unhandled error in handler => ${e.stack}`);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Internal error' }),
            headers: { 'Content-Type': 'application/json' }
        };
    }
};
