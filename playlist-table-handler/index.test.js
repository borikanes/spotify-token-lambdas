const { test, describe, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const lambda = require('./index.js');
const { documentClient, s3 } = lambda._test;

/**
 * Stubs every DynamoDB DocumentClient method the lambda uses, recording each call.
 *
 * @param {Object} [results] - Per-operation results, e.g. `{ get: { Item: {...} } }`.
 *   A `get` value may be a function receiving the params, for per-table results.
 * @returns {Array<{op: string, params: Object}>} The live log of calls made.
 */
function stubDynamo(results = {}) {
    const calls = [];
    for (const op of ['get', 'put', 'update', 'delete']) {
        mock.method(documentClient, op, (params) => {
            calls.push({ op, params });
            const result = results[op];
            const value = typeof result === 'function' ? result(params) : result;
            return { promise: async () => value || {} };
        });
    }
    return calls;
}

/**
 * Stubs S3 getObject/putObject over an in-memory playlist dictionary.
 *
 * @param {Object} [dictionary] - Initial contents of playlists.json.
 * @returns {{calls: Array<{op: string, params: Object}>, written: Function}} The call
 *   log plus a `written()` helper returning the parsed body of the last putObject.
 */
function stubS3(dictionary = {}) {
    const calls = [];
    mock.method(s3, 'getObject', (params) => {
        calls.push({ op: 'getObject', params });
        return { promise: async () => ({ Body: Buffer.from(JSON.stringify(dictionary)) }) };
    });
    mock.method(s3, 'putObject', (params) => {
        calls.push({ op: 'putObject', params });
        return { promise: async () => ({}) };
    });
    return {
        calls,
        written: () => {
            const puts = calls.filter(c => c.op === 'putObject');
            return puts.length ? JSON.parse(puts[puts.length - 1].params.Body) : null;
        }
    };
}

/**
 * Builds an API Gateway event for this lambda.
 *
 * @param {string} path - Request path.
 * @param {Object} [options] - `method`, `body`, `headers`, `stageVariables`.
 * @returns {Object} An API Gateway proxy event.
 */
function event(path, { method = 'POST', body = {}, headers = {}, stageVariables } = {}) {
    return { path, httpMethod: method, body: JSON.stringify(body), headers, stageVariables };
}

afterEach(() => mock.restoreAll());

describe('GET /playlists', () => {
    test('rejects a request with no device-id header', async () => {
        stubDynamo();

        const response = await lambda.handler(event('/playlists', { method: 'GET' }));

        assert.equal(response.statusCode, 400);
    });

    test('returns 404 when the device is unknown', async () => {
        stubDynamo({ get: {} });

        const response = await lambda.handler(
            event('/playlists', { method: 'GET', headers: { 'device-id': 'unknown' } })
        );

        assert.equal(response.statusCode, 404);
    });

    test('returns the watched playlists for a known device', async () => {
        stubDynamo({ get: { Item: { watchedPlaylists: ['pl1', 'pl2'] } } });

        const response = await lambda.handler(
            event('/playlists', { method: 'GET', headers: { 'device-id': 'dev1' } })
        );

        assert.equal(response.statusCode, 200);
        assert.deepEqual(JSON.parse(response.body), ['pl1', 'pl2']);
    });
});

describe('POST /playlists/add reference counting', () => {
    test('creates a new playlist with watchCount 1, guarded against overwriting', async () => {
        const calls = stubDynamo();
        const bucket = stubS3({});

        await lambda.handler(event('/playlists/add', { body: { playlistId: 'pl1' } }));

        const put = calls.find(c => c.op === 'put');
        assert.equal(put.params.Item.watchCount, 1);
        // Without this guard a second watcher would reset the count to 1 and the
        // first watcher's unwatch would delete a playlist someone else is watching.
        assert.equal(put.params.ConditionExpression, 'attribute_not_exists(playlistId)');
        assert.deepEqual(bucket.written(), { pl1: 1 });
    });

    test('increments watchCount when the playlist already exists', async () => {
        const calls = stubDynamo({
            put: () => { throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }); }
        });
        const bucket = stubS3({ pl1: 1 });

        await lambda.handler(event('/playlists/add', { body: { playlistId: 'pl1' } }));

        const update = calls.find(c => c.op === 'update');
        assert.match(update.params.UpdateExpression, /watchCount \+ :increment/);
        assert.equal(update.params.ExpressionAttributeValues[':increment'], 1);
        // The S3 add runs only on the create path, so a duplicate watch must not
        // touch the bucket here.
        assert.equal(bucket.calls.length, 0);
    });
});

