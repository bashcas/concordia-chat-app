package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"concordia/audit"

	_ "github.com/lib/pq"
)

// store persists audit events to the append-only audit database and maintains
// the global hash chain.
type store struct {
	writer *sql.DB // connects as audit_writer (INSERT + SELECT)
	reader *sql.DB // connects as audit_reader (SELECT only)

	mu       sync.Mutex
	lastHash string // hash of the most recently persisted event
}

// hashInput is the canonical, fixed-order representation that gets hashed.
// It deliberately excludes the event's own hash and includes prev_hash, so
// each event commits to the entire history before it.
type hashInput struct {
	EventID   string         `json:"event_id"`
	EventType string         `json:"event_type"`
	Timestamp string         `json:"timestamp"`
	Actor     audit.Actor    `json:"actor"`
	Resource  *audit.Resource `json:"resource,omitempty"`
	Outcome   string         `json:"outcome"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	PrevHash  string         `json:"prev_hash"`
}

// computeHash returns the SHA-256 of the canonical serialization of ev chained
// to prevHash. Go's json.Marshal emits struct fields in declaration order and
// map keys sorted, so the result is deterministic.
func computeHash(ev audit.Event, prevHash string) string {
	b, _ := json.Marshal(hashInput{
		EventID:   ev.EventID,
		EventType: ev.EventType,
		Timestamp: ev.Timestamp,
		Actor:     ev.Actor,
		Resource:  ev.Resource,
		Outcome:   ev.Outcome,
		Metadata:  ev.Metadata,
		PrevHash:  prevHash,
	})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func newStore(writerURL, readerURL string) (*store, error) {
	w, err := sql.Open("postgres", writerURL)
	if err != nil {
		return nil, fmt.Errorf("open writer: %w", err)
	}
	r, err := sql.Open("postgres", readerURL)
	if err != nil {
		_ = w.Close()
		return nil, fmt.Errorf("open reader: %w", err)
	}
	return &store{writer: w, reader: r}, nil
}

func (s *store) close() {
	_ = s.writer.Close()
	_ = s.reader.Close()
}

// seed loads the current hash-chain head, retrying while the database starts.
func (s *store) seed() error {
	var lastErr error
	for attempt := 0; attempt < 30; attempt++ {
		var h sql.NullString
		err := s.writer.QueryRow(
			`SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1`).Scan(&h)
		switch {
		case err == nil:
			s.lastHash = h.String
			return nil
		case err == sql.ErrNoRows:
			s.lastHash = "" // empty table — chain starts fresh
			return nil
		default:
			lastErr = err
			time.Sleep(2 * time.Second)
		}
	}
	return lastErr
}

// append hash-chains ev and inserts it. The mutex serializes the chain head.
func (s *store) append(ev audit.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	prev := s.lastHash
	h := computeHash(ev, prev)

	actorJSON, _ := json.Marshal(ev.Actor)

	var resourceJSON any
	if ev.Resource != nil {
		b, _ := json.Marshal(ev.Resource)
		resourceJSON = string(b)
	}
	var metaJSON any
	if ev.Metadata != nil {
		b, _ := json.Marshal(ev.Metadata)
		metaJSON = string(b)
	}
	var prevVal any
	if prev != "" {
		prevVal = prev
	}

	_, err := s.writer.Exec(
		`INSERT INTO audit_events
		   (event_id, event_type, timestamp, actor, resource, outcome, metadata, prev_hash, hash)
		 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, $9)`,
		ev.EventID, ev.EventType, ev.Timestamp,
		string(actorJSON), resourceJSON, ev.Outcome, metaJSON, prevVal, h)
	if err != nil {
		return err
	}
	s.lastHash = h
	return nil
}

// storedEvent is one row of the audit log as returned to forensic queries.
type storedEvent struct {
	Seq      int64       `json:"seq"`
	Event    audit.Event `json:"event"`
	PrevHash string      `json:"prev_hash"`
	Hash     string      `json:"hash"`
}

// scanRow reads one audit_events row into a storedEvent.
func scanRow(rs interface{ Scan(...any) error }) (storedEvent, error) {
	var (
		se        storedEvent
		actorB    []byte
		resourceB []byte
		metaB     []byte
		prevH     sql.NullString
	)
	if err := rs.Scan(&se.Seq, &se.Event.EventID, &se.Event.EventType, &se.Event.Timestamp,
		&actorB, &resourceB, &se.Event.Outcome, &metaB, &prevH, &se.Hash); err != nil {
		return se, err
	}
	if len(actorB) > 0 {
		_ = json.Unmarshal(actorB, &se.Event.Actor)
	}
	if len(resourceB) > 0 {
		var r audit.Resource
		if err := json.Unmarshal(resourceB, &r); err == nil {
			se.Event.Resource = &r
		}
	}
	if len(metaB) > 0 {
		_ = json.Unmarshal(metaB, &se.Event.Metadata)
	}
	se.PrevHash = prevH.String
	return se, nil
}

const rowColumns = `seq, event_id, event_type, timestamp, actor, resource, outcome, metadata, prev_hash, hash`

// query returns audit events filtered by event type and/or actor user id,
// most recent first.
func (s *store) query(eventType, userID string, limit int) ([]storedEvent, error) {
	rows, err := s.reader.Query(
		`SELECT `+rowColumns+` FROM audit_events
		 WHERE ($1 = '' OR event_type = $1)
		   AND ($2 = '' OR actor->>'user_id' = $2)
		 ORDER BY seq DESC
		 LIMIT $3`, eventType, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []storedEvent
	for rows.Next() {
		se, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, se)
	}
	return out, rows.Err()
}

// verifyResult is the outcome of a hash-chain validation pass.
type verifyResult struct {
	OK        bool   `json:"ok"`
	Count     int    `json:"count"`
	BrokenSeq int64  `json:"broken_seq,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// verify re-walks the entire chain: for every row it recomputes the hash from
// the stored columns and checks that prev_hash links to the preceding row.
// Any manual UPDATE/DELETE in the database breaks one of these checks.
func (s *store) verify() (verifyResult, error) {
	rows, err := s.reader.Query(
		`SELECT ` + rowColumns + ` FROM audit_events ORDER BY seq ASC`)
	if err != nil {
		return verifyResult{}, err
	}
	defer rows.Close()

	expectedPrev := ""
	count := 0
	for rows.Next() {
		se, err := scanRow(rows)
		if err != nil {
			return verifyResult{}, err
		}
		count++
		if se.PrevHash != expectedPrev {
			return verifyResult{OK: false, Count: count, BrokenSeq: se.Seq,
				Reason: "prev_hash does not match the preceding event"}, nil
		}
		if recomputed := computeHash(se.Event, se.PrevHash); recomputed != se.Hash {
			return verifyResult{OK: false, Count: count, BrokenSeq: se.Seq,
				Reason: "recomputed hash does not match stored hash (event was modified)"}, nil
		}
		expectedPrev = se.Hash
	}
	if err := rows.Err(); err != nil {
		return verifyResult{}, err
	}
	return verifyResult{OK: true, Count: count}, nil
}
