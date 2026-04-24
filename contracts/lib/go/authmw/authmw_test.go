package authmw_test

import (
	"strings"
	"testing"
	"time"

	. "concordia/authmw"

	"github.com/golang-jwt/jwt/v5"
)

const testSecret = "test-secret"

func makeToken(secret string, exp time.Time, extra map[string]any) string {
	mc := jwt.MapClaims{"sub": "user-123", "username": "alice"}
	if !exp.IsZero() {
		mc["exp"] = exp.Unix()
	}
	for k, v := range extra {
		mc[k] = v
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, mc)
	signed, _ := t.SignedString([]byte(secret))
	return signed
}

func TestValidToken(t *testing.T) {
	t.Setenv("JWT_SECRET", testSecret)
	token := makeToken(testSecret, time.Now().Add(time.Hour), nil)

	claims, err := ValidateJWT(token)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if claims.UserID != "user-123" {
		t.Fatalf("expected sub=user-123, got %q", claims.UserID)
	}
}

func TestExpiredToken(t *testing.T) {
	t.Setenv("JWT_SECRET", testSecret)
	token := makeToken(testSecret, time.Now().Add(-time.Hour), nil)

	_, err := ValidateJWT(token)
	if err != ErrExpiredToken {
		t.Fatalf("expected ErrExpiredToken, got %v", err)
	}
}

func TestTamperedToken(t *testing.T) {
	t.Setenv("JWT_SECRET", testSecret)
	token := makeToken(testSecret, time.Now().Add(time.Hour), nil)

	parts := strings.Split(token, ".")
	parts[2] = "invalidsignature"
	tampered := strings.Join(parts, ".")

	_, err := ValidateJWT(tampered)
	if err != ErrInvalidToken {
		t.Fatalf("expected ErrInvalidToken, got %v", err)
	}
}

func TestMissingSecret(t *testing.T) {
	t.Setenv("JWT_SECRET", "")
	_, err := ValidateJWT("anything")
	if err == nil {
		t.Fatal("expected error when JWT_SECRET is empty")
	}
}
