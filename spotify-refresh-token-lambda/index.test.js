const { test, describe, beforeEach, afterEach, mock } = require('node:test');
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

describe('refresh token handler', () => {
    test('exchanges a refresh token and returns the new access token', async () => {
        stubFetch(() => response(200, { access_token: 'new-access', refresh_token: 'new-refresh' }));

        const result = await lambda.handler({ data: { refresh_token: 'old-refresh' } });

        assert.equal(result.statusCode, 200);
        assert.deepEqual(JSON.parse(result.body), {
            access_token: 'new-access',
            refresh_token: 'new-refresh'
        });
    });

    test('falls back to the original refresh token when Spotify omits a new one', async () => {
        // Spotify usually does NOT return a new refresh token on refresh. Dropping
        // it here would leave the app with no way to refresh again.
        stubFetch(() => response(200, { access_token: 'new-access' }));

        const result = await lambda.handler({ data: { refresh_token: 'old-refresh' } });

        assert.equal(JSON.parse(result.body).refresh_token, 'old-refresh');
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
        assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
        const body = new URLSearchParams(options.body.toString());
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('refresh_token'), 'old-refresh');
    });

    test('passes through the status and error detail when Spotify rejects the token', async () => {
        // The app relies on the 400 to know the grant is dead and a full re-auth
        // is needed, so the status must not be flattened into a 200 or a 500.
        stubFetch(() => response(400, {
            error: 'invalid_grant',
            error_description: 'Invalid refresh token'
        }));

        const result = await lambda.handler({ data: { refresh_token: 'revoked' } });

        assert.equal(result.statusCode, 400);
        assert.deepEqual(JSON.parse(result.body), {
            error: 'invalid_grant',
            error_description: 'Invalid refresh token'
        });
    });

    test('returns 500 when the request to Spotify cannot be made at all', async () => {
        stubFetch(() => { throw new Error('network down'); });

        const result = await lambda.handler({ data: { refresh_token: 'old-refresh' } });

        assert.equal(result.statusCode, 500);
        assert.equal(JSON.parse(result.body).error, 'network down');
    });
});
