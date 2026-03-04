import type { AttendanceReport, SkipReport } from "./types";

const MIN_ATTENDANCE_PCT = 75;
const HELP_DOC_LINK =
  "https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing";

export function buildAttendanceMessage(report: AttendanceReport): string {
  const { roll_number, totals, today_summary, subject_summary } = report;
  const lines: string[] = [];

  lines.push(`👤 Roll Number: *${roll_number}*`);

  if (totals) {
    lines.push(`📊 Total: ${totals.total_attended}/${totals.total_held} (*${totals.total_percentage}%*)`);
    if (totals.total_percentage < MIN_ATTENDANCE_PCT) {
      lines.push(`⚠️ You need *${totals.additional_hours_needed}* more class(es) to reach ${MIN_ATTENDANCE_PCT}%.`);
    } else {
      lines.push(`✅ You can skip *${totals.hours_can_skip}* class(es) and stay above ${MIN_ATTENDANCE_PCT}%.`);
    }
  }

  const hasToday = today_summary.length > 0 && Boolean(today_summary[0].subject);
  if (hasToday) {
    lines.push("\n📅 *Today's Attendance:*");
    for (const entry of today_summary) {
      const icon = entry.status === "P" ? "✅" : entry.status === "A" ? "❌" : "➖";
      lines.push(`  ${icon} ${entry.subject}: ${entry.status}`);
    }
  } else {
    lines.push(`\nℹ️ ${today_summary[0]?.status ?? "Today's attendance not posted."}`);
  }

  lines.push("\n📚 *Subject-wise Attendance:*");
  for (const s of subject_summary) {
    const pct = parseFloat(s.percentage);
    const icon = pct >= MIN_ATTENDANCE_PCT ? "✅" : "⚠️";
    lines.push(`  ${icon} ${s.subject_name}: ${s.attended_held} (${s.percentage}%)`);
  }

  return lines.join("\n");
}

export function buildSkipMessage(report: SkipReport, hours: number): string {
  const lines = [
    `✨ *Skip Simulation — ${hours} class(es)* ✨`,
    ``,
    `📊 Original: *${report.original_percentage}%*`,
    `📊 After skip: *${report.new_percentage}%*`,
    `Status: ${report.status}`,
  ];
  if (report.status === "safe to skip") {
    lines.push(`\n👍 You can still skip *${report.hours_can_skip}* more class(es).`);
  } else {
    lines.push(`\n📚 You need *${report.additional_hours_needed}* more class(es) to reach ${MIN_ATTENDANCE_PCT}%.`);
  }
  return lines.join("\n");
}

export function buildHelpMessage(): string {
  return [
    `👋 *Welcome to the Vignan Attendance Bot!*`,
    ``,
    `*Quick Lookup*`,
    `\`22L31A0596 mypassword\``,
    ``,
    `*Save a short form*`,
    `\`set <shortId> <rollNumber> <password>\``,
    ``,
    `*Use a short form*`,
    `\`596\``,
    ``,
    `*View saved short forms*`,
    `\`shortforms\``,
    ``,
    `*Delete a short form*`,
    `\`delete <shortId>\``,
    ``,
    `*Skip simulation*`,
    `\`skip <shortId> <hours>\``,
    ``,
    `📖 Help: ${HELP_DOC_LINK}`,
  ].join("\n");
}
