import "dotenv/config";
import AWS from "aws-sdk";
import makeWASocket, { DisconnectReason, type ConnectionState } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";
import { useDynamoDBAuthState } from "./dynamoAuthState";
import {
  handleDirectLookup,
  handleSetCommand,
  handleDeleteCommand,
  handleShowShortForms,
  handleSkipCommand,
  handleShortFormLookup,
} from "./commands";

if (!process.env.API_BASE_URL) throw new Error("Missing required environment variable: API_BASE_URL");
if (!process.env.AWS_REGION)   throw new Error("Missing required environment variable: AWS_REGION");

const AUTH_TABLE  = process.env.DYNAMODB_AUTH_TABLE;
const RECONNECT_DELAY = 3_000;

const db = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION });

async function routeMessage(sock: ReturnType<typeof makeWASocket>, message: WAMessage): Promise<void> {
  if (message.key.fromMe) return;

  const text =
    message.message?.conversation?.trim() ||
    message.message?.extendedTextMessage?.text?.trim();
  const from = message.key.remoteJid!;

  if (!text) return;

  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase();

  if (parts.length === 2 && /^\d/.test(parts[0])) {
    return handleDirectLookup(sock, from, parts[0], parts[1]);
  }

  switch (command) {
    case "set":        return handleSetCommand(sock, from, parts);
    case "delete":     return handleDeleteCommand(sock, from, parts);
    case "shortforms": return handleShowShortForms(sock, from);
    case "skip":       return handleSkipCommand(sock, from, parts);
    default:           return handleShortFormLookup(sock, from, text.trim());
  }
}

async function startBot(): Promise<void> {
  const { state, saveCreds, clearCreds } = await useDynamoDBAuthState(db, AUTH_TABLE);

  const sock = makeWASocket({ printQRInTerminal: true, auth: state });

  sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.info("[Bot] WhatsApp connected ✅");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })
        ?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.warn("[Bot] Logged out. Clearing credentials and restarting…");
        await clearCreds();
      } else {
        console.warn(`[Bot] Disconnected (${statusCode}). Reconnecting in ${RECONNECT_DELAY}ms…`);
      }
      setTimeout(startBot, RECONNECT_DELAY);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }: { messages: WAMessage[] }) => {
    const [message] = messages;
    if (!message) return;
    try {
      await routeMessage(sock, message);
    } catch (err) {
      console.error("[Bot] Unhandled error:", err);
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

process.once("SIGINT",  () => { console.info("[Bot] Shutting down…"); process.exit(0); });
process.once("SIGTERM", () => { console.info("[Bot] Shutting down…"); process.exit(0); });

startBot().catch((err) => {
  console.error("[Bot] Fatal startup error:", err);
  process.exit(1);
});