import "dotenv/config";
import TelegramBot, { CallbackQuery, InlineKeyboardMarkup, Message } from "node-telegram-bot-api";
import axios, { AxiosError } from "axios";
import type { AttendanceReport } from "../whatsapp/types";

if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("Missing: TELEGRAM_BOT_TOKEN");
if (!process.env.API_BASE_URL) throw new Error("Missing: API_BASE_URL");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL;

const MIN_ATTENDANCE_PCT = 75;
const IST_LOCALE = "en-IN";
const IST_TIMEZONE = "Asia/Kolkata";

interface CallbackPayload {
  a: "update";
  s: string;
  p: string;
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

async function fetchAttendanceReport(studentId: string, password: string): Promise<AttendanceReport> {
  const { data } = await axios.get<AttendanceReport>(`${API_BASE_URL}/attendance`, {
    params: { student_id: studentId, password },
  });
  return data;
}

function buildAttendanceMessage(report: AttendanceReport, updatedAt?: string): string {
  const { roll_number, totals, today_summary, subject_summary } = report;
  const lines: string[] = [];

  lines.push(`👤 Roll Number: *${roll_number}*`);

  if (totals) {
    lines.push(`📊 Total: ${totals.total_attended}/${totals.total_held} (*${totals.total_percentage}%*)`);
    if (totals.total_percentage < MIN_ATTENDANCE_PCT) {
      lines.push(`⚠️ You need to attend *${totals.additional_hours_needed}* more class(es) to reach ${MIN_ATTENDANCE_PCT}%.`);
    } else {
      lines.push(`✅ You can skip *${totals.hours_can_skip}* class(es) and still stay above ${MIN_ATTENDANCE_PCT}%.`);
    }
  }

  const hasTodayData = today_summary.length > 0 && Boolean(today_summary[0].subject);
  if (hasTodayData) {
    lines.push("\n📅 *Today's Attendance:*");
    for (const entry of today_summary) {
      const icon = entry.status === "P" ? "✅" : entry.status === "A" ? "❌" : "➖";
      lines.push(`  ${icon} ${entry.subject}: ${entry.status}`);
    }
  } else {
    lines.push(`\nℹ️ ${today_summary[0]?.status ?? "Today's attendance not posted."}`);
  }

  lines.push("\n📚 *Subject-wise Attendance:*");
  for (const subject of subject_summary) {
    const pct = parseFloat(subject.percentage);
    const icon = pct >= MIN_ATTENDANCE_PCT ? "✅" : "⚠️";
    lines.push(`  ${icon} ${subject.subject_name}: ${subject.attended_held} (${subject.percentage}%)`);
  }

  if (updatedAt) lines.push(`\n🕐 _Last updated: ${updatedAt}_`);

  return lines.join("\n");
}

function buildUpdateKeyboard(studentId: string, password: string): InlineKeyboardMarkup {
  const payload: CallbackPayload = { a: "update", s: studentId, p: password };
  return {
    inline_keyboard: [[{ text: "🔄 Update Attendance", callback_data: JSON.stringify(payload) }]],
  };
}

function isAxiosError(err: unknown): err is AxiosError {
  return axios.isAxiosError(err);
}

function isMessageUnmodifiedError(err: unknown): boolean {
  if (!isAxiosError(err)) return false;
  const description = (err.response?.data as Record<string, unknown>)?.description;
  return typeof description === "string" && description.includes("message is not modified");
}

async function sendAttendanceMessage(chatId: number, studentId: string, password: string): Promise<void> {
  try {
    const report = await fetchAttendanceReport(studentId, password);
    await bot.sendMessage(chatId, buildAttendanceMessage(report), {
      parse_mode: "Markdown",
      reply_markup: buildUpdateKeyboard(studentId, password),
    });
  } catch (err) {
    const detail = isAxiosError(err) ? err.response?.data ?? err.message : String(err);
    console.error("[Bot] sendAttendanceMessage error:", detail);
    await bot.sendMessage(chatId, "❌ Failed to fetch attendance data. Please try again.");
  }
}

async function refreshAttendanceMessage(
  chatId: number,
  messageId: number,
  studentId: string,
  password: string
): Promise<void> {
  try {
    const report = await fetchAttendanceReport(studentId, password);
    const updatedAt = new Date().toLocaleString(IST_LOCALE, { timeZone: IST_TIMEZONE });
    await bot.editMessageText(buildAttendanceMessage(report, updatedAt), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: buildUpdateKeyboard(studentId, password),
    });
  } catch (err) {
    if (isMessageUnmodifiedError(err)) return;
    const detail = isAxiosError(err) ? err.response?.data ?? err.message : String(err);
    console.error("[Bot] refreshAttendanceMessage error:", detail);
    await bot.editMessageText("❌ Failed to refresh attendance data.", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
}

bot.onText(/\/start/, async (msg: Message) => {
  await bot.sendMessage(
    msg.chat.id,
    "👋 *Welcome to the Vignan IT Attendance Bot!*\n\nUsage:\n`/get <student_id> <password>`\n\nExample:\n`/get 22L31A0596 mypassword`",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/get (.+)/, async (msg: Message, match: RegExpExecArray | null) => {
  const parts = match?.[1]?.trim().split(/\s+/) ?? [];
  if (parts.length < 2) {
    await bot.sendMessage(msg.chat.id, "⚠️ Usage: `/get <student_id> <password>`", { parse_mode: "Markdown" });
    return;
  }
  await sendAttendanceMessage(msg.chat.id, parts[0], parts[1]);
});

bot.on("callback_query", async (callbackQuery: CallbackQuery) => {
  const { message, id: queryId, data: rawData } = callbackQuery;

  if (!message) {
    await bot.answerCallbackQuery(queryId, { text: "Invalid callback." });
    return;
  }

  let payload: CallbackPayload;
  try {
    payload = JSON.parse(rawData ?? "{}") as CallbackPayload;
  } catch {
    await bot.answerCallbackQuery(queryId, { text: "Malformed callback data." });
    return;
  }

  if (payload.a === "update") {
    await bot.answerCallbackQuery(queryId, { text: "⏳ Updating attendance…" });
    await refreshAttendanceMessage(message.chat.id, message.message_id, payload.s, payload.p);
    return;
  }

  await bot.answerCallbackQuery(queryId, { text: "Unknown action." });
});

process.once("SIGINT",  () => { bot.stopPolling(); process.exit(0); });
process.once("SIGTERM", () => { bot.stopPolling(); process.exit(0); });

console.info("🤖 Vignan Attendance Bot is running…");