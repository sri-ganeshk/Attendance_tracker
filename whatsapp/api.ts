import axios from "axios";
import type { AttendanceReport, SkipReport } from "./types";

const API_BASE_URL = process.env.API_BASE_URL!;

export async function fetchAttendanceReport(
  rollNumber: string,
  password: string
): Promise<AttendanceReport> {
  const { data } = await axios.get<AttendanceReport>(`${API_BASE_URL}/attendance`, {
    params: { student_id: rollNumber, password },
  });
  return data;
}

export async function fetchSkipReport(
  rollNumber: string,
  password: string,
  hours: number
): Promise<SkipReport> {
  const { data } = await axios.get<SkipReport>(`${API_BASE_URL}/skip`, {
    params: { student_id: rollNumber, password, hours },
  });
  return data;
}
