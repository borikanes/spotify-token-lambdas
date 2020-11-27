package main

import (
        "fmt"
        "time"
        "io/ioutil"
        "github.com/aws/aws-lambda-go/lambda"
        "github.com/gbrlsnchs/jwt"
)

func init() {

}

type MyEvent struct {
        Name string `json:"What is your name?"`
        Age int     `json:"How old are you?"`
}

type MyResponse struct {
        Message string `json:"Answer:"`
}

func HandleLambdaEvent(event MyEvent) (MyResponse, error) {
        return MyResponse{Message: fmt.Sprintf("%s is %d years old!", event.Name, event.Age)}, nil
}

type JWTPayload struct {
	jwt.Payload
}

func generateJWTToken() (string, error) {
  var alg = jwt.NewHS256([]byte("secret"))
  now := time.Now()
  jwtPayload = jwt.Payload {
    Issuer: "7B6H8LADVH",
    IssuedAt: jwt.NumericDate(now)
  }

  token, error = jwt.Sign(jwtPayload, alg, jwt.ContentType("JWT"), jwt.KeyID("my_key"))
  if error != nil {
    // Handle error
  }
  return token
}

func main() {
        // lambda.Start(HandleLambdaEvent)
        fmt.Printf()
}
