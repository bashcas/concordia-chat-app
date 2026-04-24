package com.concordia.authmw;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.SignatureAlgorithm;
import org.junit.jupiter.api.Test;

import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.Key;
import java.util.Date;

import static org.junit.jupiter.api.Assertions.*;

class JwtValidatorTest {

    // JWT_SECRET=test-secret is injected by maven-surefire-plugin <environmentVariables>.
    private static final String SECRET = System.getenv("JWT_SECRET");

    private String makeToken(long expiryOffsetMs) {
        Key key = new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        return Jwts.builder()
                .setSubject("user-123")
                .claim("username", "alice")
                .setIssuedAt(new Date())
                .setExpiration(new Date(System.currentTimeMillis() + expiryOffsetMs))
                .signWith(key, SignatureAlgorithm.HS256)
                .compact();
    }

    @Test
    void validToken_returnsClaims() {
        Claims claims = JwtValidator.validate(makeToken(3_600_000));
        assertEquals("user-123", claims.getSubject());
        assertEquals("alice", claims.getUsername());
    }

    @Test
    void expiredToken_throwsJwtValidationException() {
        JwtValidationException ex = assertThrows(JwtValidationException.class,
                () -> JwtValidator.validate(makeToken(-3_600_000)));
        assertTrue(ex.getMessage().contains("expired"), "message should contain 'expired': " + ex.getMessage());
    }

    @Test
    void tamperedToken_throwsJwtValidationException() {
        String token = makeToken(3_600_000);
        String[] parts = token.split("\\.");
        String tampered = parts[0] + "." + parts[1] + ".invalidsignature";
        assertThrows(JwtValidationException.class, () -> JwtValidator.validate(tampered));
    }
}
