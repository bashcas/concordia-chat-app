// Command audit is the Concordia Audit Service (Pattern 3: Audit Trail).
//
// It consumes audit events from the Kafka audit.events topic, hash-chains
// them, and persists them to an append-only audit store. It also exposes a
// small forensic query API protected by an admin JWT.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type config struct {
	port      string
	brokers   []string
	topic     string
	writerURL string
	readerURL string
	jwtSecret string
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func loadConfig() config {
	return config{
		port:      getenv("AUDIT_PORT", "8087"),
		brokers:   strings.Split(getenv("KAFKA_BROKERS", "kafka:9093"), ","),
		topic:     getenv("AUDIT_TOPIC", "audit.events"),
		writerURL: getenv("AUDIT_DB_WRITER_URL", ""),
		readerURL: getenv("AUDIT_DB_READER_URL", ""),
		jwtSecret: os.Getenv("JWT_SECRET"),
	}
}

func main() {
	cfg := loadConfig()
	if cfg.writerURL == "" || cfg.readerURL == "" {
		log.Fatal("audit: AUDIT_DB_WRITER_URL and AUDIT_DB_READER_URL must be set")
	}

	st, err := newStore(cfg.writerURL, cfg.readerURL)
	if err != nil {
		log.Fatalf("audit: open store: %v", err)
	}
	defer st.close()

	// Seed the in-memory hash-chain head from whatever is already persisted.
	if err := st.seed(); err != nil {
		log.Fatalf("audit: seed hash chain: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	c := newConsumer(cfg.brokers, cfg.topic, st)
	go c.run(ctx)

	srv := &http.Server{
		Addr:              ":" + cfg.port,
		Handler:           newServer(cfg, st),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		_ = srv.Shutdown(shutCtx)
	}()

	log.Printf("audit service listening on :%s (topic %q)", cfg.port, cfg.topic)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("audit: http server: %v", err)
	}
	_ = c.close()
}
