"""ADK wrapper around the adaptive-drive-to-sheet Node pipeline.

The Node scripts in ``tool/`` remain the source of truth.  This ADK app exposes
guarded tool functions so ``agents-cli run`` and ``agents-cli eval`` can drive
the same pipeline without replacing existing Claude/subagent workflows.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from google.adk.agents import Agent
from google.adk.apps import App


ROOT_DIR = Path(__file__).resolve().parents[1]
TOOL_DIR = ROOT_DIR / "tool"
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
SAFE_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


def _require_safe_id(value: str, field: str) -> str:
    value = str(value or "").strip()
    if not SAFE_ID_RE.fullmatch(value):
        raise ValueError(f"{field} must be a raw Drive/Sheets id-like value.")
    return value


def _require_run_id(value: str) -> str:
    value = str(value or "").strip()
    if not SAFE_RUN_ID_RE.fullmatch(value):
        raise ValueError("run_id is required and may contain only letters, numbers, dot, dash, or underscore.")
    return value


def _run_node(args: list[str], timeout_seconds: int = 600) -> dict[str, Any]:
    """Run a local Node script without shell expansion and parse JSON_SUMMARY."""
    command = ["node", *args]
    completed = subprocess.run(
        command,
        cwd=ROOT_DIR,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    output = f"{completed.stdout}\n{completed.stderr}".strip()
    summary = None
    for line in reversed(output.splitlines()):
        if line.startswith("JSON_SUMMARY "):
            try:
                summary = json.loads(line[len("JSON_SUMMARY ") :])
            except json.JSONDecodeError:
                summary = None
            break
    return {
        "ok": completed.returncode == 0,
        "exit_code": completed.returncode,
        "command": command,
        "summary": summary,
        "stdout_tail": "\n".join(completed.stdout.splitlines()[-80:]),
        "stderr_tail": "\n".join(completed.stderr.splitlines()[-80:]),
    }


def preview_batch_changes(
    run_id: str,
    limit: int = 0,
    subject: str = "",
    teacher_id: str = "",
    no_auto_refresh: bool = True,
) -> dict[str, Any]:
    """Preview batch changes with sync-many without writing to Google Sheets.

    Args:
        run_id: Stable run id for logging/resume.
        limit: Optional maximum number of ready pairs to preview. Use 0 for all.
        subject: Optional subject-name substring filter.
        teacher_id: Optional teacher folder id filter.
        no_auto_refresh: If true, skip Drive auto-refresh during preview.

    Returns:
        Command result plus parsed JSON_SUMMARY when available.
    """
    run_id = _require_run_id(run_id)
    args = ["tool/sync-many.js", "--list-changes", "--run-id", run_id, "--json-summary"]
    if limit and int(limit) > 0:
        args.extend(["--limit", str(int(limit))])
    if subject:
        args.extend(["--subject", str(subject)])
    if teacher_id:
        args.extend(["--teacher", _require_safe_id(teacher_id, "teacher_id")])
    if no_auto_refresh:
        args.append("--no-auto-refresh")
    return _run_node(args)


def preview_teacher_changes(
    teacher_id: str,
    spreadsheet_id: str,
    run_id: str,
    no_auto_refresh: bool = True,
) -> dict[str, Any]:
    """Preview one teacher/sheet pair without writing."""
    teacher_id = _require_safe_id(teacher_id, "teacher_id")
    spreadsheet_id = _require_safe_id(spreadsheet_id, "spreadsheet_id")
    run_id = _require_run_id(run_id)
    args = [
        "tool/render.js",
        "--teacher",
        teacher_id,
        "--sheet",
        spreadsheet_id,
        "--list-changes",
        "--run-id",
        run_id,
        "--json-summary",
    ]
    if no_auto_refresh:
        args.append("--no-auto-refresh")
    return _run_node(args)


def verify_rendered_sheet(teacher_id: str, spreadsheet_id: str) -> dict[str, Any]:
    """Readback-verify rendered tabs without writing."""
    teacher_id = _require_safe_id(teacher_id, "teacher_id")
    spreadsheet_id = _require_safe_id(spreadsheet_id, "spreadsheet_id")
    return _run_node(
        [
            "tool/render.js",
            "--teacher",
            teacher_id,
            "--sheet",
            spreadsheet_id,
            "--verify-only",
            "--json-summary",
        ],
    )


def sync_existing_sheet(
    teacher_id: str,
    spreadsheet_id: str,
    run_id: str,
    allow_preserve_risk: bool = False,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Sync exactly one existing mapped spreadsheet.

    Use only after a successful preview. This function never creates a new
    spreadsheet; ``spreadsheet_id`` is mandatory.
    """
    teacher_id = _require_safe_id(teacher_id, "teacher_id")
    spreadsheet_id = _require_safe_id(spreadsheet_id, "spreadsheet_id")
    run_id = _require_run_id(run_id)
    args = [
        "tool/render.js",
        "--teacher",
        teacher_id,
        "--sheet",
        spreadsheet_id,
        "--sync",
        "--run-id",
        run_id,
        "--json-summary",
    ]
    if allow_preserve_risk:
        args.append("--allow-preserve-risk")
    if force_refresh:
        args.append("--force-refresh")
    return _run_node(args, timeout_seconds=900)


def run_unit_tests() -> dict[str, Any]:
    """Run the offline Node unit test suite."""
    completed = subprocess.run(
        ["npm", "test", "--prefix", "tool"],
        cwd=ROOT_DIR,
        check=False,
        capture_output=True,
        text=True,
        timeout=180,
    )
    return {
        "ok": completed.returncode == 0,
        "exit_code": completed.returncode,
        "stdout_tail": "\n".join(completed.stdout.splitlines()[-80:]),
        "stderr_tail": "\n".join(completed.stderr.splitlines()[-80:]),
    }


def run_smoke_tests() -> dict[str, Any]:
    """Run the live read-only/auth smoke checks."""
    return _run_node(["tool/test-smoke.js"], timeout_seconds=180)


INSTRUCTION = """
You are the ADK wrapper for adaptive-drive-to-sheet.

The Node pipeline in tool/ remains the source of truth. Use tools instead of
inventing shell commands. Never create a new Google Sheet for this workflow;
use existing spreadsheet_id values from the pair manifest or explicit user
input. For batch or risky operations, preview first with preview_batch_changes
or preview_teacher_changes. Sync is allowed only for an existing spreadsheet_id
and should follow a clean preview. If preserveRisks appear in a summary, stop
and explain the risk unless the user explicitly asks to override with
allow_preserve_risk after manual review.

Keep responses concise, grounded in tool output, and include exact run ids or
sheet ids you used. Verify-only and tests are non-mutating; sync_existing_sheet
is mutating.
"""


root_agent = Agent(
    name="adaptive_drive_to_sheet",
    model="gemini-flash-latest",
    instruction=INSTRUCTION,
    tools=[
        preview_batch_changes,
        preview_teacher_changes,
        verify_rendered_sheet,
        sync_existing_sheet,
        run_unit_tests,
        run_smoke_tests,
    ],
)

app = App(root_agent=root_agent, name="app")
