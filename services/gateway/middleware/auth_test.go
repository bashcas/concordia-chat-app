package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"concordia/gateway/middleware"

	"github.com/golang-jwt/jwt/v5"
)

const testSecret = "test-secret-32-bytes-long-padding!"

func makeToken(t *testing.T, secret string, exp time.Time) string {
	t.Helper()
	claims := jwt.MapClaims{"sub": "user-1", "username": "alice"}
	if !exp.IsZero() {
		claims["exp"] = exp.Unix()
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("makeToken: %v", err)
	}
	return tok
}

func okHandler(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }

func TestMissingAuthHeader(t *testing.T) {
	t.Setenv("JWT_SECRET", testSecret)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/servers", nil)
	middleware.RequireAuth(http.HandlerFunc(okHandler)).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestMalformedAuthHeader(t *testing.T) {
	t.Setenv("JWT_SECRET", testSecret)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/servers", nil)
	req.Header.Set("Authorization", "Token notabearer")
	middleware.RequireAuth(http.HandlerFunc(okHandler)).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestExpiredToken(t *testing.T) {
	t.Setenv("JWT_SECRET", testSecret)
	tok := makeToken(t, testSecret, time.Now().Add(-time.Hour))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/servers", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	middleware.RequireAuth(http.HandlerFunc(okHandler)).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestTamperedToken(t *testing.T) {
	t.Setenv("JWT_SECRET", testSecret)
	tok := makeToken(t, testSecret, time.Now().Add(time.Hour))
	tok = tok[:len(tok)-4] + "XXXX" // corrupt signature
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/servers", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	middleware.RequireAuth(http.HandlerFunc(okHandler)).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestValidToken(t *testing.T) {
	t.Setenv("JWT_SECRET", testSecret)
	tok := makeToken(t, testSecret, time.Now().Add(time.Hour))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/servers", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	middleware.RequireAuth(http.HandlerFunc(okHandler)).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestClaimsInContext(t *testing.T) {
	t.Setenv("JWT_SECRET", testSecret)
	tok := makeToken(t, testSecret, time.Now().Add(time.Hour))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/servers", nil)
	req.Header.Set("Authorization", "Bearer "+tok)

	var gotClaims any
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotClaims = r.Context().Value(middleware.ClaimsKey)
		w.WriteHeader(http.StatusOK)
	})
	middleware.RequireAuth(handler).ServeHTTP(rec, req)

	if gotClaims == nil {
		t.Fatal("expected claims in context, got nil")
	}
}
