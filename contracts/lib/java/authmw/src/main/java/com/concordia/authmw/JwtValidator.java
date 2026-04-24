package com.concordia.authmw;

import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;

import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.Key;

public class JwtValidator {

    /**
     * Validates a HS256 JWT and returns its claims.
     * Reads the signing secret from the {@code JWT_SECRET} environment variable.
     *
     * @throws JwtValidationException if the token is missing, expired, or tampered.
     */
    public static Claims validate(String token) {
        String secret = System.getenv("JWT_SECRET");
        if (secret == null || secret.isEmpty()) {
            throw new JwtValidationException("JWT_SECRET not set");
        }

        Key key = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");

        try {
            io.jsonwebtoken.Claims jwtClaims = Jwts.parserBuilder()
                    .setSigningKey(key)
                    .build()
                    .parseClaimsJws(token)
                    .getBody();

            return new Claims(
                    jwtClaims.getSubject(),
                    jwtClaims.get("username", String.class)
            );
        } catch (ExpiredJwtException e) {
            throw new JwtValidationException("Token expired", e);
        } catch (JwtException e) {
            throw new JwtValidationException("Invalid token: " + e.getMessage(), e);
        }
    }
}
