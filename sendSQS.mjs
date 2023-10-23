import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { SQSClient } from "@aws-sdk/client-sqs";

const QUEUE_URL = process.env.sqsUrl; // SQS queue
const sqs = new SQSClient({ region: process.env.sqsRegion });

async function sendMessageToSQS(event, apiCommand, contextProperties) {

    const accessToken = event.directive.endpoint.scope.token;
    const applianceId = event.directive.endpoint.endpointId;
    const messageId = event.directive.header.messageId;
    const correlationToken = event.directive.header.correlationToken;

    const sendMessageCommand = new SendMessageCommand({
        MessageAttributes: {
            "local_timestamp": {
                DataType: "Number",
                StringValue: Date.now().toString(),
            },
        },
        MessageBody: apiCommand,
        QueueUrl: QUEUE_URL,
    });

    console.log("Message to SQS:", apiCommand);
    try {
        const data = await sqs.send(sendMessageCommand);
        console.log("Confirmation Request ID from SQS:", data.MessageId);

        return {
            event: {
                header: {
                    namespace: 'Alexa',
                    name: `Response`,
                    payloadVersion: '3',
                    messageId: messageId,
                    correlationToken: correlationToken
                },
                endpoint: {
                    endpointId: applianceId,
                    scope: {
                        type: "BearerToken",
                        token: accessToken
                    }
                },
                payload: {}
            },
            context: {
                properties: contextProperties
            }
        };
    } catch (err) {
        console.error("Error", err);
        throw new Error("Error sending message to SQS.");
    }
}

export { sendMessageToSQS };