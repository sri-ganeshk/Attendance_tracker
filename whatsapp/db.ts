import AWS from "aws-sdk";
import type { UserRecord } from "./types";

const USER_TABLE = process.env.DYNAMODB_USER_TABLE;
const AWS_REGION  = process.env.AWS_REGION;

if (!AWS_REGION) throw new Error("Missing required environment variable: AWS_REGION");

const db = new AWS.DynamoDB.DocumentClient({ region: AWS_REGION });

export async function getUser(phoneNumber: string): Promise<UserRecord | null> {
  const result = await db.get({ TableName: USER_TABLE, Key: { phoneNumber } }).promise();
  return (result.Item as UserRecord) ?? null;
}

export async function saveUser(user: UserRecord): Promise<void> {
  await db.put({ TableName: USER_TABLE, Item: user }).promise();
}
