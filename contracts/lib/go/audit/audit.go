// Package audit is the shared Go helper for the Audit Trail pattern.
//
// It defines the canonical audit-event schema and a fire-and-forget Emitter
// that publishes events to the Kafka audit.events topic. Emitting an audit
// event must never block or break the caller's business logic: if the broker
// is unavailable the event is logged and dropped.
//
// Producers MUST NOT set PrevHash/Hash — those are computed by the Audit
// Service when it consumes and persists the event.
package audit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

// DefaultTopic is the Kafka topic all audit events are published to.
const DefaultTopic = "audit.events"

// Outcome values.
const (
	OutcomeSuccess = "success"
	OutcomeFailure = "failure"
)

// Canonical event_type constants. Every producer should use these so that
// event names cannot be mistyped.
const (
	// Auth service
	EventAuthRegister      = "auth.register"
	EventAuthLoginSuccess  = "auth.login.success"
	EventAuthLoginFailure  = "auth.login.failure"
	EventAuthTokenRefresh  = "auth.token.refresh"
	EventAuthLogout        = "auth.logout"

	// Servers service
	EventServerCreate   = "servers.server.create"
	EventServerUpdate   = "servers.server.update"
	EventServerDelete   = "servers.server.delete"
	EventChannelCreate  = "servers.channel.create"
	EventChannelUpdate  = "servers.channel.update"
	EventChannelDelete  = "servers.channel.delete"
	EventRoleCreate     = "servers.role.create"
	EventRoleUpdate     = "servers.role.update"
	EventRoleDelete     = "servers.role.delete"
	EventRoleAssign     = "servers.role.assign"
	EventMemberJoin     = "servers.member.join"
	EventMemberLeave    = "servers.member.leave"
	EventMemberKick     = "servers.member.kick"

	// Chat service
	EventMessageDelete = "chat.message.delete"

	// Voice service
	EventVoiceSessionStart = "voice.session.start"
	EventVoiceSessionEnd   = "voice.session.end"

	// Gateway
	EventGatewayJWTFailure      = "gateway.jwt.failure"
	EventGatewayRateLimitBreach = "gateway.ratelimit.breach"
)

// Actor identifies who performed an audited action. It never carries
// credentials — only identifiers.
type Actor struct {
	UserID    string `json:"user_id,omitempty"`
	IP        string `json:"ip,omitempty"`
	UserAgent string `json:"user_agent,omitempty"`
}

// Resource identifies what an audited action targeted.
type Resource struct {
	Type string `json:"type,omitempty"`
	ID   string `json:"id,omitempty"`
}

// Event is the wire format of an audit event. Field order is fixed so the
// Audit Service can hash a canonical serialization deterministically.
type Event struct {
	EventID   string         `json:"event_id"`
	EventType string         `json:"event_type"`
	Timestamp string         `json:"timestamp"`
	Actor     Actor          `json:"actor"`
	Resource  *Resource      `json:"resource,omitempty"`
	Outcome   string         `json:"outcome"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// Emitter publishes audit events fire-and-forget to Kafka.
type Emitter struct {
	writer *kafka.Writer
}

// NewEmitter creates an Emitter writing to the given brokers and topic.
// Pass an empty brokers slice to obtain a no-op Emitter (useful in tests).
func NewEmitter(brokers []string, topic string) *Emitter {
	if len(brokers) == 0 {
		return &Emitter{}
	}
	if topic == "" {
		topic = DefaultTopic
	}
	w := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        topic,
		Balancer:     &kafka.LeastBytes{},
		BatchTimeout: 200 * time.Millisecond,
		// Async makes WriteMessages enqueue and return immediately — the
		// caller's request path is never blocked on the broker.
		Async: true,
		Completion: func(_ []kafka.Message, err error) {
			if err != nil {
				log.Printf("audit: emit failed (event dropped): %v", err)
			}
		},
	}
	return &Emitter{writer: w}
}

// Emit publishes one audit event. It is safe to call on a nil Emitter and on
// a no-op Emitter; in both cases it does nothing. It never blocks the caller
// and never returns an error — audit failures must not break business logic.
func (e *Emitter) Emit(eventType string, actor Actor, resource *Resource, outcome string, metadata map[string]any) {
	if e == nil || e.writer == nil {
		return
	}
	ev := Event{
		EventID:   NewUUID(),
		EventType: eventType,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Actor:     actor,
		Resource:  resource,
		Outcome:   outcome,
		Metadata:  metadata,
	}
	payload, err := json.Marshal(ev)
	if err != nil {
		log.Printf("audit: marshal failed (event dropped): %v", err)
		return
	}
	if err := e.writer.WriteMessages(context.Background(), kafka.Message{
		Key:   []byte(eventType),
		Value: payload,
	}); err != nil {
		log.Printf("audit: enqueue failed (event dropped): %v", err)
	}
}

// Close flushes and releases the underlying writer.
func (e *Emitter) Close() error {
	if e == nil || e.writer == nil {
		return nil
	}
	return e.writer.Close()
}

// NewUUID returns a random RFC 4122 v4 UUID string.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failure is unrecoverable; fall back to a timestamp.
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}
