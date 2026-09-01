// Uses global fetch and btoa (both built in since Node 18), so this lambda has
// no runtime dependencies and its deploy zip is just index.js.

/**
 * Refreshes a Spotify access token.
 *
 * This backs the SpotifyiOS SDK's tokenRefreshURL. The API Gateway integration is
 * a non-proxy ("AWS") integration with no response mapping template, so whatever
 * this function resolves to becomes the HTTP response body verbatim.
 *
 * ⚠️ That makes the return shape a hard contract: the SDK reads `access_token`
 * off the TOP LEVEL of the response. Wrapping it in an API-Gateway-style
 * `{ statusCode, body }` envelope — which looks correct, and is what a proxy
 * integration would need — silently breaks token refresh for every user, with no
 * error anywhere except failing Spotify calls in the app. That regression
 * shipped on 2026-08-30 and is what these comments exist to prevent.
 *
 * @param {Object} event - API Gateway event. The mapping template parses the
 *   form-urlencoded body into `data`, so the token arrives as
 *   `event.data.refresh_token`.
 * @returns {Promise<Object>} Spotify's raw token JSON on success. On failure,
 *   Spotify's raw error JSON, or `{ error, error_description }` for a transport
 *   failure — never anything carrying `access_token`, so the SDK treats it as a
 *   failed refresh.
 */
exports.handler = async (event) => {
  const refresh_token = event.data.refresh_token;

  // Presence only — never log the token itself.
  console.log('refresh_token present:', !!refresh_token);
  console.log('SPOTIFY_CLIENT_ID present:', !!process.env.SPOTIFY_CLIENT_ID);
  console.log('SPOTIFY_CLIENT_SECRET present:', !!process.env.SPOTIFY_CLIENT_SECRET);

  const credentials = btoa(
    process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
  );

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + credentials
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token
      })
    });

    // Read the body either way — Spotify explains a 400 in the JSON, and that
    // detail is the only way to tell a revoked grant from a bad client secret.
    const body = await response.json();

    if (!response.ok) {
      console.log(`Refresh failed with ${response.status}: ${JSON.stringify(body)}`);
      return body;
    }

    // Spotify usually does NOT return a new refresh token on refresh. Preserve
    // the caller's existing one so the client is never left unable to refresh
    // again, while otherwise passing Spotify's response through untouched.
    return { ...body, refresh_token: body.refresh_token ?? refresh_token };

  } catch (error) {
    console.error('Error refreshing Spotify token:', error.message);
    return { error: 'refresh_failed', error_description: error.message };
  }
};
