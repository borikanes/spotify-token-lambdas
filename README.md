# Repo for all spotify server side lamdas

This repo contains lambda code for oauth transactions with Spotify

## Config
- Using AWS lambda and AWS API gateway to achieve token generation and refresh. For more info about token swap and refresh see [Spotify's documentation](https://developer.spotify.com/documentation/ios/guides/token-swap-and-refresh/)
- Using NodeJS 10.x
- [Axios](https://github.com/axios/axios) to make HTTP request to spotify

## How to use
I'm currently running the token swap in one lambda and refresh token in another lambda function. The only difference between the two are the data payload for the requests. I can easily combine into one lambda but for the sake of clarity and my sanity i'm keeping them separate.

To use this code base(Same instruction for refresh and token swap)
- Clone project
- Go into the spotify-refresh-token-lambda or the spotify-api-token-lambda folder, whichever you want to do first.
- Make sure you have node v10.x. Use [NVM](https://github.com/nvm-sh/nvm) to make your life easier. Run
```
npm install
```
- You're ready to push your code to AWS lambda. I use [node-lambda](https://www.npmjs.com/package/node-lambda) to upload my code. You can also do this in the console. Peep this [instruction from Amazon](https://docs.aws.amazon.com/lambda/latest/dg/getting-started-create-function.html). Please read the Things to note section below to help the setup go smoother.
- Add the three environment variables(`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_CLIENT_CALLBACK_URL`) to your lambda function. Set them to the values from your App Dashboard.
- Do this instruction set for the other lambda.

## API Gateway
It get's a little tricky here. You're using this gateway to point to your lambdas. If you're unfamiliar I'll recommend reading [AWS's documentation](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-create-api.html)
- Create an API
- Create two resources. I created `/api/token` for the token swap and `/api/refresh_token` for token refresh
- For each one, point them to it's respective lambda and create a POST method
- Set the mapping template for the Integration Request on each resource to the below. My content-type is set to `application/x-www-form-urlencoded`

```
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
```
I highly recommend [this article](https://blog.summercat.com/using-aws-lambda-and-api-gateway-as-html-form-endpoint.html) if you've never worked with API gateways and lambdas. It has screenshots.

**Things to note:**
- You'll want create a role for lambda that has access to API Gateway and CloudWatch Logs.
- Make sure to include the node_modules folder in your lambda.
