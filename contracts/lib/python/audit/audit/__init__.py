"""Shared audit-event emitter for Concordia Python services (Pattern 3:
Audit Trail).

``AuditEmitter.emit`` publishes an event to the Kafka ``audit.events`` topic in
a fire-and-forget manner: it enqueues the message into librdkafka's internal
queue and returns immediately, never blocking or breaking the caller.

Producers MUST NOT set ``prev_hash``/``hash`` — the Audit Service computes them.
"""

import json
import uuid
from datetime import datetime, timezone

try:  # confluent-kafka bundles librdkafka in its wheel
    from confluent_kafka import Producer
except ImportError:  # pragma: no cover - lets the module import without kafka
    Producer = None

TOPIC = "audit.events"

# Outcomes
OUTCOME_SUCCESS = "success"
OUTCOME_FAILURE = "failure"

# Voice service event types
EVENT_VOICE_SESSION_START = "voice.session.start"
EVENT_VOICE_SESSION_END = "voice.session.end"


class AuditEmitter:
    """Fire-and-forget audit-event emitter."""

    def __init__(self, brokers: str):
        self._producer = None
        if brokers and Producer is not None:
            try:
                self._producer = Producer(
                    {
                        "bootstrap.servers": brokers,
                        "acks": "0",  # fire-and-forget
                        "message.timeout.ms": 5000,
                    }
                )
            except Exception as exc:  # noqa: BLE001
                print(f"audit: producer init failed: {exc}")

    def emit(self, event_type, actor=None, resource=None,
             outcome=OUTCOME_SUCCESS, metadata=None):
        """Publish one audit event. Never raises and never blocks the caller."""
        if self._producer is None:
            return
        event = {
            "event_id": str(uuid.uuid4()),
            "event_type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "actor": actor or {},
            "outcome": outcome,
        }
        if resource is not None:
            event["resource"] = resource
        if metadata is not None:
            event["metadata"] = metadata
        try:
            self._producer.produce(
                TOPIC, key=event_type, value=json.dumps(event)
            )
            self._producer.poll(0)  # serve delivery callbacks, non-blocking
        except Exception as exc:  # noqa: BLE001
            print(f"audit: emit failed (event dropped): {exc}")
