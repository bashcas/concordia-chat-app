package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"concordia/audit"
	"concordia/authmw"
)

type contextKey string

// ClaimsKey is the context key under which validated JWT claims are stored.
const ClaimsKey contextKey = "claims"

// RequireAuth rejects requests that lack a valid Bearer JWT with HTTP 401.
// On success it injects the parsed claims into the request context.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := ""
		header := r.Header.Get("Authorization")
		if strings.HasPrefix(header, "Bearer ") {
			token = strings.TrimPrefix(header, "Bearer ")
		} else if qToken := r.URL.Query().Get("token"); qToken != "" {
			token = qToken
		}

		if token == "" {
			writeUnauthorized(w)
			return
		}

		claims, err := authmw.ValidateJWT(token)
		if err != nil {
			// Audit Trail: a failed JWT validation is a security-relevant
			// event (possible token forgery). Emitted fire-and-forget.
			auditEmitter.Emit(
				audit.EventGatewayJWTFailure,
				audit.Actor{IP: clientIP(r), UserAgent: r.UserAgent()},
				nil,
				audit.OutcomeFailure,
				map[string]any{"reason": err.Error(), "path": r.URL.Path},
			)
			writeUnauthorized(w)
			return
		}
		if f, ok := r.Context().Value(logFieldsKey{}).(*logFields); ok {
			f.UserID = claims.UserID
		}
		r.Header.Set("X-User-Id", claims.UserID)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ClaimsKey, claims)))
	})
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"}) //nolint:errcheck
}
