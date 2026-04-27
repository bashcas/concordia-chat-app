package com.concordia.servers.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.persistence.*;
import org.hibernate.annotations.SQLDelete;
import org.hibernate.annotations.SQLRestriction;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "servers")
@SQLDelete(sql = "UPDATE servers SET deleted = true WHERE id=?")
@SQLRestriction("deleted=false")
public class Server {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @JsonProperty("server_id") // Blocker 2: Cambia "id" a "server_id" en el JSON
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Column(name = "owner_id", nullable = false)
    @JsonProperty("owner_id") // Blocker 2: Cambia "ownerId" a "owner_id" en el JSON
    private String ownerId;

    @Column(name = "created_at", nullable = false, updatable = false)
    @JsonProperty("created_at")
    private OffsetDateTime createdAt; // Blocker 3: ISO 8601 con zona horaria

    @Column(nullable = false)
    @JsonIgnore // Blocker 4: Oculta este campo para que no salga en la respuesta API
    private boolean deleted = false;

    @PrePersist
    protected void onCreate() {
        // Blocker 3: Guarda la fecha exacta en formato UTC
        this.createdAt = OffsetDateTime.now(ZoneOffset.UTC);
    }

    // --- GETTERS Y SETTERS ---
    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getOwnerId() { return ownerId; }
    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }

    public OffsetDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(OffsetDateTime createdAt) { this.createdAt = createdAt; }

    public boolean isDeleted() { return deleted; }
    public void setDeleted(boolean deleted) { this.deleted = deleted; }
}
