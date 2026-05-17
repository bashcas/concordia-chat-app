package middleware

import (
	"net"
	"net/http"
	"strings"

	"concordia/audit"
)

// auditEmitter is the gateway's audit-event emitter. It is nil until
// SetAuditEmitter is called, and audit.Emitter.Emit is nil-safe, so audit
// emission is a no-op in tests that never wire an emitter.
var auditEmitter *audit.Emitter

// SetAuditEmitter wires the gateway's audit emitter (called from main).
func SetAuditEmitter(e *audit.Emitter) { auditEmitter = e }

// clientIP returns the originating client IP, preferring the forwarding
// headers set by the reverse proxy over the direct connection address.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		return xr
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
