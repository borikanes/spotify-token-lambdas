const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid'); // uuidv4()

// Dynamo config
AWS.config.update({region: 'us-east-1'});
const documentClient = new AWS.DynamoDB.DocumentClient();
// S3 config
const s3 = new AWS.S3();

const playlistTableName = "WatchedPlaylists";
const songTrackerTableName = "SongTrackMapper";
const resourceBucket = "song-updater-resources";
const playlistFileKey = "playlists.json";

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
            playlistDictionary[playlistId] -= 1
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
    let playlistId;
    // if event is to add playlist
    // TODO: Don't add duplicate playlist
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
                } else { // remove playlistId totally from dynamo
                    // Get rid of all trackUUIDs first
                    if (playlistItem.Item.trackUUIDs) {
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
                    const deletedData = await documentClient.delete(deletePlaylistParams).promise();
                    await removeItemFromArrayInS3(playlistId);
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
    } else { // If it's the hourly job that runs
        console.log("==============In else=============");
        // Update pid table songs
        // get s3 array
        const getParams = {
            Bucket: resourceBucket,
            Key: playlistFileKey,
        }
        const data = await s3.getObject(getParams).promise();
        const jsonString = data.Body.toString('utf-8');
        const playlistArray = JSON.parse(jsonString);
        // console.log(`Array ============= ${playlistArray}`);

        for (const currentPlaylist of playlistArray) {
            // console.log("=============In FOR OF=============");
            try {
                const dynamoGetParams = {
                    TableName: playlistTableName,
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
                        const currentTimeUTC = new Date().toISOString();

                        // compare time
                        const lastModifiedTimestampParsedDate = Date.parse(lastModifiedTimestamp);
                        const currentTimeUTCParsedDate = Date.parse(currentTimeUTC);

                        // https://stackoverflow.com/a/19225540/2620826
                        const dateDifferenceInHours = (currentTimeUTCParsedDate - lastModifiedTimestampParsedDate) / 36e5;
                        if (dateDifferenceInHours >= 24) { // If the song has been in the table for over 24hrs, delete
                            const deleteTrackParams = {
                                TableName: songTrackerTableName,
                                Key: {id: trackUUID}
                            }
                            const deletedData = await documentClient.delete(deleteTrackParams).promise();

                            // Remove trackUUID from playlist table
                            console.log(`==================REMOVING TRACK ${trackUUID} FROM SET==================`);
                            const currentTimePlaylistTable = new Date().toISOString();
                            const dynamoUpdateParams = {
                                TableName: playlistTableName,
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
                // return({
                //     statusCode: 500,
                // });
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