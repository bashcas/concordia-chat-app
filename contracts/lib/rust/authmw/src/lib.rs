use jsonwebtoken::{decode, errors::ErrorKind, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct Claims {
    pub sub: String,
    pub username: Option<String>,
    pub exp: usize,
    pub iat: Option<usize>,
}

#[derive(Debug, Error, PartialEq)]
pub enum AuthError {
    #[error("JWT_SECRET not set")]
    MissingSecret,
    #[error("token expired")]
    Expired,
    #[error("invalid token")]
    Invalid,
}

/// Validate a HS256 JWT and return its claims.
/// Reads the signing secret from the `JWT_SECRET` environment variable.
pub fn validate_jwt(token: &str) -> Result<Claims, AuthError> {
    let secret = std::env::var("JWT_SECRET").map_err(|_| AuthError::MissingSecret)?;
    if secret.is_empty() {
        return Err(AuthError::MissingSecret);
    }

    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;

    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
    .map_err(|e| match e.kind() {
        ErrorKind::ExpiredSignature => AuthError::Expired,
        _ => AuthError::Invalid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now_unix() -> usize {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize
    }

    fn make_token(secret: &str, exp: usize) -> String {
        let claims = Claims {
            sub: "user-123".to_string(),
            username: Some("alice".to_string()),
            exp,
            iat: Some(now_unix()),
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    #[test]
    fn valid_token_returns_claims() {
        std::env::set_var("JWT_SECRET", "test-secret");
        let token = make_token("test-secret", now_unix() + 3600);
        let claims = validate_jwt(&token).expect("should be valid");
        assert_eq!(claims.sub, "user-123");
        assert_eq!(claims.username.as_deref(), Some("alice"));
    }

    #[test]
    fn expired_token_returns_error() {
        std::env::set_var("JWT_SECRET", "test-secret");
        let token = make_token("test-secret", now_unix() - 3600);
        assert_eq!(validate_jwt(&token), Err(AuthError::Expired));
    }

    #[test]
    fn tampered_token_returns_error() {
        std::env::set_var("JWT_SECRET", "test-secret");
        let token = make_token("test-secret", now_unix() + 3600);
        let parts: Vec<&str> = token.split('.').collect();
        let tampered = format!("{}.{}.invalidsig", parts[0], parts[1]);
        assert_eq!(validate_jwt(&tampered), Err(AuthError::Invalid));
    }
}
