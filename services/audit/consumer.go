package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"concordia/audit"

	"github.com/segmentio/kafka-go"
)

// consumer reads audit events from Kafka and appends them to the store.
// A single consumer on a single-partition topic gives a total order, which
// is what the global hash chain relies on.
type consumer struct {
	reader *kafka.Reader
	store  *store
}

func newConsumer(brokers []string, topic string, st *store) *consumer {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:  brokers,
		Topic:    topic,
		GroupID:  "audit-service",
		MinBytes: 1,
		MaxBytes: 1 << 20, // 1 MiB
	})
	return &consumer{reader: r, store: st}
}

// run consumes until ctx is cancelled.
func (c *consumer) run(ctx context.Context) {
	for {
		m, err := c.reader.ReadMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("audit: kafka read error: %v", err)
			time.Sleep(time.Second)
			continue
		}

		var ev audit.Event
		if err := json.Unmarshal(m.Value, &ev); err != nil {
			log.Printf("audit: dropping malformed event: %v", err)
			continue
		}
		if !validEvent(ev) {
			log.Printf("audit: dropping invalid event %q (missing required fields)", ev.EventID)
			continue
		}
		if err := c.store.append(ev); err != nil {
			// Persisting failed; the event is lost. For the lab this is logged;
			// production would retry or commit offsets only after a write.
			log.Printf("audit: persist failed for event %q: %v", ev.EventID, err)
			continue
		}
		log.Printf("audit: stored event %s (%s)", ev.EventType, ev.EventID)
	}
}

func (c *consumer) close() error {
	return c.reader.Close()
}

// validEvent checks the required fields defined by the audit-events schema.
func validEvent(ev audit.Event) bool {
	return ev.EventID != "" && ev.EventType != "" && ev.Timestamp != "" && ev.Outcome != ""
}
