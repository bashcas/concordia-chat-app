package middleware

import (
	"net/http"
	"os"
)

// gatewayInstanceHeader is intentionally distinct from the auth service's
// "X-Instance-Id": a login request flows through BOTH load balancers (the
// reverse proxy / gateway-lb in front of the gateway replicas, then auth-lb in
// front of the auth replicas). Auth stamps X-Instance-Id with its own replica;
// using a separate header here lets a client observe the gateway replica that
// handled the request without the two values clobbering each other.
const gatewayInstanceHeader = "X-Gateway-Instance-Id"

var gatewayInstanceID = resolveInstanceID()

func resolveInstanceID() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "unknown"
}

// InstanceID stamps every response with the gateway replica's hostname so that
// load-balancer distribution across gateway / gateway_2 / gateway_3 is directly
// observable from the client (mirrors the auth service's InstanceIdFilter).
func InstanceID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(gatewayInstanceHeader, gatewayInstanceID)
		next.ServeHTTP(w, r)
	})
}
