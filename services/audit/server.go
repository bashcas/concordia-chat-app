package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// server exposes the forensic query API. The query endpoints are restricted
// to admin JWTs — tokens signed with JWT_SECRET that carry "admin": true,
// a different scope from the regular user tokens issued by the Auth service.
type server struct {
	cfg   config
	store *store
	mux   *http.ServeMux
}

// adminClaims is the minimal claim set the forensic endpoints require.
type adminClaims struct {
	Admin bool `json:"admin"`
	jwt.RegisteredClaims
}

func newServer(cfg config, st *store) http.Handler {
	s := &server{cfg: cfg, store: st, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("GET /audit/events", s.requireAdmin(s.handleEvents))
	s.mux.HandleFunc("GET /audit/verify", s.requireAdmin(s.handleVerify))
	return s.mux
}

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// requireAdmin wraps a handler so it only runs for a valid admin JWT.
func (s *server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdmin(r) {
			writeJSON(w, http.StatusForbidden,
				map[string]string{"error": "admin token required"})
			return
		}
		next(w, r)
	}
}

func (s *server) isAdmin(r *http.Request) bool {
	raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if raw == "" || raw == r.Header.Get("Authorization") {
		return false // no header, or no "Bearer " prefix
	}
	if s.cfg.jwtSecret == "" {
		return false
	}
	claims := &adminClaims{}
	tok, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return []byte(s.cfg.jwtSecret), nil
	})
	if err != nil || !tok.Valid {
		return false
	}
	return claims.Admin
}

// handleEvents serves GET /audit/events?event_type=&user_id=&limit=
func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 100
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	events, err := s.store.query(q.Get("event_type"), q.Get("user_id"), limit)
	if err != nil {
		log.Printf("audit: query failed: %v", err)
		writeJSON(w, http.StatusInternalServerError,
			map[string]string{"error": "query failed"})
		return
	}
	if events == nil {
		events = []storedEvent{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": len(events), "events": events})
}

// handleVerify serves GET /audit/verify — re-walks and validates the chain.
func (s *server) handleVerify(w http.ResponseWriter, _ *http.Request) {
	res, err := s.store.verify()
	if err != nil {
		log.Printf("audit: verify failed: %v", err)
		writeJSON(w, http.StatusInternalServerError,
			map[string]string{"error": "verify failed"})
		return
	}
	status := http.StatusOK
	if !res.OK {
		status = http.StatusConflict // chain is broken
	}
	writeJSON(w, status, res)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
