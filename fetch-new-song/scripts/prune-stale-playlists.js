// One-off maintenance script: prunes playlists that are only watched by dead devices.
//
// A device is considered alive if its NotificationTracker record was modified on or
// after the cutoff (2025-01-01). Playlists watched by no living device are removed from
// playlists.json (S3) and the WatchedPlaylists table; watchCount is reset to the number
// of living devices watching each kept playlist. NotificationTracker is never modified.
//
// Usage (from the fetch-new-song directory, so @aws-sdk resolves from node_modules):
//   node scripts/prune-stale-playlists.js           # dry run: prints the diff, writes nothing
//   node scripts/prune-stale-playlists.js --apply   # backs up playlists.json to S3, then writes
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const DEVICE_ALIVE_CUTOFF = "2025-01-01";
const NOTIFICATION_TRACKER_TABLE = "NotificationTracker";
const WATCHED_PLAYLISTS_TABLE = "WatchedPlaylists";
const RESOURCE_BUCKET = "song-updater-resources";
const PLAYLIST_FILE_KEY = "playlists.json";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const s3 = new S3Client({ region: 'us-east-1' });

/**
 * Scans NotificationTracker and counts, per playlist, how many living devices watch it.
 * A device counts if lastModifiedTimestamp >= DEVICE_ALIVE_CUTOFF and it has a
 * watchedPlaylists set (returned by SDK v3 as a native JS Set).
 *
 * @returns {Promise<Map<string, number>>} playlistId -> number of living devices watching it.
 */
async function getActivePlaylistCounts() {
    const counts = new Map();
    let lastEvaluatedKey;
    let deviceCount = 0;
    let livingDeviceCount = 0;
    do {
        const scanResponse = await documentClient.send(new ScanCommand({
            TableName: NOTIFICATION_TRACKER_TABLE,
            ExclusiveStartKey: lastEvaluatedKey
        }));
        for (const device of scanResponse.Items) {
            deviceCount++;
            const lastModified = device.lastModifiedTimestamp || "";
            if (lastModified >= DEVICE_ALIVE_CUTOFF && device.watchedPlaylists) {
                livingDeviceCount++;
                for (const playlistId of device.watchedPlaylists) {
                    counts.set(playlistId, (counts.get(playlistId) || 0) + 1);
                }
            }
        }
        lastEvaluatedKey = scanResponse.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    console.log(`Scanned ${deviceCount} devices; ${livingDeviceCount} living (>= ${DEVICE_ALIVE_CUTOFF}) with watch lists`);
    return counts;
}

/**
 * Reads the current playlists.json dictionary from S3.
 *
 * @returns {Promise<Object>} The parsed playlistId -> watchCount dictionary.
 */
async function getCurrentPlaylistFile() {
    const data = await s3.send(new GetObjectCommand({ Bucket: RESOURCE_BUCKET, Key: PLAYLIST_FILE_KEY }));
    return JSON.parse(await data.Body.transformToString());
}

async function main() {
    const apply = process.argv.includes("--apply");

    const activeCounts = await getActivePlaylistCounts();
    const currentFile = await getCurrentPlaylistFile();
    const currentIds = new Set(Object.keys(currentFile));

    const keep = [...activeCounts.keys()].filter(id => currentIds.has(id));
    const add = [...activeCounts.keys()].filter(id => !currentIds.has(id));
    const prune = [...currentIds].filter(id => !activeCounts.has(id));

    console.log(`\nplaylists.json currently has ${currentIds.size} playlists`);
    console.log(`keep:  ${keep.length}`);
    console.log(`add:   ${add.length} (watched by a living device but missing from the file): ${JSON.stringify(add)}`);
    console.log(`prune: ${prune.length}`);
    console.log(`\nNew playlists.json will have ${activeCounts.size} playlists:`);
    console.log(JSON.stringify(Object.fromEntries(activeCounts), null, 2));

    if (!apply) {
        console.log("\nDRY RUN — nothing written. Re-run with --apply to make changes.");
        return;
    }

    // 1. Back up the current file so the prune is reversible
    const backupKey = `playlists-backup-${new Date().toISOString().slice(0, 10)}.json`;
    await s3.send(new PutObjectCommand({
        Bucket: RESOURCE_BUCKET,
        Key: backupKey,
        Body: JSON.stringify(currentFile),
        ContentType: "application/json"
    }));
    console.log(`\nBacked up current file to s3://${RESOURCE_BUCKET}/${backupKey}`);

    // 2. Write the pruned playlists.json
    await s3.send(new PutObjectCommand({
        Bucket: RESOURCE_BUCKET,
        Key: PLAYLIST_FILE_KEY,
        Body: JSON.stringify(Object.fromEntries(activeCounts)),
        ContentType: "application/json"
    }));
    console.log(`Wrote pruned s3://${RESOURCE_BUCKET}/${PLAYLIST_FILE_KEY} (${activeCounts.size} playlists)`);

    // 3. Reconcile the WatchedPlaylists table with the same active set so
    //    playlist-table-handler's reference counting stays consistent
    const timeInUTC = new Date().toISOString();
    for (const [playlistId, watchCount] of activeCounts) {
        await documentClient.send(new PutCommand({
            TableName: WATCHED_PLAYLISTS_TABLE,
            Item: { playlistId, watchCount, lastModifiedTimestamp: timeInUTC }
        }));
    }
    console.log(`Upserted ${activeCounts.size} rows in ${WATCHED_PLAYLISTS_TABLE} with recomputed watchCounts`);

    let deleted = 0;
    let lastEvaluatedKey;
    do {
        const scanResponse = await documentClient.send(new ScanCommand({
            TableName: WATCHED_PLAYLISTS_TABLE,
            ProjectionExpression: "playlistId",
            ExclusiveStartKey: lastEvaluatedKey
        }));
        for (const item of scanResponse.Items) {
            if (!activeCounts.has(item.playlistId)) {
                await documentClient.send(new DeleteCommand({
                    TableName: WATCHED_PLAYLISTS_TABLE,
                    Key: { playlistId: item.playlistId }
                }));
                deleted++;
            }
        }
        lastEvaluatedKey = scanResponse.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    console.log(`Deleted ${deleted} stale rows from ${WATCHED_PLAYLISTS_TABLE}`);
    console.log("\nDone.");
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
