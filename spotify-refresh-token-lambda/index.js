// btoa is built-in since Node v18, no need to require it
// const btoa = require('btoa'); <-- remove this

exports.handler = async (event) => {
  console.log("--------------Lambda function started---------------");
  const refresh_token = event.data.refresh_token;

  // Log inputs to verify they're actually set
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

    // Always read the body first — Spotify returns a JSON error explaining the 400
    const body = await response.json();
    console.log('Spotify response:', JSON.stringify(body));

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: body.error, error_description: body.error_description })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? refresh_token
      })
    };

  } catch (error) {
    console.error('Error refreshing Spotify token:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};