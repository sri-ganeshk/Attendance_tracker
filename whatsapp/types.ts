/**
 * Shared domain types for the Vignan Attendance WhatsApp Bot.
 */

// ---------------------------------------------------------------------------
// DynamoDB / user data
// ---------------------------------------------------------------------------
export interface Credential {
  shortId:    string;
  rollNumber: string;
  password:   string;
}

export interface UserRecord {
  phoneNumber: string;
  credentials: Credential[];
}

// ---------------------------------------------------------------------------
// Attendance API
// ---------------------------------------------------------------------------
export interface TodayAttendanceEntry {
  subject: string;
  status:  string;
}

export interface SubjectAttendance {
  subject_name:  string;
  attended_held: string;
  percentage:    string;
}

export interface AttendanceTotals {
  total_attended:           number;
  total_held:               number;
  total_percentage:         number;
  hours_can_skip?:          number;
  additional_hours_needed?: number;
}

export interface AttendanceReport {
  roll_number:     string;
  today_summary:   TodayAttendanceEntry[];
  subject_summary: SubjectAttendance[];
  totals:          AttendanceTotals | null;
}

export interface SkipReport {
  original_percentage:      number;
  new_percentage:           number;
  status:                   "safe to skip" | "needs to attend more";
  hours_can_skip?:          number;
  additional_hours_needed?: number;
}