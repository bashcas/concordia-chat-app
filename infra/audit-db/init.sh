#!/bin/sh
# =============================================================================
# Concordia — Audit Log Store schema (Pattern 3: Audit Trail)
# =============================================================================
# Runs once on first start of the audit-db Postgres container.
# Creates the append-only audit_events table and two restricted roles:
#   audit_writer — INSERT + SELECT only  (used by the Audit Service consumer)
#   audit_reader — SELECT only           (used by the forensic query endpoint)
# Neither role is granted UPDATE or DELETE: the log is append-only by access
# control, which is what makes the hash-chained trail tamper-evident.
# =============================================================================
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname audit <<-EOSQL
    CREATE TABLE audit_events (
        seq         BIGSERIAL PRIMARY KEY,        -- global monotonic order
        event_id    UUID        NOT NULL UNIQUE,
        event_type  TEXT        NOT NULL,
        -- Stored as TEXT (the exact ISO-8601 string the producer sent) so the
        -- value round-trips byte-for-byte and the hash chain stays verifiable.
        -- Cast to timestamptz in queries when a time range is needed.
        timestamp   TEXT        NOT NULL,
        actor       JSONB       NOT NULL,         -- {user_id, ip, user_agent}
        resource    JSONB,                        -- {type, id}
        outcome     TEXT        NOT NULL,         -- success | failure
        metadata    JSONB,                        -- event-specific fields
        prev_hash   TEXT,                         -- hash of the previous event
        hash        TEXT        NOT NULL,         -- hash of this event
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_audit_type  ON audit_events (event_type);
    CREATE INDEX idx_audit_actor ON audit_events ((actor->>'user_id'));
    CREATE INDEX idx_audit_ts    ON audit_events (timestamp);

    -- Writer role: append + read, NO update/delete.
    CREATE ROLE audit_writer LOGIN PASSWORD '${AUDIT_WRITER_PASSWORD}';
    GRANT USAGE ON SCHEMA public TO audit_writer;
    GRANT INSERT, SELECT ON audit_events TO audit_writer;
    GRANT USAGE, SELECT ON SEQUENCE audit_events_seq_seq TO audit_writer;

    -- Reader role: read only — used by the forensic query endpoint.
    CREATE ROLE audit_reader LOGIN PASSWORD '${AUDIT_READER_PASSWORD}';
    GRANT USAGE ON SCHEMA public TO audit_reader;
    GRANT SELECT ON audit_events TO audit_reader;
EOSQL

echo "audit-db: audit_events table and audit_writer / audit_reader roles created."
