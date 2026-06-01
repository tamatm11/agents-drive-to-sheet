import pytest

from app import agent


def test_safe_drive_ids_accept_raw_ids():
    assert agent._require_safe_id(" 1abcDEF_ghi-123 ", "teacher_id") == "1abcDEF_ghi-123"


def test_safe_drive_ids_reject_urls_and_shell_text():
    with pytest.raises(ValueError):
        agent._require_safe_id("https://drive.google.com/file/d/1abc/view", "teacher_id")
    with pytest.raises(ValueError):
        agent._require_safe_id("abc; rm -rf /", "teacher_id")


def test_run_id_is_sanitized_by_rejection():
    assert agent._require_run_id("codex.sync-20260531_01") == "codex.sync-20260531_01"
    with pytest.raises(ValueError):
        agent._require_run_id("sync/2026/05/31")
