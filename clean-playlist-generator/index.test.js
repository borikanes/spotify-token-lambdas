const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const lambda = require('./index.js');
const { searchForCleanVersion, resolveCleanTrackUri, documentClient, lambdaClient } = lambda._test;

/**
 * Builds a minimal Spotify track object of the shape the lambda actually reads.
 *
 * @param {Object} [overrides] - Fields to override on the default track.
 * @returns {Object} A Spotify-shaped track object.
 */
function track(overrides = {}) {
    return {
        id: 'explicit123',
        name: 'Test Song',
        uri: 'spotify:track:explicit123',
        explicit: true,
        artists: [{ name: 'Test Artist' }],
        ...overrides
    };
}

/**
 * Builds a fake `fetch` Response carrying a Spotify search result.
 *
 * @param {number} status - HTTP status to report.
 * @param {Array<Object>} [items] - Candidate tracks in `tracks.items`.
 * @returns {Object} An object with the `status`/`json` surface the lambda uses.
 */
function searchResponse(status, items = []) {
    return { status, json: async () => ({ tracks: { items } }) };
}

/**
 * Stubs `documentClient.send`, recording every command it receives.
 *
 * @param {Function} handler - Receives each command, returns that call's result.
 * @returns {Array<Object>} The live array of commands the code under test sent.
 */
function stubDocumentClient(handler) {
    const sent = [];
    mock.method(documentClient, 'send', async (command) => {
        sent.push(command);
        return handler(command);
    });
    return sent;
}

afterEach(() => mock.restoreAll());

describe('searchForCleanVersion', () => {
    test('reports searched:false when the request itself fails', async () => {
        // The distinction this asserts is the whole point: a 429/5xx is not
        // evidence that no clean version exists. Collapsing the two poisoned
        // the shared cache in prod (18 tracks, Aug 2026).
        mock.method(globalThis, 'fetch', async () => searchResponse(429));

        const result = await searchForCleanVersion(track(), 'token');

        assert.deepEqual(result, { searched: false, match: null });
    });

    test('reports searched:true with no match when the search genuinely finds nothing', async () => {
        mock.method(globalThis, 'fetch', async () => searchResponse(200, []));

        const result = await searchForCleanVersion(track(), 'token');

        assert.equal(result.searched, true);
        assert.equal(result.match, null);
    });

    test('matches a non-explicit candidate with the same name and artist', async () => {
        const clean = {
            id: 'clean456',
            uri: 'spotify:track:clean456',
            name: 'test song',
            explicit: false,
            artists: [{ name: 'TEST ARTIST' }]
        };
        mock.method(globalThis, 'fetch', async () => searchResponse(200, [clean]));

        const result = await searchForCleanVersion(track(), 'token');

        assert.equal(result.searched, true);
        assert.equal(result.match.uri, 'spotify:track:clean456');
    });

    test('rejects a candidate that still explicit even when name and artist match', async () => {
        const stillExplicit = {
            id: 'nope',
            uri: 'spotify:track:nope',
            name: 'Test Song',
            explicit: true,
            artists: [{ name: 'Test Artist' }]
        };
        mock.method(globalThis, 'fetch', async () => searchResponse(200, [stillExplicit]));

        const result = await searchForCleanVersion(track(), 'token');

        assert.equal(result.match, null);
    });

    test('rejects a non-explicit candidate by a different artist', async () => {
        const wrongArtist = {
            id: 'nope',
            uri: 'spotify:track:nope',
            name: 'Test Song',
            explicit: false,
            artists: [{ name: 'Someone Else' }]
        };
        mock.method(globalThis, 'fetch', async () => searchResponse(200, [wrongArtist]));

        const result = await searchForCleanVersion(track(), 'token');

        assert.equal(result.match, null);
    });
});

