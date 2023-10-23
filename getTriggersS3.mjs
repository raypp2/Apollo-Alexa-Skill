import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";


async function getTriggersS3() {

    const s3Client = new S3Client({ region: process.env.s3Region });

    const getParams = {
        Bucket: process.env.s3Bucket,
        Key: process.env.s3Key
    };

    const getCommand = new GetObjectCommand(getParams);
    const data = await s3Client.send(getCommand);

    // Correctly reading the stream as a buffer and then converting to string
    const triggersData = await new Promise((resolve, reject) => {
        let chunks = [];
        data.Body.on('data', chunk => chunks.push(chunk));
        data.Body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        data.Body.on('error', reject);
    });

    return JSON.parse(triggersData);
}

export { getTriggersS3 };