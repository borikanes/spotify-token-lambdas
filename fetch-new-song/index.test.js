const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const lambda = require('./index.js');
const {
    isTimeWithin24Hours,
    removeDuplicatesFromTrackArray,
    getTracksAddedInTheLast24Hours,
    getFailedPlaylists,
    resetFailedPlaylists
} = lambda._test;

/**
 * Builds an ISO timestamp offset from now.
 *
 * @param {number} hours - Hours in the past (positive) or future (negative).
 * @returns {string} An ISO 8601 timestamp.
 */
function hoursAgo(hours) {
    return new Date(Date.now() - hours * 36e5).toISOString();
}

/**
 * Builds a playlist track item of the shape the lambda reads.
 *
 * @param {string} trackId - Spotify track ID.
 * @param {string} [addedAt] - ISO timestamp for `added_at`.
 * @returns {Object} A playlist item.
 */
function item(trackId, addedAt = hoursAgo(1)) {
    return { added_at: addedAt, track: { id: trackId, name: `Track ${trackId}` } };
}

/**
 * Builds a fake `fetch` Response.
 *
 * @param {number} status - HTTP status.
 * @param {Object} body - JSON body to return.
 * @returns {Object} The `status`/`json` surface the lambda uses.
 */
function response(status, body) {
    return { status, json: async () => body };
}

beforeEach(() => resetFailedPlaylists());
afterEach(() => mock.restoreAll());

describe('isTimeWithin24Hours', () => {
    test('accepts a track added an hour ago', () => {
        assert.equal(isTimeWithin24Hours(hoursAgo(1)), true);
    });

    test('accepts a track added just under 24 hours ago', () => {
        assert.equal(isTimeWithin24Hours(hoursAgo(23)), true);
    });

    test('rejects a track added more than 24 hours ago', () => {
        assert.equal(isTimeWithin24Hours(hoursAgo(25)), false);
    });

    test('rejects a track added exactly 24 hours ago', () => {
        // The comparison truncates to whole hours and is strictly <24, so a track
        // at exactly the boundary falls outside the window.
        assert.equal(isTimeWithin24Hours(hoursAgo(24)), false);
    });
});

describe('removeDuplicatesFromTrackArray', () => {
    test('returns an empty array unchanged', () => {
        assert.deepEqual(removeDuplicatesFromTrackArray([]), []);
    });

    test('keeps the first occurrence of each track and preserves order', () => {
        const tracks = [
            { trackId: 'a' }, { trackId: 'b' }, { trackId: 'a' }, { trackId: 'c' }, { trackId: 'b' }
        ];

        assert.deepEqual(
            removeDuplicatesFromTrackArray(tracks).map(t => t.trackId),
            ['a', 'b', 'c']
        );
    });

    test('drops entries with no trackId', () => {
        // A track missing an id cannot be deduplicated or looked up later, and
        // writing it would create an unreachable row.
        const tracks = [{ trackId: 'a' }, { trackId: null }, {}, { trackId: 'b' }];

        assert.deepEqual(
            removeDuplicatesFromTrackArray(tracks).map(t => t.trackId),
            ['a', 'b']
        );
    });
});

describe('getTracksAddedInTheLast24Hours', () => {
    test('returns only tracks added within the window', async () => {
        mock.method(globalThis, 'fetch', async () => response(200, {
            name: 'My Playlist',
            owner: { display_name: 'Someone' },
            tracks: { total: 3, next: null, items: [item('a'), item('b', hoursAgo(50)), item('c')] }
        }));

        const { tracks, playlistTitle } = await getTracksAddedInTheLast24Hours('pl1', 'token');

        assert.equal(playlistTitle, 'My Playlist');
        assert.deepEqual(tracks.map(t => t.track.id), ['a', 'c']);
    });

    test('skips the playlist and records the failure when Spotify errors', async () => {
        // One deleted or private playlist must not kill the whole cron run.
        mock.method(globalThis, 'fetch', async () => response(404, { error: 'not found' }));

        const { tracks } = await getTracksAddedInTheLast24Hours('gone', 'token');

        assert.deepEqual(tracks, []);
        assert.deepEqual(getFailedPlaylists(), [{ playlistId: 'gone', status: 404 }]);
    });

    test('ignores a Spotify-owned playlist that reloaded all of its tracks', async () => {
        // Anti-spam: Spotify periodically rewrites its own playlists wholesale,
        // which would otherwise notify every watcher about every track.
        mock.method(globalThis, 'fetch', async () => response(200, {
            name: 'Discover Weekly',
            owner: { display_name: 'Spotify' },
            tracks: { total: 2, next: null, items: [item('a'), item('b')] }
        }));

        const { tracks } = await getTracksAddedInTheLast24Hours('spotify-pl', 'token');

        assert.deepEqual(tracks, []);
    });

    test('does not apply the reload rule to a user-owned playlist', async () => {
        mock.method(globalThis, 'fetch', async () => response(200, {
            name: 'My Playlist',
            owner: { display_name: 'Someone' },
            tracks: { total: 2, next: null, items: [item('a'), item('b')] }
        }));

        const { tracks } = await getTracksAddedInTheLast24Hours('user-pl', 'token');

        assert.equal(tracks.length, 2);
    });

    test('follows pagination and merges pages', async () => {
        let call = 0;
        mock.method(globalThis, 'fetch', async () => {
            call += 1;
            if (call === 1) {
                return response(200, {
                    name: 'Big Playlist',
                    owner: { display_name: 'Someone' },
                    tracks: { total: 4, next: 'https://api.spotify.com/next', items: [item('a')] }
                });
            }
            return response(200, { next: null, items: [item('b'), item('c')] });
        });

        const { tracks } = await getTracksAddedInTheLast24Hours('pl1', 'token');

        assert.deepEqual(tracks.map(t => t.track.id), ['a', 'b', 'c']);
    });

    test('keeps tracks already collected when a pagination page fails', async () => {
        let call = 0;
        mock.method(globalThis, 'fetch', async () => {
            call += 1;
            if (call === 1) {
                return response(200, {
                    name: 'Big Playlist',
                    owner: { display_name: 'Someone' },
                    tracks: { total: 4, next: 'https://api.spotify.com/next', items: [item('a')] }
                });
            }
            return response(429, { error: 'rate limited' });
        });

        const { tracks } = await getTracksAddedInTheLast24Hours('pl1', 'token');

        assert.deepEqual(tracks.map(t => t.track.id), ['a']);
        assert.deepEqual(getFailedPlaylists(), [{ playlistId: 'pl1', status: 429 }]);
    });
});
