![Voice command pipeline](https://github.com/raypp2/Apollo-Home-Control/blob/27955635e82408807c428b5579908bc84e923690/documentation/images/voiceDiagram.jpeg?raw=true)

# Apollo Alexa Skill

An AWS Lambda function that bridges Alexa Smart Home commands to the [Apollo Home Control](https://github.com/raypp2/Apollo-Home-Control) application.

## Purpose
While it would be possible to sent commands directly to Apollo Home Control application, that would require opening up a port inside the home network and managing the security that goes along with that. Lambda is reasonably fast, free at low execution volumes, and integrates more easily with the Alexa Smart Home Skill API via conveniences like authentication (IAM).


## Supported Alexa Interfaces

- `Alexa Discovery` Registers devices and capabilities within Alexa Smart Home.
- `PowerController` Turning devices on and off. Also using this for scene or macro triggering.
- `BrightnessController` Dimming level of lights.
- `ThermostatController` Change temperature settings and HVAC modes.
- `LockController` Unlock doors with voice passcode.
- `Speaker` Change volume and mute.

## Command Pipeline

#### 1.0 Alexa Compatible Device
Listens for the wake word, uses voice-to-text, and matches the spoken command into an intent model. For example "Alexa, turn `ON` the `kitchen light`" would identify the user's intent as a power command `ON` for the device `kitchen light` and send that command to the associated device ecosystem, in this case, the Apollo Home Control application.

#### 2.0 Smart Home Skills API 
Amazon Alexa's Smart Home Skills API provides a command scheme and workflow for many different types of devices. Refer to their [documentation](https://developer.amazon.com/en-US/docs/alexa/smarthome/understand-the-smart-home-skill-api.html) for more information.

#### 3.0 AWS Lambda (This application)
This function decodes the commands from the Alexa Smart Home Skill, returns a valid response to that Alexa can give feedback to the user, and passes on the command to SQS. It also handles the initial registration of devices via the discovery functions.

#### 4.0 AWS SQS Queue
Posting each command to a pub-sub queue provides an abstraction layer that allows the local network controller application to pick up one or more commands within a defined expiration period. 

#### 5.0 Apollo Home Control
The commands are processed locally from the queue via the Apollo Home Control application.

## Limitations
The Alexa Smart Home API is bi-directional allowing both the push of commands and response from devices that they were successfully executed and to keep statuses in sync, such as when a light is on or off. Such feedback enables users to identify issues with reaching the device. Regarding status, like a light's on/off or dim state, this is more significant Alexa's visual interfaces such as the Alexa mobile app or on-screen visual feedback from the Echo Show product line. As these features provide little value for me, I've chosen not to implement them. 


## Setup & Installation

1) Create a Smart Home Skill & Lambda function ([Amazon's instructions](https://developer.amazon.com/en-US/docs/alexa/smarthome/create-skill-tutorial.html)) - This is unfortunately, a tricky and painful procedure. 
2) Create an SQS Queue ([instructions](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/step-create-queue.html)) - Use the same IAM role from the lambda function created in step 1 and add permission for action `sqs:SendMessage`
3) Use the code from this repo as your Lambda function
4) Configure the following environmental variables: 
   1) `sqsRegion` = Your SQS region (i.e. us-east-1)
   2) `sqsUrl` = Your SQS queue location (i.e. https://sqs.us-east-1.amazonaws.com/8888888888888/apollo)
5) Test within the Lambda console. Samples are provided in tests-console folder of this repo. These are representative of the commands that are sent by the Alexa Skills API.
6) Update the triggers.json file. The Apollo Home Control application auto-generates this based upon your configuration files.