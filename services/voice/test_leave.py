"""DoD tests for POST /voice/{channelId}/leave and GET /voice/{channelId}/participants (T-43)."""
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from jose import jwt

JWT_SECRET = "test-secret-32-bytes-long-enough!!"
ALGORITHM = "HS256"


def make_token(user_id: str = "user-123") -> str:
    import time
    return jwt.encode(
        {"sub": user_id, "username": "testuser", "exp": int(time.time()) + 3600},
        JWT_SECRET,
        algorithm=ALGORITHM,
    )


def _make_redis_mock(members: list[tuple[str, float]] | None = None):
    r = AsyncMock()
    r.ping = AsyncMock()
    r.zrem = AsyncMock(return_value=1)
    r.delete = AsyncMock(return_value=1)
    r.zrange = AsyncMock(return_value=members or [])
    r.close = AsyncMock()
    return r


@pytest.fixture()
def client_in_channel():
    """User is currently in the channel (zrange returns their id)."""
    from main import app

    redis_mock = _make_redis_mock(members=["user-123"])

    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with TestClient(app, raise_server_exceptions=True) as c:
                yield c, redis_mock


@pytest.fixture()
def client_not_in_channel():
    """User is NOT in the channel (empty sorted set)."""
    from main import app

    redis_mock = _make_redis_mock(members=[])

    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=True):
                with TestClient(app, raise_server_exceptions=True) as c:
                    yield c, redis_mock


@pytest.fixture()
def client_multi_member():
    """Channel with multiple members, user-123 among them."""
    from main import app

    redis_mock = _make_redis_mock(members=[("user-456", 1000.0), ("user-789", 2000.0)])

    with patch.dict("os.environ", {"JWT_SECRET": JWT_SECRET}):
        with patch("main.aioredis.from_url", new=AsyncMock(return_value=redis_mock)):
            with patch("main._check_perm", return_value=True):
                with TestClient(app, raise_server_exceptions=True) as c:
                    yield c, redis_mock


# ── DoD: POST /leave with valid JWT → 204 ────────────────────────────────

def test_leave_returns_204(client_in_channel):
    c, _ = client_in_channel
    resp = c.post("/voice/chan-abc/leave", headers={"Authorization": f"Bearer {make_token()}"})
    assert resp.status_code == 204
    assert resp.content == b""


# ── DoD: User removed from Redis sorted set ──────────────────────────────

def test_leave_calls_zrem_with_correct_key(client_in_channel):
    c, redis_mock = client_in_channel
    c.post("/voice/chan-abc/leave", headers={"Authorization": f"Bearer {make_token()}"})
    redis_mock.zrem.assert_called_once_with("voice:channel:chan-abc:users", "user-123")


def test_leave_deletes_session_hash(client_in_channel):
    c, redis_mock = client_in_channel
    c.post("/voice/chan-abc/leave", headers={"Authorization": f"Bearer {make_token()}"})
    redis_mock.delete.assert_called_once_with("voice:session:chan-abc:user-123")


# ── DoD: Idempotent — not in channel → still 204 ─────────────────────────

def test_leave_idempotent_when_not_in_channel(client_not_in_channel):
    c, _ = client_not_in_channel
    resp = c.post("/voice/chan-abc/leave", headers={"Authorization": f"Bearer {make_token()}"})
    assert resp.status_code == 204


# ── DoD: Unauthenticated → 401 ────────────────────────────────────────────

def test_leave_unauthenticated(client_in_channel):
    c, _ = client_in_channel
    resp = c.post("/voice/chan-abc/leave")
    assert resp.status_code == 401


# ── DoD: GET /participants after leave does not include user ──────────────

def test_participants_does_not_include_left_user(client_multi_member):
    """After user-123 leaves, GET /participants only shows the remaining members."""
    c, redis_mock = client_multi_member
    token = make_token("user-123")

    resp = c.get("/voice/chan-abc/participants", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["channel_id"] == "chan-abc"
    user_ids = [p["user_id"] for p in body["participants"]]
    assert "user-123" not in user_ids
    assert "user-456" in user_ids
    assert "user-789" in user_ids


def test_participants_empty_after_everyone_leaves(client_not_in_channel):
    c, _ = client_not_in_channel
    resp = c.get("/voice/chan-abc/participants", headers={"Authorization": f"Bearer {make_token()}"})
    assert resp.status_code == 200
    assert resp.json()["participants"] == []


def test_participants_unauthenticated(client_in_channel):
    c, _ = client_in_channel
    resp = c.get("/voice/chan-abc/participants")
    assert resp.status_code == 401
