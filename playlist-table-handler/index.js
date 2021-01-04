const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid'); // uuidv4()

// Dynamo config
AWS.config.update({region: 'us-east-1'});
const documentClient = new AWS.DynamoDB.DocumentClient();
// S3 config
const s3 = new AWS.S3();

var playlistTableName = "WatchedPlaylists";
var songTrackerTableName = "SongTrackMapper";
const resourceBucket = "song-updater-resources";
var playlistFileKey = "playlists.json";

function setGlobalVariables(stageVariables) {
    if (stageVariables && stageVariables.environment === 'qa') {
        console.log('===================== Setting QA environment =====================');
        playlistTableName = "WatchedPlaylistsQA";
        songTrackerTableName = "SongTrackMapperQA";
        playlistFileKey = "playlists-qa.json";

        return;
    }
}

async function removeItemFromArrayInS3(item) {
    try {
        const getParams = {
            Bucket: resourceBucket,
            Key: playlistFileKey,
        }
        const data = await s3.getObject(getParams).promise();
        const jsonString = data.Body.toString('utf-8');
        let playlistDictionary = JSON.parse(jsonString);
        if (!playlistDictionary.hasOwnProperty(item)) { // if playlist doesn't exist, yikes - shouldn't happen
            return;
        }
        // else
        if (playlistDictionary[item] <= 1) { // If there's only one instance of the current playlist to be removed....
            delete playlistDictionary[item];
        } else { // just subtract 1 from the count of playlist
            playlistDictionary[item] -= 1
        }

        const putParams = {
            Bucket: resourceBucket,
            Key: playlistFileKey,
            Body: JSON.stringify(playlistDictionary),
            ContentType: "application/json",
        }
        const s3Data = await s3.putObject(putParams).promise();
        console.log("Removed playlist");
        return;
    } catch (e) {
        console.log(`Unsuccessfully removed item ${item}. Error ${e.stack}`);
        throw e;
    }
}

async function addItemToPlaylistArrayInS3(playlistId) {
    try {
        // Add to S3
        const getParams = {
            Bucket: resourceBucket,
            Key: playlistFileKey,
        }
        const data = await s3.getObject(getParams).promise();
        const jsonString = data.Body.toString('utf-8');
        const playlistDictionary = JSON.parse(jsonString);

        if (playlistDictionary.hasOwnProperty(playlistId)) { // if playlist already exists
            playlistDictionary[playlistId] += 1
        } else {
            playlistDictionary[playlistId] = 1
        }

        const putParams = {
            Bucket: resourceBucket,
            Key: playlistFileKey,
            Body: JSON.stringify(playlistDictionary),
            ContentType: "application/json",
        }
        const s3Data = await s3.putObject(putParams).promise();
    } catch (e) {
        console.log(`Error adding playlist to json array in S3. Error => ${e.stack}`);
        throw e;
    }
}

exports.handler = async (event) => {
    // Set variables based on environment on
    console.log(JSON.stringify(event));
    console.log(JSON.stringify(event.stageVariables));
    setGlobalVariables(event.stageVariables);
    console.log(`TableName=======> ${playlistTableName}`);
    let playlistId;
    // if event is to add playlist
    if (event.path && event.path === "/playlists/add") {
        try {
            const body = JSON.parse(event.body);
            playlistId = body.playlistId; // TODO: Verify playlistId exists
            const timeInUTC = new Date().toISOString();

            // Add to Dynamo
            const dynamoPutParams = {
                TableName: playlistTableName,
                Item: {
                    playlistId: playlistId,
                    lastModifiedTimestamp: timeInUTC,
                    watchCount: 1
                },
                ConditionExpression: 'attribute_not_exists(playlistId)'
            }
            
            const dynamoResponse = await documentClient.put(dynamoPutParams).promise();

            await addItemToPlaylistArrayInS3(playlistId);
            return({
                statusCode: 200,
            });
        } catch (e) {
            if (e.name === 'ConditionalCheckFailedException') { // Playlist already exists, increment count
                console.log(`Playlist ID: ${playlistId} already exists`);
                // a try in a catch block, awkward, isn't it?
                try {
                    const counterUpdateParam = {
                        TableName: playlistTableName,
                        Key: {playlistId: playlistId},
                        UpdateExpression: 'set watchCount = watchCount + :increment',
                        ExpressionAttributeValues: {
                            ":increment": 1
                        }
                    }
                    const counterUpdateResponse = await documentClient.update(counterUpdateParam).promise();
                } catch (err) {
                    console.log(`Dynamo operation for counter failed with error => ${err}`);
                    return {
                        statusCode: 500
                    }
                }
            } else {
                console.log(`S3 or Dynamo operation failed with error => ${e}`);
                return {
                    statusCode: 500
                }
            }
        }
    } else if (event.path && event.path === "/playlists/remove"){
        // Remove playlist. This means that we track how many times a playlist is "watched". Like a counter or something
        try {
            const body = JSON.parse(event.body);
            playlistId = body.playlistId;
            const timeInUTC = new Date().toISOString();

            const dynamoGetParams = {
                TableName: playlistTableName,
                Key: {playlistId: playlistId}
            };

            const playlistItem = await documentClient.get(dynamoGetParams).promise();
            console.log(`Playlist ITEM ======> ${JSON.stringify(playlistItem)}`);
            const watchCount = playlistItem.Item.watchCount;
            if (watchCount) {
                if (watchCount > 1) { // update by decrementing by 1
                    const counterUpdateParam = {
                        TableName: playlistTableName,
                        Key: {playlistId: playlistId},
                        UpdateExpression: 'set watchCount = watchCount - :decrement',
                        ExpressionAttributeValues: {
                            ":decrement": 1
                        }
                    }
                    const counterUpdateResponse = await documentClient.update(counterUpdateParam).promise();
                    console.log(`Successfully dcecremented watchCount for playlistId ${playlistId}`);
                } else { // remove playlistId totally from dynamo. Really not needed since it'll be gone in 24hours
                    // Get rid of all trackUUIDs first
                    if (playlistItem.Item.trackUUIDs) {
                        console.log(`Deleting track UUIDs for playlist => ${playlistId}`);
                        console.log("==============Starting to delete trackUUIDs=============");
                        const trackUUIDs = playlistItem.Item.trackUUIDs.values;
                        for (const currentTrack of trackUUIDs) {
                            console.log(`==============deleting ${currentTrack}.....=============`);
                            const deleteTrackParams = {
                                TableName: songTrackerTableName,
                                Key: {id: currentTrack}
                            }
                            const deletedData = await documentClient.delete(deleteTrackParams).promise();
                            console.log(`Successfully deleted ${currentTrack}`);
                        }
                    }

                    console.log(`Deleting PlaylistId ${playlistId}`);
                    const deletePlaylistParams = {
                        TableName: playlistTableName,
                        Key: {playlistId: playlistId}
                    }
                    const [deletedData, deleteFromS3Data] = await Promise.all([documentClient.delete(deletePlaylistParams).promise(), removeItemFromArrayInS3(playlistId)]);
                }
            } else {
                // Something is def wrong, there should be watchCount
                console.log(`Somehow there's no watchCount field for ${playlistId}`);
            }
        } catch (e) {
            console.log(`Dynamo operation for /playlists/remove failed with error => ${e}`);
            return {
                statusCode: 500
            }
        }
    }



    return {
        statusCode: 200,
        body: {message: "Success"},
        headers: {
            'Content-Type': 'application/json'
        }
    }
}