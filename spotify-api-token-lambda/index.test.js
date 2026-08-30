const { test, describe, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';
process.env.SPOTIFY_CLIENT_CALLBACK_URL = 'song-updater://spotify-login-callback';

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

describe('token swap handler', () => {
    test('returns Spotify token JSON unwrapped', async () => {
        // The SpotifyiOS SDK parses this response directly as its token payload,
        // so it must not be wrapped in a statusCode envelope.
        stubFetch(() => response(200, {
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            token_type: 'Bearer'
        }));

        const result = await lambda.handler({ data: { code: 'auth-code' } });

        assert.equal(result.access_token, 'access-1');
        assert.equal(result.refresh_token, 'refresh-1');
        assert.equal(result.statusCode, undefined, 'must not be wrapped in an envelope');
    });

    test('sends the authorization_code grant with Basic auth and the callback URL', async () => {
        const requests = stubFetch(() => response(200, { access_token: 'a' }));

        await lambda.handler({ data: { code: 'auth-code' } });

        const { url, options } = requests[0];
        assert.equal(url, 'https://accounts.spotify.com/api/token');
        assert.equal(options.method, 'POST');
        assert.equal(
            options.headers.Authorization,
            'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64')
        );
        assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');

        const body = new URLSearchParams(options.body.toString());
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.equal(body.get('code'), 'auth-code');
        // A redirect_uri that does not exactly match the one used to obtain the
        // code is one of the two ways Spotify returns invalid_grant here.
        assert.equal(body.get('redirect_uri'), 'song-updater://spotify-login-callback');
    });

    test('returns Spotify error JSON when the code is rejected', async () => {
        stubFetch(() => response(400, {
            error: 'invalid_grant',
            error_description: 'Invalid authorization code'
        }));

        const result = await lambda.handler({ data: { code: 'stale-code' } });

        assert.equal(result.error, 'invalid_grant');
        assert.equal(result.access_token, undefined);
    });

    test('returns a described error when the request to Spotify cannot be made', async () => {
        stubFetch(() => { throw new Error('network down'); });

        const result = await lambda.handler({ data: { code: 'auth-code' } });

        assert.deepEqual(result, {
            error: 'token_swap_failed',
            error_description: 'network down'
        });
    });
});
