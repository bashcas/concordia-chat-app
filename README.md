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

#### Toggling patterns (deploy-time flags)

Four flags in [`infra/.env`](infra/.env) turn each pattern on or off. Restart the
stack after changing them. Use the launcher script (recommended):

```bash
cp infra/.env.example infra/.env
./infra/up.sh --build          # start with flags from infra/.env
./infra/up.sh --print          # show resolved mode without starting
```

| Flag | When **off** | When **on** (default) |
|------|----------------|------------------------|
| `SECURITY_REVERSE_PROXY` | Gateway `:8080` and web-app `:3000` on the host; no Nginx edge | Single entry `https://localhost`; `/api` → gateway |
| `SECURITY_NETWORK_SEGMENTATION` | `private-net` reachable from the host (debug) | Only the reverse proxy (or direct published ports) on the host |
| `SECURITY_AUDIT_TRAIL` | No audit service/DB; **producers still emit** to `audit.events` | Hash-chained store + forensic API |
| `SECURITY_SECURE_CHANNEL` | Plain HTTP (`http://localhost:8088` with proxy, or `http://localhost:8080` direct) | TLS 1.2+ at Nginx `:443` |

**Invalid:** `SECURITY_REVERSE_PROXY=false` with `SECURITY_NETWORK_SEGMENTATION=true`
(the gateway is not published when the private network is internal). `up.sh` refuses
to start that combination.

**Presets** (set in `infra/.env` or export before `./infra/up.sh`):

| Preset | RP | NS | AT | SC | Open | What to expect |
|--------|----|----|----|-----|------|----------------|
| Full security (default) | T | T | T | T | `https://localhost` | All four patterns active |
| Direct dev | F | F | T | T/F | `http://localhost:8080` or `https://localhost:8080` | Pre-proxy layout; gateway TLS if SC=T |
| No forensics | * | * | F | * | (same as RP/SC) | Login works; Kafka has `audit.events` but no consumer/DB/API |
| No edge TLS | T | T | * | F | `http://localhost:8088` | Proxy routing without `:443` |

With audit off, confirm producers still write events from inside the network:

```bash
docker compose exec kafka kafka-console-consumer.sh \
  --topic audit.events --bootstrap-server kafka:9093 --from-beginning
```

Advanced: raw `docker compose` requires matching `COMPOSE_PROFILES` and derived
vars (`GATEWAY_TLS_ENABLED`, `NEXT_PUBLIC_API_URL`, etc.) — see [`infra/.env.example`](infra/.env.example).
The desktop app (`npm run dev:desktop`) still needs direct gateway access
(`SECURITY_REVERSE_PROXY=false` and `SECURITY_NETWORK_SEGMENTATION=false`).

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

# 4. Start the full stack (respects SECURITY_* flags in infra/.env)
./infra/up.sh --build

# 5. Open the app (default flags: reverse proxy + TLS)
open https://localhost
```

> With default flags, traffic enters through the Nginx reverse proxy on ports
> 80/443. The gateway, services, databases and broker are on an internal-only
> Docker network and are **not** reachable from the host (Network Segmentation).
> Use `docker compose exec <service> ...` to reach them. See
> [Toggling patterns](#toggling-patterns-deploy-time-flags) to change modes.

## Remote access — share the app via a Cloudflare tunnel

To let people on other networks reach the app (e.g. to test multi-user servers
and voice channels), expose it with a [Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
quick tunnel. It needs no account and serves a real HTTPS certificate.

The reverse proxy has a dedicated plain-HTTP listener on **port 8088** for this
purpose — the tunnel terminates TLS itself, so it forwards to `:8088` rather
than the self-signed `:443`.

```bash
# 1. Install cloudflared (once)
brew install cloudflared          # macOS — see cloudflare docs for other OSes

# 2. Make sure the stack is running
./infra/up.sh -d

# 3. Open the tunnel (keep this terminal open while testing)
cloudflared tunnel --url http://localhost:8088
```

`cloudflared` prints a public URL like `https://<random-words>.trycloudflare.com`
— **that is the link you share**. Anyone can open it and register, log in,
create/join servers and chat.

Notes:

- The URL is **ephemeral** — a new random hostname is generated each time
  `cloudflared` starts.
- `apps/web-app/next.config.ts` already allows `*.trycloudflare.com` in
  `allowedDevOrigins`, which the Next.js dev server requires to accept the HMR
  WebSocket from the tunnel host. A different tunnel provider would need its
  domain added there (and a `web-app` restart).
- The web app uses an **origin-relative API base** (`NEXT_PUBLIC_API_URL=/api`),
  so it works on `localhost`, a LAN IP, or a tunnel URL with no rebuild.
- **Voice:** text/servers/channels work for everyone over the tunnel. Voice
  *audio* between people on different networks needs a TURN relay. The ICE
  servers are configured in the `ICE_SERVERS` array in
  `apps/web-app/app/components/VoiceChannelView.tsx` — uncomment the `turn:` /
  `turns:` entries (and supply working credentials) for reliable remote audio.
  STUN alone only connects peers on cooperative networks.

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
│   ├── docker-compose.gateway-direct.yml
│   ├── up.sh
│   └── .env.example
└── docs/
    └── service-descriptions.md
```

## Environment variables

See [`infra/.env.example`](infra/.env.example) for a full annotated list of every variable used across all services.

```bash
cp infra/.env.example infra/.env
# Edit infra/.env — at minimum set JWT_SECRET to a 32+ character secret
./infra/up.sh --build
```

`infra/.env` is git-ignored. Never commit real credentials.
