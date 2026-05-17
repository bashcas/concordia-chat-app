package com.concordia.audit;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.Producer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringSerializer;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;

/**
 * Fire-and-forget audit-event emitter for Concordia Java services (Pattern 3:
 * Audit Trail).
 *
 * <p>Events are published to the Kafka {@code audit.events} topic. Emitting an
 * audit event must never block or break the caller's business logic: the
 * producer is configured with {@code acks=0} and short timeouts, and every
 * failure is swallowed and logged.
 *
 * <p>Producers MUST NOT set prev_hash/hash — the Audit Service computes those.
 */
public class AuditEmitter {

    /** Kafka topic every audit event is published to. */
    public static final String TOPIC = "audit.events";

    private final Producer<String, String> producer;
    private final ObjectMapper mapper = new ObjectMapper();

    public AuditEmitter(String bootstrapServers) {
        Properties props = new Properties();
        props.put("bootstrap.servers", bootstrapServers);
        props.put("key.serializer", StringSerializer.class.getName());
        props.put("value.serializer", StringSerializer.class.getName());
        props.put("acks", "0");                  // fire-and-forget
        props.put("max.block.ms", "1000");       // never block business logic
        props.put("request.timeout.ms", "4000");
        props.put("delivery.timeout.ms", "5000");
        this.producer = new KafkaProducer<>(props);
    }

    /** Test/alternate constructor that accepts a pre-built producer. */
    public AuditEmitter(Producer<String, String> producer) {
        this.producer = producer;
    }

    /**
     * Publishes one audit event. Never throws and never blocks meaningfully.
     *
     * @param eventType one of {@link EventTypes}
     * @param actor     who performed the action (e.g. {"user_id": ...}); may be null
     * @param resource  what was targeted (e.g. {"type": ..., "id": ...}); may be null
     * @param outcome   {@code "success"} or {@code "failure"}
     * @param metadata  event-specific fields; may be null. Never put passwords,
     *                  full JWTs or message content here.
     */
    public void emit(String eventType,
                     Map<String, Object> actor,
                     Map<String, Object> resource,
                     String outcome,
                     Map<String, Object> metadata) {
        try {
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("event_id", UUID.randomUUID().toString());
            event.put("event_type", eventType);
            event.put("timestamp", Instant.now().toString());
            event.put("actor", actor == null ? Map.of() : actor);
            if (resource != null) {
                event.put("resource", resource);
            }
            event.put("outcome", outcome);
            if (metadata != null) {
                event.put("metadata", metadata);
            }
            String json = mapper.writeValueAsString(event);
            producer.send(new ProducerRecord<>(TOPIC, eventType, json));
        } catch (Exception e) {
            // Audit emission must never break business logic.
            System.err.println("audit: emit failed (event dropped): " + e.getMessage());
        }
    }
}
