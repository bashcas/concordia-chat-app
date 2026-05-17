//! Shared audit-event emitter for Concordia Rust services (Pattern 3: Audit
//! Trail).
//!
//! [`emit`] publishes an audit event to the Kafka `audit.events` topic in a
//! fire-and-forget manner: it enqueues the message into librdkafka's internal
//! queue and returns immediately, never blocking or failing the caller.
//!
//! Producers MUST NOT set `prev_hash`/`hash` — the Audit Service computes them.

use chrono::Utc;
use rdkafka::producer::{FutureProducer, FutureRecord};
use serde_json::{json, Map, Value};
use uuid::Uuid;

/// Kafka topic every audit event is published to.
pub const TOPIC: &str = "audit.events";

// Outcomes
pub const OUTCOME_SUCCESS: &str = "success";
pub const OUTCOME_FAILURE: &str = "failure";

// Chat service event types
pub const EVENT_MESSAGE_DELETE: &str = "chat.message.delete";

/// Publishes one audit event. Never blocks and never returns an error —
/// audit failures must not break business logic.
///
/// * `actor`    — who performed the action, e.g. `json!({"user_id": ...})`
/// * `resource` — what was targeted, e.g. `json!({"type": ..., "id": ...})`
/// * `outcome`  — [`OUTCOME_SUCCESS`] or [`OUTCOME_FAILURE`]
/// * `metadata` — event-specific fields; never message content or credentials
pub fn emit(
    producer: &FutureProducer,
    event_type: &str,
    actor: Value,
    resource: Option<Value>,
    outcome: &str,
    metadata: Option<Value>,
) {
    let mut event: Map<String, Value> = Map::new();
    event.insert("event_id".into(), json!(Uuid::new_v4().to_string()));
    event.insert("event_type".into(), json!(event_type));
    event.insert("timestamp".into(), json!(Utc::now().to_rfc3339()));
    event.insert("actor".into(), actor);
    if let Some(r) = resource {
        event.insert("resource".into(), r);
    }
    event.insert("outcome".into(), json!(outcome));
    if let Some(m) = metadata {
        event.insert("metadata".into(), m);
    }

    let payload = match serde_json::to_string(&Value::Object(event)) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("audit: serialize failed (event dropped): {}", e);
            return;
        }
    };

    // send_result enqueues into librdkafka and returns immediately; the
    // returned delivery future is dropped — librdkafka delivers in background.
    let record = FutureRecord::to(TOPIC).payload(&payload).key(event_type);
    if let Err((e, _)) = producer.send_result(record) {
        tracing::warn!("audit: enqueue failed (event dropped): {}", e);
    }
}
