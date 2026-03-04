import base64
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import requests
from bs4 import BeautifulSoup
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

BASE_URL = "https://webprosindia.com/vignanit"
LOGIN_URL = f"{BASE_URL}/default.aspx"
ATTENDANCE_URL = f"{BASE_URL}/Academics/studentacadamicregister.aspx"
PROFILE_AJAX_URL = (
    f"{BASE_URL}/ajax/StudentProfile,"
    "App_Web_studentprofile.aspx.a2a1b31c.ashx"
)
PROFILE_REFERER = f"{BASE_URL}/Academics/StudentProfile.aspx?scrid=17"

AES_KEY: str = "8701661282118308"
AES_IV: str = "8701661282118308"

MINIMUM_ATTENDANCE_PERCENTAGE: float = 75.0
REQUEST_TIMEOUT_SECONDS: int = 15

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    )
}


@dataclass
class SubjectAttendance:
    subject_name: str
    attended_held: str
    percentage: str


@dataclass
class TodayAttendance:
    subject: str
    status: str


@dataclass
class AttendanceTotals:
    total_attended: int
    total_held: int
    total_percentage: float
    hours_can_skip: Optional[int] = None
    additional_hours_needed: Optional[int] = None


@dataclass
class AttendanceReport:
    roll_number: str
    today_summary: list[TodayAttendance] = field(default_factory=list)
    subject_summary: list[SubjectAttendance] = field(default_factory=list)
    totals: Optional[AttendanceTotals] = None

    def to_dict(self) -> dict:
        return {
            "roll_number": self.roll_number,
            "today_summary": [vars(t) for t in self.today_summary],
            "subject_summary": [vars(s) for s in self.subject_summary],
            "totals": vars(self.totals) if self.totals else None,
        }

    def to_json(self, indent: int = 4) -> str:
        return json.dumps(self.to_dict(), indent=indent)


class AttendanceClientError(Exception):
    pass

class LoginFailedError(AttendanceClientError):
    pass

class AttendanceFetchError(AttendanceClientError):
    pass

class ProfileFetchError(AttendanceClientError):
    pass


