package main

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/sony/gobreaker/v2"
)

// cbConfig holds the circuit-breaker thresholds (read from env).
type cbConfig struct {
	maxFailures uint32        // consecutive failures before the breaker opens
	openTimeout time.Duration // how long the breaker stays open before a half-open probe
}

func cbConfigFromEnv() cbConfig {
	return cbConfig{
		maxFailures: uint32(atoiDefault(getenv("GATEWAY_CB_MAX_FAILURES", "5"), 5)),
		openTimeout: time.Duration(atoiDefault(getenv("GATEWAY_CB_OPEN_SECONDS", "10"), 10)) * time.Second,
	}
}

func atoiDefault(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n
	}
	return def
}

// err5xx is a sentinel: the upstream answered with a 5xx. We count it as a
// breaker failure but still hand the real response back to the proxy.
var err5xx = errors.New("upstream 5xx")

// cbTransport wraps an http.RoundTripper in a per-upstream circuit breaker.
// A transport error (e.g. connection refused when the service is down) or a 5xx
// response counts as a failure; after maxFailures consecutive failures the
// breaker opens and RoundTrip fast-fails with gobreaker.ErrOpenState — the
// proxy's ErrorHandler then returns 503 immediately instead of hanging. After
// openTimeout the breaker half-opens and lets one probe through to recover.
type cbTransport struct {
	base http.RoundTripper
	cb   *gobreaker.CircuitBreaker[*http.Response]
}

func newCBTransport(name string, cfg cbConfig) *cbTransport {
	settings := gobreaker.Settings{
		Name:        name,
		MaxRequests: 1, // half-open: allow a single probe request
		Timeout:     cfg.openTimeout,
		ReadyToTrip: func(c gobreaker.Counts) bool {
			return c.ConsecutiveFailures >= cfg.maxFailures
		},
		OnStateChange: func(n string, from, to gobreaker.State) {
			log.Printf("gateway: circuit breaker %q: %s -> %s", n, from, to)
		},
	}
	return &cbTransport{
		base: http.DefaultTransport,
		cb:   gobreaker.NewCircuitBreaker[*http.Response](settings),
	}
}

func (t *cbTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.cb.Execute(func() (*http.Response, error) {
		r, e := t.base.RoundTrip(req)
		if e != nil {
			return nil, e // transport error → counts as a breaker failure
		}
		if r.StatusCode >= 500 {
			return r, err5xx // count the 5xx as a failure but keep the response
		}
		return r, nil
	})
	if errors.Is(err, err5xx) {
		// Breaker already recorded the failure; deliver the real 5xx to the client.
		return resp, nil
	}
	return resp, err // nil on success; ErrOpenState/transport error → proxy ErrorHandler → 503
}
