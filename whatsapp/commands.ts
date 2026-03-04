import type { WASocket } from "@whiskeysockets/baileys";
import { fetchAttendanceReport, fetchSkipReport } from "./api";
import { getUser, saveUser } from "./db";
import { buildAttendanceMessage, buildHelpMessage, buildSkipMessage } from "./messages";

const HELP_DOC_LINK =
  "https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing";

async function send(sock: WASocket, to: string, text: string): Promise<void> {
  try {
    await sock.sendMessage(to, { text });
  } catch (err) {
    console.error("[Bot] Failed to send message to", to, err);
  }
}

export async function handleDirectLookup(
  sock: WASocket,
  from: string,
  rollNumber: string,
  password: string
): Promise<void> {
  try {
    const report = await fetchAttendanceReport(rollNumber, password);
    await send(sock, from, buildAttendanceMessage(report));
  } catch {
    await send(sock, from, `❌ Invalid roll number or password.\n\nFor help: ${HELP_DOC_LINK}`);
  }
}

export async function handleSetCommand(
  sock: WASocket,
  from: string,
  parts: string[]
): Promise<void> {
  if (parts.length < 4) {
    await send(sock, from, `❌ Usage: \`set <shortId> <rollNumber> <password>\`\n\nFor help: ${HELP_DOC_LINK}`);
    return;
  }

  const [, shortId, rollNumber, password] = parts;

  try {
    await fetchAttendanceReport(rollNumber, password);
  } catch {
    await send(sock, from, "❌ Invalid roll number or password. Please try again.");
    return;
  }

  const user = (await getUser(from)) ?? { phoneNumber: from, credentials: [] };

  const duplicateRoll = user.credentials.find((c) => c.rollNumber === rollNumber);
  if (duplicateRoll) {
    await send(
      sock,
      from,
      `⚠️ This roll number is already saved as *${duplicateRoll.shortId}*.\nTo replace it: \`delete ${duplicateRoll.shortId}\``
    );
    return;
  }

  const existing = user.credentials.find((c) => c.shortId === shortId);
  if (existing) {
    existing.rollNumber = rollNumber;
    existing.password = password;
    await send(sock, from, `✅ Short form *${shortId}* updated.`);
  } else {
    user.credentials.push({ shortId, rollNumber, password });
    await send(sock, from, `✅ Short form *${shortId}* saved! Type \`shortforms\` to view all.`);
  }

  await saveUser(user);
}

export async function handleDeleteCommand(
  sock: WASocket,
  from: string,
  parts: string[]
): Promise<void> {
  const shortId = parts[1]?.trim();
  if (!shortId) {
    await send(sock, from, `❌ Usage: \`delete <shortId>\`\n\nFor help: ${HELP_DOC_LINK}`);
    return;
  }

  const user = await getUser(from);
  if (!user?.credentials?.length) {
    await send(sock, from, `❌ You have no saved short forms.`);
    return;
  }

  const updated = user.credentials.filter((c) => c.shortId !== shortId);
  if (updated.length === user.credentials.length) {
    await send(sock, from, `❌ No short form found with ID: *${shortId}*`);
    return;
  }

  user.credentials = updated;
  await saveUser(user);
  await send(sock, from, `✅ Short form *${shortId}* deleted.`);
}

export async function handleShowShortForms(sock: WASocket, from: string): Promise<void> {
  const user = await getUser(from);
  if (!user?.credentials?.length) {
    await send(sock, from, `❌ You have no saved short forms.`);
    return;
  }

  const lines = [
    "📋 *Your Saved Short Forms:*",
    ...user.credentials.map((c) => `  • *${c.shortId}* → ${c.rollNumber}`),
    ``,
    `To delete: \`delete <shortId>\``,
  ];
  await send(sock, from, lines.join("\n"));
}

export async function handleSkipCommand(
  sock: WASocket,
  from: string,
  parts: string[]
): Promise<void> {
  if (parts.length < 3) {
    await send(sock, from, `❌ Usage: \`skip <shortId> <hours>\``);
    return;
  }

  const [, shortId, hoursRaw] = parts;
  const hours = parseInt(hoursRaw, 10);

  if (isNaN(hours) || hours < 0) {
    await send(sock, from, "❌ Hours must be a non-negative number.");
    return;
  }

  const user = await getUser(from);
  const cred = user?.credentials.find((c) => c.shortId === shortId);
  if (!cred) {
    await send(sock, from, `❌ No short form found with ID: *${shortId}*`);
    return;
  }

  try {
    const report = await fetchSkipReport(cred.rollNumber, cred.password, hours);
    await send(sock, from, buildSkipMessage(report, hours));
  } catch {
    await send(sock, from, "❌ Failed to fetch skip simulation. Please try again.");
  }
}

export async function handleShortFormLookup(
  sock: WASocket,
  from: string,
  shortId: string
): Promise<void> {
  const user = await getUser(from);
  const cred = user?.credentials.find((c) => c.shortId === shortId);

  if (!cred) {
    await send(sock, from, buildHelpMessage());
    return;
  }

  await handleDirectLookup(sock, from, cred.rollNumber, cred.password);
}
