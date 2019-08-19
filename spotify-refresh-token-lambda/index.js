const btoa = require('btoa');
const axios = require('axios');
const qs = require('qs');

exports.handler = async (event) => {
	console.log(event)
	console.log("--------------Lambda function started---------------");
	const config = {
	    method: "POST",
	    url: "https://accounts.spotify.com/api/token",
	    headers: {
	      "Content-Type": "application/x-www-form-urlencoded",
	      "Authorization": "Basic " + btoa(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET)
	    },
	    data: {
	      grant_type: "refresh_token",
	      refresh_token: event.data.refresh_token
	    }
	}
	console.log("--------------Set config var---------------");
	try {
		config.data = qs.stringify(config.data)
		console.log(config.data);
		let res = await axios(config);
		let data = res.data;
		console.log(data);
		return data;
	} catch(err) {
		console.log(err);
		console.log(err.data);
		return err.data;
	}
};