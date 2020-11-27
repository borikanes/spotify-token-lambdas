var aws = require('aws-sdk');
var ses = new aws.SES();

exports.handler = async (event) => {
	const params = {
	        Destination: {
	            ToAddresses: [process.env.TO_EMAIL]
	        },
	        Message: {
	            Body: {
	                Text: {
										Data: event["body-json"].message
	                }
	            },
	            Subject: { Data: "Feedback/Help SongUpdater"
	            }
	        },
	        Source: process.env.FROM_EMAIL
	    };

	try {
		var emailSend = await ses.sendEmail(params).promise();
		if (emailSend.statusCode && emailSend.statusCode >= 400) {
			// Error in sending
			return "Error in sending email"
		}
		return emailSend;
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