describe('resolveCleanTrackUri', () => {
    test('returns a cached match without searching', async () => {
        stubDocumentClient(() => ({
            Item: { status: 'matched', cleanTrackUri: 'spotify:track:cached' }
        }));
        const fetchMock = mock.method(globalThis, 'fetch', async () => searchResponse(200));

        const uri = await resolveCleanTrackUri(track(), 'token');

        assert.equal(uri, 'spotify:track:cached');
        assert.equal(fetchMock.mock.callCount(), 0, 'a cache hit must not hit the Spotify API');
    });

    test('returns null for a cached negative without searching', async () => {
        stubDocumentClient(() => ({ Item: { status: 'no_clean_version' } }));
        const fetchMock = mock.method(globalThis, 'fetch', async () => searchResponse(200));

        const uri = await resolveCleanTrackUri(track(), 'token');

        assert.equal(uri, null);
        assert.equal(fetchMock.mock.callCount(), 0);
    });

    test('writes NOTHING to the cache when the search request failed', async () => {
        // Regression guard for the bug that permanently marked 18 prod tracks as
        // having no clean version after a burst of Spotify rate limiting.
        const sent = stubDocumentClient(() => ({}));
        mock.method(globalThis, 'fetch', async () => searchResponse(503));

        const uri = await resolveCleanTrackUri(track(), 'token');

        assert.equal(uri, null);
        const writes = sent.filter(c => c.constructor.name === 'PutCommand');
        assert.equal(writes.length, 0, 'a failed search must never be cached as a negative');
    });

    test('caches a genuine miss as no_clean_version', async () => {
        const sent = stubDocumentClient(() => ({}));
        mock.method(globalThis, 'fetch', async () => searchResponse(200, []));

        const uri = await resolveCleanTrackUri(track(), 'token');

        assert.equal(uri, null);
        const writes = sent.filter(c => c.constructor.name === 'PutCommand');
        assert.equal(writes.length, 1);
        assert.equal(writes[0].input.Item.status, 'no_clean_version');
        assert.equal(writes[0].input.Item.cleanTrackUri, null);
    });

    test('caches a found match and returns its uri', async () => {
        const sent = stubDocumentClient(() => ({}));
        mock.method(globalThis, 'fetch', async () => searchResponse(200, [{
            id: 'clean456',
            uri: 'spotify:track:clean456',
            name: 'Test Song',
            explicit: false,
            artists: [{ name: 'Test Artist' }]
        }]));

        const uri = await resolveCleanTrackUri(track(), 'token');

        assert.equal(uri, 'spotify:track:clean456');
        const write = sent.find(c => c.constructor.name === 'PutCommand');
        assert.equal(write.input.Item.status, 'matched');
        assert.equal(write.input.Item.cleanTrackId, 'clean456');
        assert.equal(write.input.Item.matchMethod, 'search_exact_name_artist');
    });
});

describe('handler routing and stage-variable threading', () => {
    /**
     * Builds a POST /playlists/clean API Gateway event.
     *
     * @param {Object} [body] - Fields merged into the JSON request body.
     * @param {Object} [stageVariables] - Stage variables to attach to the event.
     * @returns {Object} An API Gateway proxy event.
     */
    function startJobEvent(body = {}, stageVariables = undefined) {
        return {
            path: '/playlists/clean',
            httpMethod: 'POST',
            headers: { Authorization: 'Bearer user-token' },
            body: JSON.stringify({ playlistId: 'pl1', deviceId: 'dev1', ...body }),
            stageVariables
        };
    }

    test('threads the stage environment into the async worker payload', async () => {
        // stageVariables exist only on the HTTP invocation. When this was not
        // threaded through, the worker defaulted to prod and sent QA completion
        // pushes to the production APNs endpoint (400 BadDeviceToken).
        stubDocumentClient(() => ({}));
        const invocations = [];
        mock.method(lambdaClient, 'send', async (command) => {
            invocations.push(command);
            return {};
        });

        const response = await lambda.handler(
            startJobEvent({}, { environment: 'qa' }),
            { functionName: 'cleanPlaylistGeneratorQA' }
        );

        assert.equal(response.statusCode, 202);
        assert.equal(invocations.length, 1);
        const payload = JSON.parse(Buffer.from(invocations[0].input.Payload).toString());
        assert.equal(payload.environment, 'qa');
        assert.equal(payload.action, 'processCleanJob');
        assert.equal(invocations[0].input.InvocationType, 'Event');
    });

    test('leaves the worker environment undefined when no stage variables are set', async () => {
        stubDocumentClient(() => ({}));
        const invocations = [];
        mock.method(lambdaClient, 'send', async (command) => {
            invocations.push(command);
            return {};
        });

        await lambda.handler(startJobEvent(), { functionName: 'cleanPlaylistGenerator' });

        const payload = JSON.parse(Buffer.from(invocations[0].input.Payload).toString());
        assert.equal(payload.environment, undefined);
    });

    test('accepts deviceId from the body, since the app cannot send it as a header on POSTs', async () => {
        stubDocumentClient(() => ({}));
        const invocations = [];
        mock.method(lambdaClient, 'send', async (command) => {
            invocations.push(command);
            return {};
        });

        await lambda.handler(startJobEvent({ deviceId: 'from-body' }), { functionName: 'fn' });

        const payload = JSON.parse(Buffer.from(invocations[0].input.Payload).toString());
        assert.equal(payload.deviceId, 'from-body');
    });

    test('rejects a request with no playlistId', async () => {
        const event = startJobEvent();
        event.body = JSON.stringify({ deviceId: 'dev1' });

        const response = await lambda.handler(event, { functionName: 'fn' });

        assert.equal(response.statusCode, 400);
    });

    test('rejects a request with no Authorization header', async () => {
        const event = startJobEvent();
        event.headers = {};

        const response = await lambda.handler(event, { functionName: 'fn' });

        assert.equal(response.statusCode, 400);
    });

    test('returns 404 for an unknown path', async () => {
        const response = await lambda.handler(
            { path: '/nope', httpMethod: 'GET' },
            { functionName: 'fn' }
        );

        assert.equal(response.statusCode, 404);
    });
});