describe('POST /playlists/remove reference counting', () => {
    test('decrements without deleting while other watchers remain', async () => {
        const calls = stubDynamo({ get: { Item: { playlistId: 'pl1', watchCount: 3 } } });
        stubS3({ pl1: 3 });

        await lambda.handler(event('/playlists/remove', { body: { playlistId: 'pl1' } }));

        const update = calls.find(c => c.op === 'update');
        assert.match(update.params.UpdateExpression, /watchCount - :decrement/);
        assert.equal(calls.filter(c => c.op === 'delete').length, 0,
            'a playlist still watched by others must never be deleted');
    });

    test('deletes the playlist and its tracks on the last unwatch', async () => {
        const calls = stubDynamo({
            get: { Item: { playlistId: 'pl1', watchCount: 1, trackUUIDs: { values: ['t1', 't2'] } } }
        });
        const bucket = stubS3({ pl1: 1 });

        await lambda.handler(event('/playlists/remove', { body: { playlistId: 'pl1' } }));

        const deletes = calls.filter(c => c.op === 'delete');
        const trackDeletes = deletes.filter(c => c.params.Key.id);
        assert.deepEqual(trackDeletes.map(c => c.params.Key.id), ['t1', 't2']);
        assert.equal(deletes.filter(c => c.params.Key.playlistId).length, 1);
        assert.deepEqual(bucket.written(), {}, 'the playlist should be gone from playlists.json');
    });

    test('deletes cleanly when the playlist has no tracks recorded', async () => {
        const calls = stubDynamo({ get: { Item: { playlistId: 'pl1', watchCount: 1 } } });
        stubS3({ pl1: 1 });

        await lambda.handler(event('/playlists/remove', { body: { playlistId: 'pl1' } }));

        const deletes = calls.filter(c => c.op === 'delete');
        assert.equal(deletes.length, 1);
        assert.equal(deletes[0].params.Key.playlistId, 'pl1');
    });

    test('decrements the S3 count rather than removing a still-watched playlist', async () => {
        stubDynamo({ get: { Item: { playlistId: 'pl1', watchCount: 1 } } });
        const bucket = stubS3({ pl1: 4 });

        await lambda.handler(event('/playlists/remove', { body: { playlistId: 'pl1' } }));

        assert.deepEqual(bucket.written(), { pl1: 3 });
    });
});

describe('stage-variable table selection', () => {
    test('routes a QA request to the QA tables', async () => {
        const calls = stubDynamo({ get: { Item: { watchedPlaylists: [] } } });

        await lambda.handler(event('/playlists', {
            method: 'GET',
            headers: { 'device-id': 'dev1' },
            stageVariables: { environment: 'qa' }
        }));

        assert.equal(calls[0].params.TableName, 'NotificationTrackerQA');
    });

    // KNOWN FAILING — documents a real bug rather than asserting current behavior.
    // setGlobalVariables() sets the QA table names but has no else branch restoring
    // the prod ones, and the names are module-level vars. Since a single Lambda
    // function serves both API Gateway stages, a warm container that handled a QA
    // request routes every subsequent PROD request to the QA tables until it is
    // recycled. Fix is an else branch resetting the four names to their prod values.
    test('routes a prod request to the prod tables even after a QA request', { todo: 'setGlobalVariables never resets to prod names' }, async () => {
        // One Lambda function serves BOTH stages here, and the table names are
        // module-level vars. A warm container that handled a QA request must not
        // keep the QA table names for the next prod request.
        stubDynamo({ get: { Item: { watchedPlaylists: [] } } });
        await lambda.handler(event('/playlists', {
            method: 'GET',
            headers: { 'device-id': 'dev1' },
            stageVariables: { environment: 'qa' }
        }));
        mock.restoreAll();

        const calls = stubDynamo({ get: { Item: { watchedPlaylists: [] } } });
        await lambda.handler(event('/playlists', {
            method: 'GET',
            headers: { 'device-id': 'dev1' },
            stageVariables: { environment: 'prod' }
        }));

        assert.equal(calls[0].params.TableName, 'NotificationTracker');
    });
});
