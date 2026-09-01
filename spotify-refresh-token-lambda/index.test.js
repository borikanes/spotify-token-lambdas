const { test, describe, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';

const lambda = require('./index.js');

/**
 * Builds a fake `fetch` Response for Spotify's token endpoint.
 *
 * @param {number} status - HTTP status.
 * @param {Object} body - JSON body Spotify returns.
 * @returns {Object} The `status`/`ok`/`json` surface the lambda uses.
 */
function response(status, body) {
    return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/**
 * Stubs global fetch, recording the requests made.
 *
 * @param {Function} handler - Receives (url, options), returns a response.
 * @returns {Array<{url: string, options: Object}>} The live request log.
 */
function stubFetch(handler) {
    const requests = [];
    mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push({ url, options });
        return handler(url, options);
    });
    return requests;
}

afterEach(() => mock.restoreAll());

describe('response contract', () => {
    // These are the tests that would have caught the 2026-08-30 outage. The
    // previous suite asserted a { statusCode, body } envelope, which looks
    // plausible but is wrong for this non-proxy API Gateway integration: the
    // lambda's return value IS the response body, and the SpotifyiOS SDK reads
    // access_token off the top level. The tests passed while production was
    // broken, because they pinned the bug rather than the contract.

    test('resolves access_token at the TOP LEVEL, not inside an envelope', async () => {
        stubFetch(() => response(200, {
            access_token: 'access-1',
            token_type: 'Bearer',
            expires_in: 3600
        }));

        const result = await lambda.handler({ data: { refresh_token: 'old-refresh' } });

        assert.equal(result.access_token, 'access-1');
        assert.equal(result.statusCode, undefined, 'must not be wrapped in a statusCode envelope');
        assert.equal(result.body, undefined, 'must not stringify the payload into a body field');
    });

    test('passes through the fields the SDK needs', async () => {
        stubFetch(() => response(200, {
            access_token: 'access-1',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'playlist-read-private'
        }));

        const result = await lambda.handler({ data: { refresh_token: 'old-refresh' } });

        assert.equal(result.token_type, 'Bearer');
        assert.equal(result.expires_in, 3600);
        assert.equal(result.scope, 'playlist-read-private');
    });

    test('never returns access_token on failure', async () => {
        // The SDK decides success by finding access_token, so an error response
        // must not carry one under any circumstances.
        stubFetch(() => response(400, {
            error: 'invalid_grant',
            error_description: 'Invalid refresh token'
        }));

        const result = await lambda.handler({ data: { refresh_token: 'revoked' } });

        assert.equal(result.access_token, undefined);
        assert.equal(result.error, 'invalid_grant');
    });

    test('never returns access_token when the request itself fails', async () => {
        stubFetch(() => { throw new Error('network down'); });

        const result = await lambda.handler({ data: { refresh_token: 'old-refresh' } });

        assert.equal(result.access_token, undefined);
        assert.equal(result.error, 'refresh_failed');
        assert.equal(result.error_description, 'network down');
    });
});

describe('refresh token handling', () => {
    test('falls back to the original refresh token when Spotify omits a new one', async () => {
        // Spotify usually does NOT return a new refresh token on refresh.
        // Dropping it would leave the client unable to ever refresh again.
        stubFetch(() => response(200, { access_token: 'new-access' }));

        const result = await lambda.handler({ data: { refresh_token: 'old-refresh' } });

        assert.equal(result.refresh_token, 'old-refresh');
    });

    test('prefers a rotated refresh token when Spotify sends one', async () => {
        stubFetch(() => response(200, { access_token: 'new-access', refresh_token: 'rotated' }));

        const result = await lambda.handler({ data: { refresh_token: 'old-refresh' } });

        assert.equal(result.refresh_token, 'rotated');
    });

    test('sends client credentials as HTTP Basic and the refresh_token grant', async () => {
        const requests = stubFetch(() => response(200, { access_token: 'a' }));

        await lambda.handler({ data: { refresh_token: 'old-refresh' } });

        const { url, options } = requests[0];
        assert.equal(url, 'https://accounts.spotify.com/api/token');
        assert.equal(options.method, 'POST');
        assert.equal(
            options.headers.Authorization,
            'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64')
        );
        const body = new URLSearchParams(options.body.toString());
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('refresh_token'), 'old-refresh');
    });
});
