# Concordia

A Discord-like real-time communication platform built as a polyglot microservices monorepo.

## Architecture

| Service       | Language           | Port  | Role                                              |
| ------------- | ------------------ | ----- | ------------------------------------------------- |
| Reverse Proxy | Nginx              | 80/443| **Sole public entry point** — TLS, routing, rate limit |
| Gateway       | Go                 | 8080  | Auth, semantic routing, WebSocket fan-out (private) |
| Auth          | Java/Spring Boot   | 8081  | Registration, JWT issuance (private)             |
| Servers       | Java/Spring Boot   | 8082  | Server/channel CRUD, CheckPerm gRPC (private)    |
| Chat          | Rust/Axum          | 8083  | Messages, attachments, Kafka producer (private)  |
| Voice         | Python/FastAPI     | 8084  | WebRTC signaling, voice sessions (private)       |
| Tips          | Python/FastAPI     | 8085  | Peer-to-peer tips (private)                      |
| Presence      | Go                 | 8086  | WebSocket session registry (private)             |
| Audit         | Go                 | 8087  | Audit-event consumer + forensic API (private)    |
| Web App       | Next.js            | 3000  | Browser client (private; served via proxy)       |
| Desktop App   | Electron + Next.js | —     | Native desktop client                            |

See [`docs/service-descriptions.md`](docs/service-descriptions.md) for full architecture details.

### Security architecture

Four security architectural patterns are implemented (see
[`docs/security_patterns_implementation_v3.md`](docs/security_patterns_implementation_v3.md)):

- **Secure Channel** — TLS 1.2+ for all public traffic.
- **Reverse Proxy** (`services/reverse-proxy/`) — Nginx is the *only* component
  exposed to the host. It terminates TLS, routes `/api/*` and `/ws` to the
  Gateway and everything else to the Web App, and applies IP-based rate limits.
- **Network Segmentation** — every other container lives on an `internal: true`
  Docker network (`private-net`); only the reverse proxy publishes host ports.
- **Audit Trail** (`services/audit/`) — services emit security events to the
  Kafka `audit.events` topic; the Audit Service hash-chains and persists them to
  an append-only store (`audit-db`) for tamper-evident forensics.

## Prerequisites

| Tool                    | Version | Install                                                           |
| ----------------------- | ------- | ----------------------------------------------------------------- |
| Docker + docker-compose | >= 24   | https://docs.docker.com/get-docker/                               |
| Go                      | >= 1.22 | `brew install go`                                                 |
| Node.js                 | >= 22   | `brew install node`                                               |
| Java JDK                | >= 21   | `brew install openjdk@21`                                         |
| Maven                   | >= 3.9  | `brew install maven`                                              |
| Rust                    | >= 1.75 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Python                  | >= 3.11 | `brew install python`                                             |
| protoc                  | >= 3.21 | `brew install protobuf`                                           |

## Quick Start

```bash
# 1. Clone
git clone git@github.com:Lespinald/concordia-chat-app.git
cd concordia-chat-app

# 2. Configure environment
cp infra/.env.example infra/.env
# Edit infra/.env to override any defaults (all defaults work for local dev)
# Required: set JWT_SECRET to a 32+ character string before first run

# 3. Trust the development CA (so the browser accepts https://localhost)
#    macOS:
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain infra/certs/ca.crt
#    Linux:  sudo cp infra/certs/ca.crt /usr/local/share/ca-certificates/concordia-ca.crt && sudo update-ca-certificates

# 4. Start the full stack
docker-compose --env-file infra/.env -f infra/docker-compose.yml up --build

# 5. Open the app — the reverse proxy is the only public entry point
open https://localhost
```

> All traffic enters through the Nginx reverse proxy on ports 80/443. The
> Gateway, services, databases and broker are on an internal-only Docker
> network and are **not** reachable from the host — this is intentional
> (Network Segmentation). Use `docker compose exec <service> ...` to reach them.

## Running individual service tests

```bash
# Go (Gateway + Presence)
go test ./services/gateway/...
go test ./services/presence/...

# Java (Auth + Servers)
mvn test -pl services/auth
mvn test -pl services/servers

# Rust (Chat)
cd services/chat && cargo test

# Python (Voice + Tips)
cd services/voice && pytest
cd services/tips && pytest

# JavaScript (Web App)
npm test --workspace=apps/web-app
```

## Smoke test

```bash
bash infra/smoke-test.sh
```

Runs the full integration sequence: start stack → register → login → create server → send message → verify.

## Kafka topics

| Topic             | Producer                          | Consumer |
| ----------------- | --------------------------------- | -------- |
| `user-registered` | Auth                              | Servers  |
| `message-created` | Chat                              | —        |
| `mention`         | Chat                              | —        |
| `audit.events`    | Auth, Servers, Chat, Voice, Gateway | Audit  |

Kafka is on the internal network only (listener `kafka:9093`). Monitor a topic
from inside the container:

```bash
docker exec kafka kafka-console-consumer.sh \
  --topic audit.events \
  --bootstrap-server kafka:9093 \
  --from-beginning
```

## gRPC

`PermService.CheckPerm` — defined in `contracts/proto/check_perm.proto`

Callers: Gateway, Chat, Voice  
Server: Servers service on port `50051` (internal network only)

Test from inside the network:

```bash
docker compose exec servers grpcurl -plaintext localhost:50051 PermService/CheckPerm \
  -d '{"user_id":"<id>","server_id":"<id>","channel_id":"<id>","action":"READ"}'
```

## Repository layout

```
concordia-chat-app/
├── apps/
│   ├── web-app/          Next.js browser client
│   └── desktop-app/      Electron wrapper
├── services/
│   ├── gateway/          Go
│   ├── auth/             Java/Spring Boot
│   ├── chat/             Rust
│   ├── servers/          Java/Spring Boot
│   ├── voice/            Python/FastAPI
│   ├── presence/         Go
│   └── tips/             Python/FastAPI
├── contracts/
│   ├── proto/            check_perm.proto + generated stubs
│   ├── kafka-schemas/    JSON Schema for Kafka events
│   └── openapi/          gateway.yaml
├── infra/
│   ├── docker-compose.yml
│   └── .env.example
└── docs/
    └── service-descriptions.md
```

## Environment variables

See [`infra/.env.example`](infra/.env.example) for a full annotated list of every variable used across all services.

```bash
cp infra/.env.example infra/.env
# Edit infra/.env — at minimum set JWT_SECRET to a 32+ character secret
docker-compose --env-file infra/.env -f infra/docker-compose.yml up --build
```

`infra/.env` is git-ignored. Never commit real credentials.
