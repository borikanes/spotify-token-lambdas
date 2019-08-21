const btoa = require('btoa');
const axios = require('axios');
const qs = require('qs');

exports.handler = async (event) => {
	const config = {
	    method: "POST",
	    url: "https://accounts.spotify.com/api/token",
	    headers: {
	      "Content-Type": "application/x-www-form-urlencoded",
	      "Authorization": "Basic " + btoa(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET)
	    },
	    data: {
	      grant_type: 'authorization_code',
	      redirect_uri: process.env.SPOTIFY_CLIENT_CALLBACK_URL,
	      code: event.data.code // authorization code is passed in the body as key "code"
	    }
	}

	try {
		// url encode data to send to spotify
		config.data = qs.stringify(config.data)

		let res = await axios(config);
		let data = res.data;

		return data;
	} catch(err) {
		console.log(err);
		return err;
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