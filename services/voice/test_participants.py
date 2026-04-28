"""DoD tests for GET /voice/{channelId}/participants (T-44)."""
import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from jose import jwt

JWT_SECRET = "test-secret-32-bytes-long-enough!!"
ALGORITHM = "HS256"

# Two real join timestamps to use in mocks
TS_USER_A = 1_700_000_000.0  # 2023-11-14T22:13:20+00:00
TS_USER_B = 1_700_001_000.0  # 2023-11-14T22:30:00+00:00


def make_token(user_id: str = "user-123") -> str:
    return jwt.encode(
        {"sub": user_id, "username": "testuser", "exp": int(time.time()) + 3600},
        JWT_SECRET,
        algorithm=ALGORITHM,
    )


def _make_redis_mock(rows: list[tuple[str, float]] | None = None):
    r = AsyncMock()
    r.ping = AsyncMock()
    r.zrange = AsyncMock(return_value=rows or [])
    r.close = AsyncMock()
    return r


def _client(redis_mock, perm_allowed: bool = True):
    from main import app

    ctx = [
        patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}),
        patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)),
        patch("main._check_perm", return_value=perm_allowed),
    ]
    return ctx


# ── DoD: 200 with correct shape ───────────────────────────────────────────

def test_participants_returns_200():
    from main import app
    redis_mock = _make_redis_mock([("user-A", TS_USER_A), ("user-B", TS_USER_B)])
    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=True):
                with TestClient(app) as c:
                    resp = c.get("/voice/chan-1/participants",
                                 headers={"Authorization": f"Bearer {make_token()}"})
    assert resp.status_code == 200


def test_participants_response_shape():
    from main import app
    redis_mock = _make_redis_mock([("user-A", TS_USER_A), ("user-B", TS_USER_B)])
    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=True):
                with TestClient(app) as c:
                    resp = c.get("/voice/chan-1/participants",
                                 headers={"Authorization": f"Bearer {make_token()}"})
    body = resp.json()
    assert body["channel_id"] == "chan-1"
    assert isinstance(body["participants"], list)
    assert len(body["participants"]) == 2
    for entry in body["participants"]:
        assert "user_id" in entry
        assert "joined_at" in entry


def test_participants_user_ids_match_sorted_set():
    from main import app
    redis_mock = _make_redis_mock([("user-A", TS_USER_A), ("user-B", TS_USER_B)])
    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=True):
                with TestClient(app) as c:
                    resp = c.get("/voice/chan-1/participants",
                                 headers={"Authorization": f"Bearer {make_token()}"})
    user_ids = [p["user_id"] for p in resp.json()["participants"]]
    assert "user-A" in user_ids
    assert "user-B" in user_ids


def test_participants_joined_at_is_iso8601():
    from main import app
    from datetime import datetime, timezone
    redis_mock = _make_redis_mock([("user-A", TS_USER_A)])
    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=True):
                with TestClient(app) as c:
                    resp = c.get("/voice/chan-1/participants",
                                 headers={"Authorization": f"Bearer {make_token()}"})
    joined_at = resp.json()["participants"][0]["joined_at"]
    # Must parse without error and match the stored timestamp
    parsed = datetime.fromisoformat(joined_at)
    assert parsed == datetime.fromtimestamp(TS_USER_A, tz=timezone.utc)


# ── DoD: Empty channel → {"participants": []} ─────────────────────────────

def test_participants_empty_channel():
    from main import app
    redis_mock = _make_redis_mock([])
    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=True):
                with TestClient(app) as c:
                    resp = c.get("/voice/chan-1/participants",
                                 headers={"Authorization": f"Bearer {make_token()}"})
    assert resp.status_code == 200
    assert resp.json() == {"channel_id": "chan-1", "participants": []}


# ── DoD: Permission check with action READ ────────────────────────────────

def test_participants_calls_check_perm_with_read_action():
    import check_perm_pb2
    from main import app
    redis_mock = _make_redis_mock([])
    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=True) as mock_perm:
                with TestClient(app) as c:
                    c.get("/voice/chan-1/participants",
                          headers={"Authorization": f"Bearer {make_token('user-X')}"})
    mock_perm.assert_called_once_with("user-X", "chan-1", check_perm_pb2.READ)


def test_participants_forbidden_when_read_perm_denied():
    from main import app
    redis_mock = _make_redis_mock([("user-A", TS_USER_A)])
    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=False):
                with TestClient(app) as c:
                    resp = c.get("/voice/chan-1/participants",
                                 headers={"Authorization": f"Bearer {make_token()}"})
    assert resp.status_code == 403


# ── DoD: Unauthenticated → 401 ────────────────────────────────────────────

def test_participants_unauthenticated():
    from main import app
    redis_mock = _make_redis_mock([])
    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with TestClient(app) as c:
                resp = c.get("/voice/chan-1/participants")
    assert resp.status_code == 401


# ── DoD: Live data — reads from Redis zrange ─────────────────────────────

def test_participants_reads_from_redis_zrange():
    from main import app
    redis_mock = _make_redis_mock([("user-A", TS_USER_A)])
    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=True):
                with TestClient(app) as c:
                    c.get("/voice/chan-1/participants",
                          headers={"Authorization": f"Bearer {make_token()}"})
    redis_mock.zrange.assert_called_once_with(
        "voice:channel:chan-1:users", 0, -1, withscores=True
    )