class VignanAttendanceClient:
    """
    Authenticates against the Vignan IT portal and retrieves attendance data.

    >>> client = VignanAttendanceClient(student_id="22BQ1A0501", password="secret")
    >>> report  = client.fetch_report()
    >>> print(report.to_json())
    """

    def __init__(self, student_id: str, password: str) -> None:
        if not student_id or not password:
            raise ValueError("student_id and password must not be empty.")
        self._student_id: str = student_id
        self._password: str = password
        self._session: requests.Session = requests.Session()
        self._session.headers.update(DEFAULT_HEADERS)
        self._session_id: Optional[str] = None
        self._auth_cookie: Optional[str] = None

    def fetch_report(self) -> AttendanceReport:
        logger.info("Starting attendance fetch for student: %s", self._student_id)
        self._login()
        roll_number, today_summary, subject_summary = self._fetch_attendance()
        totals = self._fetch_profile_totals()
        logger.info("Report assembled successfully for %s", roll_number)
        return AttendanceReport(
            roll_number=roll_number,
            today_summary=today_summary,
            subject_summary=subject_summary,
            totals=totals,
        )

    def _login(self) -> None:
        login_page_response = self._session.get(LOGIN_URL, timeout=REQUEST_TIMEOUT_SECONDS)
        login_page_response.raise_for_status()

        form_fields = self._extract_aspnet_form_fields(login_page_response.text)
        encrypted_password = self._encrypt_password(self._password)

        form_payload = {
            **form_fields,
            "txtId2": self._student_id,
            "txtPwd2": self._password,
            "imgBtn2.x": "0",
            "imgBtn2.y": "0",
            "hdnpwd2": encrypted_password,
        }

        login_response = self._session.post(
            LOGIN_URL,
            data=form_payload,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": BASE_URL,
                "Referer": LOGIN_URL,
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        login_response.raise_for_status()

        cookies = self._session.cookies.get_dict()
        self._auth_cookie = cookies.get("frmAuth")
        self._session_id = cookies.get("ASP.NET_SessionId")

        if not (self._auth_cookie and self._session_id):
            raise LoginFailedError(
                "Login failed: session cookies were not set. Check student ID and password."
            )
        logger.info("Login successful.")

    def _fetch_attendance(self) -> tuple[str, list[TodayAttendance], list[SubjectAttendance]]:
        response = self._session.get(
            ATTENDANCE_URL,
            headers=self._authenticated_headers(referer=f"{BASE_URL}/StudentMaster.aspx"),
            params={"scrid": 2},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )

        if response.status_code != 200:
            raise AttendanceFetchError(f"Attendance page returned HTTP {response.status_code}.")

        raw_rows = self._parse_attendance_table(response.text)

        if len(raw_rows) < 4:
            raise AttendanceFetchError("Attendance table structure is unexpected — too few rows.")

        roll_number = raw_rows[3][1].replace("\u00a0", "").strip()
        cleaned_rows = [
            [cell.replace("\xa0", "").strip() for cell in row]
            for row in raw_rows[7:]
        ]

        today_label = datetime.today().strftime("%d/%m")
        today_summary = self._extract_today_summary(cleaned_rows, today_label)
        subject_summary = self._extract_subject_summary(cleaned_rows)

        return roll_number, today_summary, subject_summary

    @staticmethod
    def _parse_attendance_table(html: str) -> list[list[str]]:
        soup = BeautifulSoup(html, "html.parser")
        table = soup.select_one("#tblReport table")
        if not table:
            raise AttendanceFetchError("Could not locate attendance table in HTML.")
        return [
            [cell.get_text(strip=True) for cell in row.find_all("td")]
            for row in table.find_all("tr")
        ]

    @staticmethod
    def _extract_today_summary(cleaned_rows: list[list[str]], today_label: str) -> list[TodayAttendance]:
        header_row = cleaned_rows[0] if cleaned_rows else []

        if today_label not in header_row:
            return [TodayAttendance(subject="-", status=f"Attendance for {today_label} has not been posted yet.")]

        today_col_index = header_row.index(today_label)
        today_entries: list[TodayAttendance] = []

        for row in cleaned_rows[1:]:
            if len(row) <= today_col_index:
                continue
            subject_name = row[1]
            status_for_today = row[today_col_index]
            if status_for_today != "-":
                today_entries.append(TodayAttendance(subject=subject_name, status=status_for_today))

        if not today_entries:
            today_entries.append(TodayAttendance(subject="-", status=f"Attendance for {today_label} has not been posted yet."))

        return today_entries

    @staticmethod
    def _extract_subject_summary(cleaned_rows: list[list[str]]) -> list[SubjectAttendance]:
        subject_entries: list[SubjectAttendance] = []
        for row in cleaned_rows[1:]:
            if len(row) < 3:
                continue
            subject_name = row[1]
            attended_held = row[-2]
            percentage = row[-1]
            if attended_held and attended_held != "0/0":
                subject_entries.append(SubjectAttendance(
                    subject_name=subject_name,
                    attended_held=attended_held,
                    percentage=percentage,
                ))
        return subject_entries

    def _fetch_profile_totals(self) -> AttendanceTotals:
        response = self._session.post(
            PROFILE_AJAX_URL,
            params={"_method": "ShowStudentProfileNew", "_session": "rw"},
            headers={
                **self._authenticated_headers(referer=PROFILE_REFERER),
                "Accept": "*/*",
                "Content-Type": "text/plain;charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
            },
            data=f"RollNo={self._student_id}\nisImageDisplay=false",
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()

        total_held, total_attended = self._parse_profile_totals(response.text)

        if total_held == 0:
            raise ProfileFetchError("Total held classes is zero — cannot compute percentage.")

        total_percentage = round(total_attended / total_held * 100, 2)
        totals = AttendanceTotals(
            total_attended=total_attended,
            total_held=total_held,
            total_percentage=total_percentage,
        )
        self._annotate_skip_or_needed(totals)
        return totals

    @staticmethod
    def _parse_profile_totals(html: str) -> tuple[int, int]:
        clean_html = html.replace("\\'", "'")
        prof_soup = BeautifulSoup(clean_html, "html.parser")
        att_table = prof_soup.find("table", class_="cellBorder")

        if not att_table:
            raise ProfileFetchError("Attendance summary table not found in profile response.")

        total_row = next(
            (
                row for row in att_table.find_all("tr")
                if "reportHeading2WithBackground" in row.get("class", [])
                and "TOTAL" in row.get_text()
            ),
            None,
        )

        if not total_row:
            raise ProfileFetchError("TOTAL row not found in attendance summary table.")

        cells = total_row.find_all("td")
        if len(cells) < 3:
            raise ProfileFetchError("TOTAL row does not have enough columns.")

        total_held = int(cells[1].get_text(strip=True))
        total_attended = int(cells[2].get_text(strip=True))
        return total_held, total_attended

    @staticmethod
    def _annotate_skip_or_needed(totals: AttendanceTotals) -> None:
        threshold = MINIMUM_ATTENDANCE_PERCENTAGE / 100
        if totals.total_percentage < MINIMUM_ATTENDANCE_PERCENTAGE:
            additional = (threshold * totals.total_held - totals.total_attended) / (1 - threshold)
            totals.additional_hours_needed = max(0, int(additional) + 1)
        else:
            can_skip = (totals.total_attended - threshold * totals.total_held) / threshold
            totals.hours_can_skip = max(0, int(can_skip))

    @staticmethod
    def _encrypt_password(plaintext: str) -> str:
        cipher = AES.new(AES_KEY.encode(), AES.MODE_CBC, AES_IV.encode())
        padded = pad(plaintext.encode("utf-8"), AES.block_size)
        encrypted_bytes = cipher.encrypt(padded)
        return base64.b64encode(encrypted_bytes).decode("utf-8")

    @staticmethod
    def _extract_aspnet_form_fields(html: str) -> dict[str, str]:
        soup = BeautifulSoup(html, "html.parser")
        fields = ("__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION")
        extracted: dict[str, str] = {}
        for field_name in fields:
            element = soup.find("input", {"name": field_name})
            if element is None:
                raise LoginFailedError(f"Required form field '{field_name}' not found on login page.")
            extracted[field_name] = element["value"]
        return extracted

    def _authenticated_headers(self, referer: str) -> dict[str, str]:
        return {
            "Cookie": f"ASP.NET_SessionId={self._session_id}; frmAuth={self._auth_cookie}",
            "Referer": referer,
        }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Fetch attendance from the Vignan IT portal.")
    parser.add_argument("student_id", help="Student roll number / login ID")
    parser.add_argument("password", help="Portal password")
    args = parser.parse_args()

    try:
        client = VignanAttendanceClient(student_id=args.student_id, password=args.password)
        report = client.fetch_report()
        print(report.to_json())
    except AttendanceClientError as exc:
        logger.error("Client error: %s", exc)
        raise SystemExit(1) from exc
    except requests.RequestException as exc:
        logger.error("Network error: %s", exc)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()