import os

import jwt


def validate_jwt(token: str) -> dict:
    """Validate a HS256 JWT and return its claims as a dict.

    Reads the signing secret from the JWT_SECRET environment variable.
    Raises jwt.ExpiredSignatureError if expired.
    Raises jwt.InvalidTokenError (or subclass) if the token is invalid or tampered.
    """
    secret = os.environ.get("JWT_SECRET")
    if not secret:
        raise ValueError("JWT_SECRET not set")

    return jwt.decode(token, secret, algorithms=["HS256"])
