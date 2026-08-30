// Uses global fetch (Node 18+) and Buffer, so this lambda has no runtime
// dependencies and its deploy zip is just index.js — matching
// spotify-refresh-token-lambda, its sibling in the OAuth flow.

/**
 * Exchanges a Spotify authorization code for an access/refresh token pair.
 *
 * This backs the SpotifyiOS SDK's tokenSwapURL, so the resolved value must be the
 * raw Spotify token JSON — the SDK parses it directly and does not unwrap a
 * statusCode envelope.
 *
 * @param {Object} event - API Gateway event. The mapping template turns the
 *   form-urlencoded body into `data`, so the authorization code is `event.data.code`.
 * @returns {Promise<Object>} Spotify's token JSON on success. On failure, Spotify's
 *   error JSON (e.g. `{ error: 'invalid_grant', ... }`), or `{ error, error_description }`
 *   describing a transport failure — never a token, so the SDK treats it as a failure.
 */
exports.handler = async (event) => {
    const credentials = Buffer.from(
        process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
    ).toString('base64');

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + credentials
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                redirect_uri: process.env.SPOTIFY_CLIENT_CALLBACK_URL,
                // authorization code is passed in the body as key "code"
                code: event.data.code
            })
        });

        // Read the body either way — Spotify explains a 400 in the JSON, and that
        // detail is the only way to tell a bad code from a bad redirect_uri.
        const body = await response.json();
        if (!response.ok) {
            console.log(`Spotify token swap failed with ${response.status}: ${JSON.stringify(body)}`);
        }
        return body;
    } catch (error) {
        console.log(`Error swapping Spotify authorization code: ${error.message}`);
        return { error: 'token_swap_failed', error_description: error.message };
    }
};

/*
API Gateway Mapper for application/x-www-form-urlencoded

{
    "data": {
        #foreach( $token in $input.path('$').split('&') )
            #set( $keyVal = $token.split('=') )
            #set( $keyValSize = $keyVal.size() )
            #if( $keyValSize >= 1 )
                #set( $key = $util.urlDecode($keyVal[0]) )
                #if( $keyValSize >= 2 )
                    #set( $val = $util.urlDecode($keyVal[1]) )
                #else
                    #set( $val = '' )
                #end
                "$key": "$val"#if($foreach.hasNext),#end
            #end
        #end
    }
}
*/
