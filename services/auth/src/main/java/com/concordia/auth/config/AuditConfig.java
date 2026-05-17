package com.concordia.auth.config;

import com.concordia.audit.AuditEmitter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the shared {@link AuditEmitter} (Pattern 3: Audit Trail) as a Spring
 * bean so the service layer can record security-relevant events.
 */
@Configuration
public class AuditConfig {

    @Bean
    public AuditEmitter auditEmitter(
            @Value("${spring.kafka.bootstrap-servers:kafka:9093}") String bootstrapServers) {
        return new AuditEmitter(bootstrapServers);
    }
}
