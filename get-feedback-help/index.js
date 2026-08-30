const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

// The v3 SES client ships with the nodejs22.x runtime, so it stays a devDependency
// and the deploy zip is just index.js — same pattern as fetch-new-song.
const ses = new SESClient({ region: 'us-east-1' });

/**
 * Emails a feedback/help message submitted from the iOS app's Settings screen.
 *
 * @param {Object} event - API Gateway event. The mapping template parses the
 *   form-urlencoded body into `body-json`, so the user's text arrives as
 *   `event["body-json"].message`.
 * @returns {Promise<Object>} The SES SendEmailCommand result on success, or the
 *   caught error on failure. The iOS client only inspects the HTTP status code and
 *   never reads this body, so the v2 -> v3 change in result shape is not breaking.
 * @throws {TypeError} If `event["body-json"]` is absent — this is deliberate and
 *   predates the v3 migration; it surfaces a malformed gateway mapping loudly
 *   rather than emailing an empty message.
 */
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
            Subject: {
                Data: "Feedback/Help SongUpdater"
            }
        },
        Source: process.env.FROM_EMAIL
    };

    try {
        return await ses.send(new SendEmailCommand(params));
    } catch (err) {
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
