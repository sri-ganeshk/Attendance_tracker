import AWS from "aws-sdk";
import { initAuthCreds, type AuthenticationState } from "@whiskeysockets/baileys";

type DynamoDB = AWS.DynamoDB.DocumentClient;

const BufferJSON = {
  replacer: (_key: string, value: unknown) => {
    if (
      Buffer.isBuffer(value as Buffer) ||
      value instanceof Uint8Array ||
      (value as { type?: string })?.type === "Buffer"
    ) {
      return {
        type: "Buffer",
        data: Buffer.from(
          (value as { data?: Buffer }).data ?? (value as Buffer)
        ).toString("base64"),
      };
    }
    return value;
  },
  reviver: (_key: string, value: unknown) => {
    const v = value as { buffer?: boolean; type?: string; data?: unknown; value?: unknown };
    if (typeof value === "object" && value !== null && (v.buffer === true || v.type === "Buffer")) {
      const raw = v.data ?? v.value;
      return typeof raw === "string"
        ? Buffer.from(raw, "base64")
        : Buffer.from((raw as number[]) ?? []);
    }
    return value;
  },
};

export async function useDynamoDBAuthState(
  db: DynamoDB,
  tableName: string
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearCreds: () => Promise<void>;
}> {
  const writeData = (data: unknown, id: string) =>
    db
      .put({
        TableName: tableName,
        Item: { id, ...JSON.parse(JSON.stringify(data, BufferJSON.replacer)) },
      })
      .promise();

  const readData = async (id: string): Promise<unknown> => {
    try {
      const result = await db.get({ TableName: tableName, Key: { id } }).promise();
      return result.Item
        ? JSON.parse(JSON.stringify(result.Item), BufferJSON.reviver)
        : null;
    } catch {
      return null;
    }
  };

  const removeData = async (id: string): Promise<void> => {
    try {
      await db.delete({ TableName: tableName, Key: { id } }).promise();
    } catch (err) {
      console.error("[DynamoAuth] Failed to delete key:", id, err);
    }
  };

  const creds = ((await readData("creds")) as AuthenticationState["creds"] | null) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]): Promise<any> => {
          const data: Record<string, unknown> = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData(`${type}-${id}`);
              if (value) data[id] = value;
            })
          );
          return data;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          const tasks: Promise<unknown>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              tasks.push(writeData(data[category][id], `${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => { await writeData(creds, "creds"); },
    clearCreds: () => removeData("creds"),
  };
}