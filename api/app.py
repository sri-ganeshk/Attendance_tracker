import logging
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any

from flask import Blueprint, Flask, Response, jsonify, request

from attendance_scraper import (
    AttendanceClientError,
    AttendanceTotals,
    VignanAttendanceClient,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

JsonResponse = tuple[Response, int]

SAFE_TO_SKIP = "safe to skip"
NEEDS_MORE_CLASSES = "needs to attend more"
MINIMUM_PERCENTAGE = 75.0

attendance_bp = Blueprint("attendance", __name__)


def create_app() -> Flask:
    app = Flask(__name__)
    app.register_blueprint(attendance_bp)
    return app


def _bad_request(message: str) -> JsonResponse:
    return jsonify({"error": message}), HTTPStatus.BAD_REQUEST


def _server_error(message: str) -> JsonResponse:
    return jsonify({"error": message}), HTTPStatus.INTERNAL_SERVER_ERROR


def _fetch_report(student_id: str, password: str):
    client = VignanAttendanceClient(student_id=student_id, password=password)
    return client.fetch_report()


def _parse_percentage(raw: str) -> float:
    try:
        return float(raw.replace("%", "").strip())
    except (ValueError, AttributeError):
        return 0.0


def _hours_status_value(totals: AttendanceTotals) -> int:
    if totals.hours_can_skip is not None:
        return totals.hours_can_skip
    if totals.additional_hours_needed is not None:
        return -totals.additional_hours_needed
    return 0


@dataclass
class _StudentResult:
    student_id: str
    error: str | None = None
    total_attended: int | None = None
    total_held: int | None = None
    total_percentage: float | None = None
    hours_status: int | None = None
    subject_points: int = 0

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"student_id": self.student_id}
        if self.error:
            d["error"] = self.error
        else:
            d.update(
                total_attended=self.total_attended,
                total_held=self.total_held,
                total_percentage=self.total_percentage,
                hours_status=self.hours_status,
                subject_points=self.subject_points,
            )
        return d


@attendance_bp.get("/attendance")
def get_attendance() -> JsonResponse:
    student_id = request.args.get("student_id", "").strip()
    password = request.args.get("password", "").strip()

    if not student_id or not password:
        return _bad_request("Missing required query parameters: student_id, password.")

    try:
        report = _fetch_report(student_id, password)
        return jsonify(report.to_dict()), HTTPStatus.OK
    except AttendanceClientError as exc:
        logger.warning("Attendance fetch failed for %s: %s", student_id, exc)
        return _bad_request(str(exc))
    except Exception:
        logger.exception("Unexpected error for student %s", student_id)
        return _server_error("An unexpected error occurred.")


@attendance_bp.post("/compare")
def compare_attendance() -> JsonResponse:
    body = request.get_json(silent=True)
    if not isinstance(body, list) or not body:
        return _bad_request("Request body must be a non-empty JSON array of student credentials.")

    student_results: list[_StudentResult] = []
    subject_scores: dict[str, list[dict[str, Any]]] = {}

    for entry in body:
        student_id = (entry.get("student_id") or "").strip()
        password = (entry.get("password") or "").strip()

        if not student_id or not password:
            student_results.append(_StudentResult(
                student_id=student_id or "unknown",
                error="Missing student_id or password.",
            ))
            continue

        try:
            report = _fetch_report(student_id, password)
        except AttendanceClientError as exc:
            logger.warning("Compare: fetch failed for %s - %s", student_id, exc)
            student_results.append(_StudentResult(student_id=student_id, error=str(exc)))
            continue

        for subject in report.subject_summary:
            percentage_value = _parse_percentage(subject.percentage)
            subject_scores.setdefault(subject.subject_name, []).append(
                {"student_id": student_id, "percentage": percentage_value}
            )

        student_results.append(_StudentResult(
            student_id=report.roll_number,
            total_attended=report.totals.total_attended if report.totals else None,
            total_held=report.totals.total_held if report.totals else None,
            total_percentage=report.totals.total_percentage if report.totals else None,
            hours_status=_hours_status_value(report.totals) if report.totals else 0,
        ))

    subject_points_summary: dict[str, dict[str, Any]] = {}
    result_index = {r.student_id: r for r in student_results if not r.error}

    for subject_name, scores in subject_scores.items():
        max_pct = max(s["percentage"] for s in scores)
        top_students = [s["student_id"] for s in scores if s["percentage"] == max_pct]

        for sid in top_students:
            if sid in result_index:
                result_index[sid].subject_points += 1

        subject_points_summary[subject_name] = {
            "max_percentage": max_pct,
            "top_students": top_students,
        }

    return jsonify({
        "students": [r.to_dict() for r in student_results],
        "subject_points_summary": subject_points_summary,
    }), HTTPStatus.OK


@attendance_bp.get("/skip")
def calculate_after_skip() -> JsonResponse:
    student_id = request.args.get("student_id", "").strip()
    password = request.args.get("password", "").strip()
    skip_hours_raw = request.args.get("hours", "").strip()

    if not student_id or not password or not skip_hours_raw:
        return _bad_request("Missing required query parameters: student_id, password, hours.")

    try:
        skip_hours = int(skip_hours_raw)
        if skip_hours < 0:
            raise ValueError
    except ValueError:
        return _bad_request("'hours' must be a non-negative integer.")

    try:
        report = _fetch_report(student_id, password)
    except AttendanceClientError as exc:
        logger.warning("Skip simulation failed for %s: %s", student_id, exc)
        return _bad_request(str(exc))

    if not report.totals:
        return _server_error("Could not retrieve attendance totals.")

    total_attended = report.totals.total_attended
    total_held = report.totals.total_held
    original_percentage = report.totals.total_percentage

    new_total_held = total_held + skip_hours
    new_percentage = round(total_attended / new_total_held * 100, 2)

    result: dict[str, Any] = {
        "original_percentage": original_percentage,
        "new_percentage": new_percentage,
    }

    if new_percentage >= MINIMUM_PERCENTAGE:
        result["status"] = SAFE_TO_SKIP
        result["hours_can_skip"] = int((total_attended - 0.75 * new_total_held) / 0.75)
    else:
        result["status"] = NEEDS_MORE_CLASSES
        result["additional_hours_needed"] = int((0.75 * new_total_held - total_attended) / (1 - 0.75))

    return jsonify(result), HTTPStatus.OK


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=False)