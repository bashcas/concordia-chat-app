import time

import jwt
import pytest

from authmw import validate_jwt

SECRET = "test-secret"


def make_token(exp_offset: int = 3600, secret: str = SECRET) -> str:
    payload = {
        "sub": "user-123",
        "username": "alice",
        "exp": int(time.time()) + exp_offset,
        "iat": int(time.time()),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def test_valid_token_returns_claims(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", SECRET)
    claims = validate_jwt(make_token())
    assert claims["sub"] == "user-123"
    assert claims["username"] == "alice"


def test_expired_token_raises(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", SECRET)
    token = make_token(exp_offset=-3600)
    with pytest.raises(jwt.ExpiredSignatureError):
        validate_jwt(token)


def test_tampered_token_raises(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", SECRET)
    token = make_token()
    parts = token.split(".")
    parts[2] = "invalidsignature"
    tampered = ".".join(parts)
    with pytest.raises(jwt.InvalidTokenError):
        validate_jwt(tampered)


def test_missing_secret_raises(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    with pytest.raises(ValueError, match="JWT_SECRET not set"):
        validate_jwt(make_token())
