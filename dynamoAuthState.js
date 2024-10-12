const AWS = require('aws-sdk');
const { proto } = require("@whiskeysockets/baileys/WAProto");
const { Curve, signedKeyPair } = require("@whiskeysockets/baileys/lib/Utils/crypto");
const { generateRegistrationId } = require("@whiskeysockets/baileys/lib/Utils/generics");
const { randomBytes } = require("crypto");

AWS.config.update({
    region: 'ap-southeast-2', // Replace with your DynamoDB region
    // Use environment variables or IAM roles instead of hardcoding credentials
});

const dynamoDB = new AWS.DynamoDB.DocumentClient();

const initAuthCreds = () => {
    const identityKey = Curve.generateKeyPair();
    return {
        noiseKey: Curve.generateKeyPair(),
        signedIdentityKey: identityKey,
        signedPreKey: signedKeyPair(identityKey, 1),
        registrationId: generateRegistrationId(),
        advSecretKey: randomBytes(32).toString("base64"),
        processedHistoryMessages: [],
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSettings: {
            unarchiveChats: false,
        },
    };
};

const BufferJSON = {
    replacer: (k, value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === "Buffer") {
            return {
                type: "Buffer",
                data: Buffer.from(value?.data || value).toString("base64"),
            };
        }

        return value;
    },
    reviver: (_, value) => {
        if (typeof value === "object" && !!value && (value.buffer === true || value.type === "Buffer")) {
            const val = value.data || value.value;
            return typeof val === "string"
                ? Buffer.from(val, "base64")
                : Buffer.from(val || []);
        }

        return value;
    },
};

module.exports = useDynamoDBAuthState = async (authTable) => {
    const writeData = (data, id) => {
        const informationToStore = JSON.parse(
            JSON.stringify(data, BufferJSON.replacer)
        );
        return dynamoDB.put({
            TableName: authTable,
            Item: {
                id,
                ...informationToStore,
            },
        }).promise();
    };

    const readData = async (id) => {
        try {
            const result = await dynamoDB.get({
                TableName: authTable,
                Key: { id },
            }).promise();
            return JSON.parse(JSON.stringify(result.Item), BufferJSON.reviver);
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await dynamoDB.delete({
                TableName: authTable,
                Key: { id },
            }).promise();
        } catch (error) {
            console.log("Failed to delete data", error);
        }
    };

    const creds = (await readData("creds")) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    let data = {};
                    await Promise.all(ids.map(async (id) => {
                        const value = await readData(`${type}-${id}`);
                        if (value) data[id] = value;
                    }));

                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(writeData(value, key));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: async () => {
            await writeData(creds, "creds");
        },
    };
};
