# Kafka Schemas

JSON Schema (Draft-07) definitions for every Kafka topic in Concordia.

All producers and consumers must conform to the schema for their topic. Field names use `snake_case`. Timestamps are ISO 8601 strings (`date-time` format). UUIDs are strings in `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` format.

---

## Topics

### `user-registered`

**Schema:** [`user-registered.json`](user-registered.json)

| Role     | Service  |
|----------|----------|
| Producer | Auth Svc |
| Consumer | Tips Svc |

Published after a user successfully registers (after the DB commit, before the HTTP response). Tips Svc consumes this event to create a default subscription record for the new user.

**Fields:**

| Field        | Type              | Description                    |
|--------------|-------------------|--------------------------------|
| `user_id`    | string (uuid)     | Newly created user's ID        |
| `username`   | string            | Chosen display name (max 32)   |
| `email`      | string (email)    | Verified email address         |
| `created_at` | string (datetime) | Registration timestamp (UTC)   |

---

### `message-created`

**Schema:** [`message-created.json`](message-created.json)

| Role     | Service    |
|----------|------------|
| Producer | Chat Svc   |
| Consumer | Gateway    |

Published after a message is persisted to Cassandra. Gateway consumes this event and fans it out over WebSocket to all online members of the channel's server.

**Fields:**

| Field        | Type                  | Description                                              |
|--------------|-----------------------|----------------------------------------------------------|
| `message_id` | string (uuid)         | Unique message ID                                        |
| `channel_id` | string (uuid)         | Channel the message was posted in                        |
| `server_id`  | string (uuid) \| null | Server the channel belongs to; `null` for DM channels    |
| `author_id`  | string (uuid)         | User who sent the message                                |
| `content`    | string                | Message text (max 4000 chars)                            |
| `attachments`| string[]              | MinIO object keys for any uploaded files (may be empty)  |
| `created_at` | string (datetime)     | Message timestamp (UTC)                                  |

---

### `mention`

**Schema:** [`mention.json`](mention.json)

| Role     | Service  |
|----------|----------|
| Producer | Chat Svc |
| Consumer | Gateway  |

Published by Chat Svc for each `@mention` detected in a message — one event per mentioned user. Gateway consumes this to push a targeted notification over WebSocket to the mentioned user.

**Fields:**

| Field               | Type                  | Description                                           |
|---------------------|-----------------------|-------------------------------------------------------|
| `mention_id`        | string (uuid)         | Unique ID for this mention event                      |
| `message_id`        | string (uuid)         | Message that contained the mention                    |
| `mentioned_user_id` | string (uuid)         | User who was mentioned                                |
| `channel_id`        | string (uuid)         | Channel where the mention occurred                    |
| `server_id`         | string (uuid) \| null | Server the channel belongs to; `null` for DM channels |
| `created_at`        | string (datetime)     | Timestamp of the originating message (UTC)            |

---

## Versioning

Schemas are append-only — adding optional fields is backward-compatible. Removing or renaming fields, or changing field types, is a breaking change and requires a new topic name (e.g. `message-created.v2`).
