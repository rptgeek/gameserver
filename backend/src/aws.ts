import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { config } from "./config";

const clientConfig = {
  region: config.awsRegion,
};

export const ec2Client = new EC2Client(clientConfig);
export const ssmClient = new SSMClient(clientConfig);
export const logsClient = new CloudWatchLogsClient(clientConfig);
export const dynamoClient = new DynamoDBClient(clientConfig);
export const ddbClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});
