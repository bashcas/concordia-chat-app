# Security Architectural Patterns — Implementation Context (v3, final)

> **Purpose of this document**: handoff context for Claude Code to implement the remaining security patterns in the Concordia chat app project. The Secure Channel Pattern is **already implemented**. The remaining patterns to implement are: Reverse Proxy, Network Segmentation, and Audit Trail.
>
> **Changes from v2**: WAF removed as a candidate pattern. The team decided on **Audit Trail** as the third pattern because it is unambiguously architectural (introduces new components and connectors to the C&C view), whereas WAF risked being classified as detailed design when implemented as an Nginx module.

---

## 1. Project context

### 1.1. System under analysis

The project is **Concordia**, a Discord/Slack-like chat application. The Component-and-Connector (C&C) view contains:

- **Presentation layer**: `C-01 Web App` (implemented as **Server-Side Rendering** — see section 1.3 for important implications), `C-02 Desktop App`
- **Gateway**: `G-00 Gateway` (implemented in Go using `net/http`)
- **Application services**: `S-01 Auth Service`, `S-02 Chat Service`, `S-03 Presence Service`, `S-04 Voice Service`, `S-05 Servers Service`
- **Message broker**: `M-00 Message Broker`
- **Data stores**: `D-01 Auth DB`, `D-02 Chat DB`, `D-03 Object Store (S3)`, `D-04 Presence DB`, `D-05 Voice DB`, `D-06 Servers DB`

Connectors in the current C&C view:
- Clients ↔ Gateway: HTTP and WS
- Gateway ↔ services: HTTP and WS
- Auth Service ↔ Servers Service: gRPC
- Voice Service ↔ Servers Service: gRPC
- Services ↔ databases: native DB connections
- Chat Service → Object Store: HTTP
- Message Broker ↔ Auth Service / Chat Service: message (produce/consume)

### 1.2. Current Gateway responsibilities (Go, `services/gateway/`)

The Gateway currently does:
- **TLS termination** (Secure Channel Pattern — already implemented, will be moved to the Reverse Proxy)
- **JWT authentication** via `middleware/auth.go` (`RequireAuth`)
- **Rate limiting** per user via `middleware/ratelimit.go` (Redis-backed, 100 req/min)
- **CORS** handling via `middleware/cors.go`
- **Structured JSON logging** via `middleware/logger.go`
- **Path-based routing** to upstream services (Auth, Chat, Voice, Servers, Tips, Presence)
- **WebSocket upgrade and fan-out** via `ws/handler.go` (also handles `/internal/push` for Chat Service to push events to specific WebSocket sessions)
- **Public unauthenticated routes**: `GET /health`, `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`

### 1.3. IMPORTANT: SSR architecture of the Web App

The `C-01 Web App` is implemented as a **Server-Side Rendering** application (Next.js, Nuxt, Remix, SvelteKit, or similar framework). This is **architecturally significant** and affects how the patterns must be implemented.

**What SSR means**: the browser doesn't just download static JS and call the API. Instead:

1. **Phase 1 — Page load (SSR phase)**: when the user navigates to a URL like `/dashboard`, the request goes to an **SSR Server** that renders the HTML on the server side. The SSR Server calls the API Gateway internally to fetch the data needed for the page, builds the HTML, and returns it to the browser along with the JS bundle.

2. **Phase 2 — Interactive use (SPA phase)**: once the JS bundle is loaded and hydrated in the browser, the app behaves like a normal SPA. The browser makes XHR/fetch calls (login, send message, etc.) and opens WebSocket connections. **These calls go to the API Gateway**, not the SSR Server.

**Critical implication for the C&C view**: the current diagram showing `C-01 Web App` as a single component is a simplification. In reality there are two architectural elements:

- The **browser** running on the user's device (the actual presentation tier).
- The **SSR Server** running on the project's infrastructure (a server-side component that produces HTML).

Both must be considered when implementing the security patterns. The SSR Server is **not** a presentation component — it's a server-side component that lives inside the project's deployment, just like the API Gateway. After Network Segmentation, the SSR Server lives in the **private network**, not the public one.

### 1.4. The correct mental model after all patterns are implemented

After Network Segmentation + Reverse Proxy are implemented, the architecture looks like this:

```
                  ┌─────────────── Public network ───────────────┐
                  │                                              │
[Browser] ──HTTPS─┤              [Reverse Proxy]                 │
                  │                    │                         │
                  └────────────────────┼─────────────────────────┘
                                       │
                  ┌────────────────────┼─── Private network ─────┐
                  │                    │                         │
                  │     ┌──────────────┼──────────────┐          │
                  │     ▼              ▼              ▼          │
                  │ [SSR Server]  [API Gateway]   ...services    │
                  │     │              ▲                         │
                  │     └──────────────┘                         │
                  │   (SSR calls API for render data)            │
                  │                                              │
                  └──────────────────────────────────────────────┘
```

Key insights:

- The browser **only ever talks to the Reverse Proxy**. From its perspective, there is exactly one server out there: `https://your-domain.com`.
- The Reverse Proxy **routes by URL pattern**: page URLs go to the SSR Server, API/WebSocket URLs go to the API Gateway.
- The **API Gateway is private**. It is NOT reachable from the browser directly. Any documentation or diagram that shows the browser talking to the Gateway is describing the pre-segmentation state.
- The **SSR Server is also private**. It makes its own outbound calls to the API Gateway over the private network when it needs data to render pages.

After **Audit Trail** is also implemented, an additional component appears in the private network: the Audit Service, which subscribes to the existing Message Broker for audit events emitted by other services and persists them to its own append-only data store.

---

## 2. Already implemented: Secure Channel Pattern

### 2.1. Summary

The Secure Channel Pattern is **complete** and currently deployed with TLS termination directly in the Go Gateway via `crypto/tls`, using a project-owned Certificate Authority.

**Note**: when the Reverse Proxy is implemented (Pattern 1 below), TLS termination will be **moved from the Gateway to the Reverse Proxy**. The Gateway will then listen on plain HTTP inside the private network. The certificates, CA, and TLS configuration logic essentially migrate from `services/gateway/` to `services/reverse-proxy/`.

### 2.2. Quality scenario addressed

- **Source**: Attacker on the same network as a legitimate user (public Wi-Fi, compromised corporate network, intermediate ISP)
- **Stimulus**: Attempts to intercept, read, or modify traffic between client and the system
- **Artifact**: Connector from the browser to the system's public entry point
- **Environment**: Normal operation, traffic over public internet
- **Response**: TLS 1.2+ termination with modern cipher suites (ECDHE, AEAD). All HTTP and WS upgraded to HTTPS and WSS. Older TLS versions rejected.
- **Response measure**: 100% of public-facing traffic encrypted. Zero credentials/tokens/messages recoverable via sniffing. Min grade A on `testssl.sh`.

### 2.3. Current implementation summary (will be migrated to Reverse Proxy)

- OpenSSL-generated project CA (`ca.crt`, `ca.key`)
- Server certificate signed by the CA, with SAN entries for `localhost`, `gateway`, `127.0.0.1`
- Certificates mounted as read-only volume `/certs:ro` in Docker
- `services/gateway/main.go` uses `srv.ListenAndServeTLS()` with hardened `tls.Config`:
  - `MinVersion: tls.VersionTLS12`
  - Restricted cipher suites (ECDHE-based, AEAD modes)
  - Curve preferences: X25519, P-256
- Server timeouts added (`ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `IdleTimeout`) to mitigate slow-loris
- WebSocket upgrade automatically becomes WSS (inherits TLS tunnel)
- Test suite (30+ tests) unchanged — `buildMux` returns a transport-agnostic `http.Handler`
- Each developer must install `ca.crt` into their OS trust store (`security add-trusted-cert` on macOS, etc.)

### 2.4. Security analysis (vocabulary used in the deliverable)

- **Weakness**: Plaintext traffic between the browser and the system over the public internet.
- **Vulnerability**: HTTP and WebSocket traffic is not encrypted; no cryptographic verification of server identity.
- **Threat**: Attacker on the same network performing packet sniffing or man-in-the-middle.
- **Risk**: Theft of credentials, JWT tokens, exposure of private messages, silent manipulation of in-flight requests.
- **Attack**: Packet sniffing (Wireshark), MITM via ARP/DNS spoofing, evil twin Wi-Fi access points.
- **Countermeasure**: TLS 1.2+ termination at the system's public entry point with CA-signed X.509 certificates. AEAD modes guarantee integrity. Server certificate validation guarantees authentication.

---

## 3. To be implemented: Pattern 1 — Reverse Proxy

### 3.1. Conceptual clarification

The current Gateway is an **API Gateway** — it does application-level concerns (semantic routing, per-user JWT auth, per-user rate limiting, WebSocket fan-out). A **Reverse Proxy** is a different concern: a network/HTTP-level component that absorbs raw internet traffic before it hits anything else.

Industry-standard pattern is `Internet → Reverse Proxy → {SSR Server, API Gateway} → Microservices`. The Reverse Proxy and API Gateway coexist as distinct components.

### 3.2. Security analysis

- **Weakness**: After Network Segmentation, the only component exposed to the internet is whichever is placed in the public network. If that is the API Gateway directly, it concentrates the entire attack surface and is directly reachable by hostile, automated, or malformed traffic.
- **Vulnerability**: A public-facing API Gateway (or SSR Server) receives all internet traffic with no intermediary component acting as first line of defense, absorbing attacks, or hiding its existence. Any vulnerability in those components (Go bug, framework CVE, misconfiguration, compromised dependency) is directly exposed to the public internet.
- **Threat**: An attacker can direct hostile traffic at the public-facing component: scan its ports, identify the underlying technology via banner grabbing, launch massive request volumes, exploit known CVEs in identified dependencies.
- **Risk**: Public-component DoS (which takes down the whole system since it's the only entry point), CVE exploitation, technology fingerprinting that facilitates targeted attacks, resource consumption by abusive traffic instead of legitimate. **DDoS impact is amplified for SSR endpoints** because each page render is significantly more expensive than an API call (server-side JS execution + multiple internal API calls + HTML serialization).
- **Attack**: Volumetric DDoS, slow-loris, banner grabbing, fingerprinting, targeted CVE exploitation, layer-7 HTTP flood, SSR-targeted DDoS (cheap to launch, expensive to absorb).
- **Countermeasure**: Place a specialized Reverse Proxy (Nginx recommended) as the sole public-facing component. The Reverse Proxy becomes the only internet-exposed element of the system. Responsibilities: hide the existence and technology of both SSR Server and API Gateway, terminate TLS (taking certificate management out of those components), apply IP-based rate limiting (complementing the per-user JWT rate limiting that stays in the Gateway), apply **differentiated rate limits between SSR routes and API routes** because the cost profiles differ dramatically, distribute load if multiple instances exist, filter malformed requests, and absorb traffic spikes via buffering and connection pooling.

### 3.3. Reverse Proxy routing rules (CRITICAL — pay attention to SSR)

The Reverse Proxy is **not just a passthrough**. It performs URL-based routing between two internal destinations:

| URL pattern | Routes to | Reason |
|---|---|---|
| `GET /`, `GET /dashboard`, `GET /servers/*`, etc. | SSR Server | Page requests — server-rendered HTML |
| `GET /_next/*` or framework's static asset path | SSR Server (or CDN) | JS bundles, CSS, framework assets |
| `POST /auth/*`, `GET /api/*`, `POST /api/*`, etc. | API Gateway | All API calls |
| `WSS /ws` | API Gateway | WebSocket upgrade with proper header pass-through |
| `GET /health` | Handled by Reverse Proxy itself | Health check, no backend needed |

The exact URL prefixes depend on the SSR framework in use. Claude Code should inspect the Web App project to identify which framework is being used (look for `next.config.js`, `nuxt.config.js`, `svelte.config.js`, etc.) and configure routes accordingly.

### 3.4. Differentiated rate limiting (important for SSR)

SSR endpoints are dramatically more expensive than API endpoints. A page render typically involves:
- Server-side JavaScript execution
- Three to five internal API calls
- HTML serialization
- JS bundle preparation

Compared to an API call which is typically:
- One JWT verification
- One DB query or one downstream service call
- JSON serialization

This means the Reverse Proxy should apply **different rate limit zones** for the two route classes. Example Nginx configuration:

```nginx
limit_req_zone $binary_remote_addr zone=ssr_zone:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=api_zone:10m rate=100r/s;

location /api/ {
    limit_req zone=api_zone burst=20;
    proxy_pass http://gateway:8080;
}

location / {
    limit_req zone=ssr_zone burst=5;
    proxy_pass http://ssr-server:3000;
}
```

This is a meaningful security improvement and should be documented as such in the deliverable.

### 3.5. Implementation work needed

**What to move from Gateway to Reverse Proxy:**

1. **TLS termination**: move certificates and `ListenAndServeTLS` configuration from the Gateway to the Reverse Proxy. The Gateway goes back to listening on plain HTTP inside the private network.
2. **IP-based rate limiting**: coarse-grained layer that limits per source IP before requests reach the Gateway's per-user limiter.
3. **Request size limits / malformed request filtering**: reject obvious abuse early.
4. **Compression** (gzip/brotli): handled at the proxy edge.
5. **Connection management / keep-alive pooling**: terminate client connections at the proxy, multiplex over fewer connections to backends.
6. **Static asset serving** (if any): no need to bother the SSR or Gateway.
7. **Security headers**: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.

**What stays in the Gateway:**

- JWT authentication (`middleware/auth.go`)
- Per-user rate limiting (`middleware/ratelimit.go`)
- CORS (`middleware/cors.go`)
- Structured JSON logging
- Semantic path-based routing to upstream services
- WebSocket upgrade and fan-out logic (`ws/handler.go`)
- The `/internal/push` endpoint

**Concrete tasks:**

1. Create `services/reverse-proxy/` directory with:
   - `nginx.conf` configured to:
     - Listen on `:443` with TLS (move certificates here from the Gateway)
     - Listen on `:80` and redirect to `:443`
     - Route `/api/*` and `/ws` to the API Gateway (plain HTTP internally)
     - Route everything else (`/`, `/dashboard`, etc.) to the SSR Server (plain HTTP internally)
     - Support WebSocket upgrade headers (`Upgrade`, `Connection`) so WSS continues to work end-to-end through the proxy — without this, WS upgrade fails silently
     - Apply `limit_req_zone` with **two separate zones** for SSR and API routes
     - Set sensible client timeouts and body size limits
     - Add security headers
   - `Dockerfile` based on `nginx:alpine`
   - Mount the existing `ca.crt`/`server.crt`/`server.key` from `services/gateway/certs/` (or move them to a shared location like `infra/certs/`)
2. Modify `services/gateway/main.go`:
   - Remove TLS configuration entirely (or keep it behind a feature flag)
   - Listen on plain HTTP on an internal port
   - Keep the hardened timeouts (they still help in the private network)
3. Modify `docker-compose.yml`:
   - Add new `reverse-proxy` service that mounts certs and exposes port `443` (and `80` for redirect)
   - Gateway no longer exposes ports to the host — only the reverse proxy does
   - SSR Server (if managed by docker-compose) no longer exposes ports either
4. **Update clients**:
   - **No URL changes needed** in the browser code. The browser still hits `https://localhost:443` (or whatever the domain is). The Reverse Proxy is transparent to it.
   - The SSR Server's API client must point to the API Gateway via the **internal service name** (e.g., `http://gateway:8080`), not to the public URL. This is a configuration change in the Web App's env vars.
5. Update the C&C view:
   - Add new component `R-00 Reverse Proxy` between the browser and the internal components
   - Optionally add the SSR Server as a separate component (`S-07 SSR Server`) since it's architecturally distinct
   - Connector `Browser → Reverse Proxy` is HTTPS/WSS
   - Connectors `Reverse Proxy → SSR Server` and `Reverse Proxy → Gateway` are HTTP/WS (internal, plain)
   - Connector `SSR Server → Gateway` is HTTP (internal, plain) — this is the server-to-server API call during page renders
6. Update the deliverable document with the new architectural view showing the proxy and the SSR-aware routing.

### 3.6. Implementation notes for Claude Code

- The Reverse Proxy is a **new component**, not a modification of the Gateway. They have distinct responsibilities.
- WebSocket support in Nginx requires explicit `proxy_http_version 1.1` and the `Upgrade`/`Connection` header pass-through. Without this, the WS upgrade fails silently.
- The Gateway tests (`server_test.go`, etc.) should continue to pass unchanged because `buildMux` is transport-agnostic.
- Test the full chain end-to-end:
  - browser → Reverse Proxy (HTTPS) → SSR Server (HTTP) → renders HTML with data fetched from Gateway → browser receives HTML
  - browser → Reverse Proxy (HTTPS) → API Gateway (HTTP) → upstream service → response
  - browser → Reverse Proxy (WSS) → API Gateway (WS upgrade) → ws/handler.go
- Verify that JWT auth still works (it should — the Reverse Proxy just forwards the `Authorization` header) and that rate limiting is now applied at **two layers**: IP at the Reverse Proxy and user at the Gateway.
- After implementation, the SSR Server should NOT have any direct internet exposure. Confirm this by checking that `curl http://localhost:3000` (or whatever port the SSR uses) fails from the host once segmentation is also in place.

---

## 4. To be implemented: Pattern 2 — Network Segmentation

### 4.1. Security analysis

- **Weakness**: All system components (Reverse Proxy if present, SSR Server, API Gateway, microservices, databases, message broker) are deployed on a flat network with no separation between public and private zones, making them potentially reachable from the internet.
- **Vulnerability**: Components that should be exclusively internal (SSR Server, API Gateway, backend microservices, databases, message broker) are directly reachable from external networks instead of being isolated behind a single controlled entry point.
- **Threat**: An attacker could directly compromise a component that has public exposure without being designed for it (e.g., a backend microservice, an exposed database, or the SSR Server), taking advantage of the fact that it is reachable from the internet without passing through any intermediate control.
- **Risk**: Potential for massive data exfiltration (messages, stored credentials, user info), tampering with persisted data, or injection of malicious events into the broker.
- **Attack**: Direct unauthorized access to internal services, port scanning to discover open database (5432, 27017, 3306) or broker (5672, 9092) ports, exploitation of backend services that assume a trusted network and therefore have weak/no auth, brute-force connection attempts with default credentials, attacks targeting the SSR Server's Node.js runtime directly.
- **Countermeasure**: Split the deployment into at least two subnets: a **public subnet** hosting **only the Reverse Proxy** (the only component that should be reachable from the internet), and a **private subnet** hosting the SSR Server, API Gateway, microservices, databases, message broker, and the new Audit Service (Pattern 3). The private subnet only accepts traffic from the public subnet (specifically from the Reverse Proxy).

### 4.2. Correct placement of components (post-segmentation)

This is the explicit answer to "is X public or private?":

| Component | Network | Reasoning |
|---|---|---|
| Reverse Proxy | **Public** | The only component intentionally exposed to the internet. |
| SSR Server | **Private** | Renders pages but should never be hit directly from the internet. The Reverse Proxy is its only legitimate caller. |
| API Gateway | **Private** | All API and WebSocket traffic arrives via the Reverse Proxy. The browser never connects to the Gateway directly. |
| Auth, Chat, Presence, Voice, Servers services | **Private** | Backend services called only by the Gateway and (for some service-to-service interactions) by each other. |
| Auth DB, Chat DB, Presence DB, Voice DB, Servers DB | **Private** | Databases must never be directly reachable from outside. |
| Object Store (S3) | **Private** | If self-hosted (MinIO), must be private. If a managed cloud service, it's outside the docker-compose scope. |
| Message Broker | **Private** | Internal message bus only. |
| Redis (used by rate limiter) | **Private** | Internal infrastructure. |
| **Audit Service** (Pattern 3) | **Private** | Consumes events from broker, stores them privately. |
| **Audit Log Store** (Pattern 3) | **Private** | Sensitive forensic data, must never be public. |

### 4.3. Implementation work needed

Since the project uses Docker Compose, network segmentation is implemented at the **Docker networks** level rather than at the cloud VPC level. This is fully valid for the lab and demonstrates the same architectural principle.

**Concrete tasks:**

1. Modify `docker-compose.yml` to define two networks:
   ```yaml
   networks:
     public-net:
       driver: bridge
     private-net:
       driver: bridge
       internal: true   # critical: prevents external network access from this net
   ```
   The `internal: true` flag prevents containers on `private-net` from reaching the host or external networks — they can only communicate with other containers on the same network.

2. Assign each service to the appropriate network(s):
   - **`reverse-proxy`**: on `public-net` AND `private-net` (bridges the two). This is the only component that listens on a host port.
   - **`ssr-server`** (Web App container): on `private-net` only. No host port mapping.
   - **`gateway`**: on `private-net` only. **Remove `ports:` mapping**.
   - **All microservices** (`auth`, `chat`, `presence`, `voice`, `servers`): on `private-net` only.
   - **All databases**: on `private-net` only. Definitely no host port mappings.
   - **Message broker**: on `private-net` only.
   - **Object Store** (e.g., MinIO): on `private-net` only.
   - **Redis**: on `private-net` only.
   - **`audit` service** (after Pattern 3): on `private-net` only.
   - **`audit-store`** (after Pattern 3): on `private-net` only.

3. Verify isolation:
   ```bash
   # From the host, these should all fail (no route):
   curl http://localhost:8080/health   # Gateway port
   curl http://localhost:3000/         # SSR Server port
   psql -h localhost -p 5432           # Auth DB port
   
   # From the host, only the reverse proxy should be reachable:
   curl https://localhost/health       # OK, through proxy
   curl https://localhost/             # OK, page rendered by SSR via proxy
   curl https://localhost/api/health   # OK, API call via Gateway through proxy
   ```

4. Update the **Deployment view** of the architecture to show:
   - A "public subnet" box containing only the Reverse Proxy
   - A "private subnet" box containing the SSR Server, Gateway, services, databases, broker, and Audit Service
   - A boundary line indicating no direct connectivity from internet to private subnet
   - The only allowed connections: Internet → Reverse Proxy → (crosses boundary) → SSR Server or Gateway

5. Update the deliverable document with the Deployment view diagram showing the segmentation.

### 4.4. Implementation notes for Claude Code

- The `internal: true` on the private network is the technical mechanism that enforces segmentation in Docker. Without it, containers can still reach the internet outbound.
- Some services may need outbound internet access (downloading dependencies during build, pushing metrics, sending emails). For those cases an explicit egress mechanism is needed; for the lab scope this can be ignored or addressed by temporarily allowing egress only for the affected service.
- Pre-segmentation check: list every `ports:` entry in `docker-compose.yml`. After segmentation, only the reverse proxy should have any.
- Cross-network communication is **automatic** for the reverse proxy (which is on both networks). No special configuration needed beyond network membership.
- Be careful with the rate limiter's Redis instance: it must be on `private-net` and reachable from the Gateway, but never from the host.
- A common mistake: leaving a database with `ports: - "5432:5432"` and assuming the new network config protects it — it doesn't, because `ports:` is a host-level mapping that bypasses Docker networks.
- Verify that the SSR Server can still reach the Gateway through `http://gateway:8080` (or whatever the internal hostname is). This is the connector for server-side data fetching during page renders.

---

## 5. To be implemented: Pattern 3 — Audit Trail

### 5.1. Why this pattern (vs. WAF)

The team considered WAF as a third pattern but rejected it for the following reasons:

- **WAF risks being classified as detailed design** when implemented as a Nginx module (ModSecurity), because it would be a configuration change inside an existing component (the Reverse Proxy) rather than a true architectural addition. The professor previously commented that rate-limiting in the login endpoint is detailed design rather than architecture for the same reason.
- **WAF as a separate component** would be redundant with the Reverse Proxy, both being "perimeter components that filter traffic".
- **Audit Trail is unambiguously architectural**: it introduces a new component (Audit Service), a new data store (Audit Log Store), and new message connectors from existing services to the broker for audit events.
- **Audit Trail covers a tactical category that no other lab pattern touches**: Recover from Attacks (specifically the Maintain Audit Trail tactic). Secure Channel, Network Segmentation, and Reverse Proxy all belong to Resist Attacks. Including Audit Trail demonstrates breadth across the security tactics taxonomy.

### 5.2. Security analysis

- **Weakness**: Sensitive actions in the system (logins, permission changes, message deletions, channel administration, server creation, role grants) are not recorded in an immutable, security-focused log. The existing logs emitted by `middleware/logger.go` are operational logs (one line per HTTP request) intended for debugging and monitoring, not for forensics or compliance.
- **Vulnerability**: Without an immutable audit trail, the system has no reliable way to reconstruct what happened during a security incident. Operational logs can be tampered with or deleted by anyone who compromises a service container; they live in the same trust zone as the services that produce them. Additionally, non-repudiation is impossible — a malicious user can deny that they performed an action, and the system cannot prove otherwise.
- **Threat**: A malicious insider (a compromised service operator) or an external attacker who has gained access through any other compromise could modify data, escalate privileges, exfiltrate information, and then erase traces from operational logs to cover their tracks. Alternatively, a legitimate but malicious user could perform damaging actions (delete channels, kick users, leak messages) and later deny doing so.
- **Risk**: Inability to detect that a breach occurred (silent compromise), inability to determine the scope of a breach when one is suspected, inability to attribute actions to specific users for accountability or legal proceedings, regulatory non-compliance with frameworks that require audit trails (GDPR Article 30 requires records of processing activities, SOC 2 requires audit logging of access to customer data).
- **Attack**: Log tampering after a successful intrusion, log deletion to cover tracks, action repudiation by malicious users, undetected lateral movement post-compromise, undetected privilege escalation through application logic.
- **Countermeasure**: Introduce a dedicated **Audit Service** component that consumes audit events from the existing Message Broker. Each service in the system publishes audit events (login success/failure, permission change, sensitive read/write) to an `audit.events` topic. The Audit Service validates and persists these events to an **append-only Audit Log Store**, separate from the operational databases and inaccessible to the services that emit events. Events are cryptographically chained (each event includes the hash of the previous event) so any tampering is detectable. The audit store has restricted access (read-only for forensics, append-only for the Audit Service itself).

### 5.3. Architectural changes to the C&C view

After implementing Audit Trail, the C&C view gains:

**New components:**
- `S-06 Audit Service` — consumes events, validates them, writes to the audit store.
- `D-07 Audit Log Store` — append-only data store for audit events.

**New connectors:**
- `Auth Service → Message Broker`: message (produce `audit.events`)
- `Chat Service → Message Broker`: message (produce `audit.events`)
- `Servers Service → Message Broker`: message (produce `audit.events`)
- `Voice Service → Message Broker`: message (produce `audit.events`) — optional, depending on what voice events are auditable
- `API Gateway → Message Broker`: message (produce `audit.events`) — for security-relevant events like failed JWT validations and rate limit hits
- `Message Broker → Audit Service`: message (consume `audit.events`)
- `Audit Service → Audit Log Store`: DB Connection (append-only)

Note that some of these services may already produce other types of messages to the broker (e.g., Auth and Chat already do). The new `audit.events` topic is a separate logical channel on the same broker — no new physical broker needed.

### 5.4. Audit event schema

Each audit event should include at minimum:

```json
{
  "event_id": "uuid-v4",
  "event_type": "auth.login.success | auth.login.failure | servers.member.kick | ...",
  "timestamp": "2026-05-16T14:30:00.000Z",
  "actor": {
    "user_id": "user-abc-123",
    "ip": "203.0.113.42",
    "user_agent": "..."
  },
  "resource": {
    "type": "server | channel | message | user | ...",
    "id": "resource-identifier"
  },
  "outcome": "success | failure",
  "metadata": { /* event-specific fields */ },
  "prev_hash": "sha256-of-previous-event",
  "hash": "sha256-of-this-event-fields"
}
```

The `prev_hash`/`hash` chain makes the audit log tamper-evident: if any event is modified or deleted, all subsequent hashes break. The Audit Service is responsible for computing these hashes when it receives an event.

### 5.5. Which events should be audited

A reasonable scope for this lab:

| Source service | Events to audit |
|---|---|
| Auth Service | Login attempts (success and failure), registration, password change, token refresh, account lockout |
| Servers Service | Server creation/deletion, channel creation/deletion, role creation/update/delete, permission changes, member kick/ban/unban |
| Chat Service | Message deletion (not creation — too noisy), attachment upload (metadata only, not content) |
| Voice Service | Voice session establishment/teardown (optional) |
| API Gateway | JWT validation failures (potential token forgery), rate limit threshold breaches |

Avoid auditing high-volume read operations (every message read, every channel listing) — the audit trail should focus on **state-changing or security-relevant** events.

### 5.6. Choice of audit store technology

Recommended options, in order of preference for this lab:

1. **PostgreSQL with INSERT-only permissions** — simple, well-known, easy to query for forensics. Use a database role for the Audit Service that has `INSERT` and `SELECT` but no `UPDATE` or `DELETE` permissions on the audit table. This is "append-only" by access control.
2. **Elasticsearch** — better query capabilities for forensics (full-text search, time-range queries, aggregations), but more operational complexity.
3. **MinIO with object versioning and retention** — closest to true immutability for self-hosted setups, but harder to query.

For the lab, **PostgreSQL with INSERT-only permissions** is the right balance of architectural validity (it's a separate data store) and implementation simplicity.

### 5.7. Implementation work needed

**Concrete tasks:**

1. **Create `services/audit/`** as a new Go (or any language) microservice:
   - Subscribes to the `audit.events` topic on the Message Broker
   - Validates each incoming event against a schema (use JSON Schema or a Go struct with tags)
   - Computes the `hash` field using SHA-256 over canonical-serialized event fields
   - Looks up the previous event's hash to populate `prev_hash` (uses a small in-memory cache or queries the store)
   - Persists the event to the audit store
   - Exposes a small read-only HTTP endpoint (`GET /audit/events?...`) for forensic querying, protected by admin-level JWT (different scope from regular user JWTs)

2. **Create `contracts/lib/<lang>/audit/`** — a shared library with:
   - The audit event struct/schema
   - A helper function `EmitAuditEvent(ctx, broker, eventType, actor, resource, outcome, metadata)` that other services can call
   - Constants for all defined `event_type` values (so services can't typo them)

3. **Instrument existing services** to emit audit events at the right code paths:
   - In `services/auth/`: after successful login, after failed login, after registration, etc.
   - In `services/servers/`: after each state-changing operation
   - In `services/chat/`: after message deletion, attachment upload
   - In `services/gateway/`: in `middleware/auth.go` when JWT validation fails (with the reason), in `middleware/ratelimit.go` when a user exceeds the limit
   - Use the helper from `contracts/lib/<lang>/audit/` to ensure consistency

4. **Provision the audit store**:
   - Add a new `audit-db` service to `docker-compose.yml` (PostgreSQL)
   - Initialize schema with a single `audit_events` table matching the schema in 5.4
   - Create two DB roles:
     - `audit_writer`: `INSERT` and `SELECT` only — used by the Audit Service
     - `audit_reader`: `SELECT` only — used by the forensic query endpoint
   - Provide credentials via env vars

5. **Update `docker-compose.yml`**:
   - Add `audit` service
   - Add `audit-db` service
   - Both on `private-net` only (no host port mappings)

6. **Update the C&C view** with `S-06`, `D-07`, and the new connectors (see 5.3).

7. **Update the Deployment view** to place the Audit Service and Audit Log Store in the private subnet.

### 5.8. Implementation notes for Claude Code

- Each emitting service should publish to `audit.events` in a **fire-and-forget** manner — emitting an audit event must not block the main business logic. If the broker is unavailable, the operational service should continue; the audit emission can be queued locally and retried, or simply dropped with a log warning. The trade-off here is documented in the deliverable.
- The hash chain must be **per-event-source** or **global**? Recommend **global** for simplicity: the Audit Service maintains one chain across all events, and uses event timestamps + a sequence number to order them. This avoids partitioning complexity but means the Audit Service is a single point of serialization.
- Be careful with sensitive data in audit events: do **not** include password values, full JWT tokens, or message contents. Include identifiers (user ID, message ID) and metadata (length, type) only. Reproducing sensitive data in the audit log would defeat its security purpose.
- The forensic query endpoint should be heavily restricted: separate JWT scope, additional rate limiting, and ideally only accessible from a specific operator IP range.
- Test the tamper-detection property: after the Audit Service writes a few events, manually `UPDATE` one of them in PostgreSQL and verify that a hash-chain validation routine detects the inconsistency.

---

## 6. Defense-in-depth narrative (for the deliverable)

Once all three remaining patterns are implemented (in addition to the already-deployed Secure Channel), the architectural story is:

1. **Reverse Proxy** absorbs raw internet traffic, terminates TLS, applies IP-based rate limiting (with stricter limits on expensive SSR routes than on cheap API routes), and routes by URL pattern between the SSR Server and the API Gateway. It is the **only** internet-exposed component.
2. **Network Segmentation** ensures that even if an attacker tries to bypass the Reverse Proxy, nothing else is reachable from outside. The SSR Server, Gateway, services, databases, broker, and Audit Service all live in an internal-only network.
3. **Secure Channel** ensures that all traffic between the user and the system is encrypted in transit. After migration, TLS is terminated at the Reverse Proxy.
4. **Audit Trail** records all sensitive actions in an immutable, hash-chained log. If any of the above layers fail and an attacker reaches the system, the team can detect and forensically reconstruct what happened — and the tamper-evident chain ensures the attacker cannot cover their tracks.

Each pattern assumes the previous ones might fail and adds another layer. This is the textbook definition of **defense in depth**, deliberately spanning multiple categories of security tactics:

- **Resist Attacks**: Secure Channel (Encrypt Data), Network Segmentation (Limit Access), Reverse Proxy (Limit Exposure)
- **Recover from Attacks**: Audit Trail (Maintain Audit Trail)

---

## 7. Cross-cutting implementation guidance

### 7.1. Order of implementation

Recommended order:

1. **Reverse Proxy first.** Set up the routing rules between SSR Server and Gateway, migrate TLS, get the end-to-end chain working over the existing flat network.
2. **Network Segmentation second.** Now that the Reverse Proxy is the single entry point, isolate everything else into the private network.
3. **Audit Trail third.** With the infrastructure stabilized, add the new Audit Service and Audit Log Store, then instrument the existing services to emit events.

Rationale: doing Network Segmentation before the Reverse Proxy creates a confusing intermediate state where you've isolated things into a private network but nothing is in the public network yet. Doing Audit Trail before the other two means new audit-relevant components would also need to be re-placed during segmentation, doubling the work.

### 7.2. Testing strategy

- After each pattern, verify both functional correctness (existing tests pass, end-to-end flows work) and security properties:
  - **After Reverse Proxy**: confirm that:
    - Page loads still work (browser → proxy → SSR Server → page rendered)
    - API calls still work (browser → proxy → Gateway → service)
    - WebSocket connections still work (browser → proxy → Gateway → ws handler)
    - JWT auth still works through the proxy
    - Differentiated rate limits work (a flood of SSR requests gets rate-limited more aggressively than a flood of API requests)
  - **After Segmentation**: confirm that database/broker/Gateway/SSR ports are no longer reachable from the host. Only the proxy port should be.
  - **After Audit Trail**:
    - A login attempt produces an event visible in the audit store
    - A failed login also produces an event (with `outcome: failure`)
    - The hash chain validates: re-computing the hash of each event matches the stored value, and `prev_hash` chain is unbroken
    - Tampering test: manually `UPDATE` an event in the DB, then run the validation routine; it should report the chain is broken
    - The forensic query endpoint requires admin JWT and rejects regular user JWTs

### 7.3. Documentation deliverables

Each pattern's deliverable should include:
- Brief description and purpose
- Quality scenario addressed (CIA property)
- Architectural view (C&C and/or Deployment) showing the new components/connectors
- Step-by-step implementation guide
- Code/configuration snippets
- Results and observed improvements
- Recommendations for replication by other teams
- The six-element security analysis (Weakness, Vulnerability, Threat, Risk, Attack, Countermeasure)

### 7.4. Files likely affected

| Concern | Files |
|---|---|
| Reverse Proxy | New: `services/reverse-proxy/nginx.conf`, `services/reverse-proxy/Dockerfile`. Modified: `docker-compose.yml`, `services/gateway/main.go`, env vars in the Web App for internal API URL |
| Network Segmentation | Modified: `docker-compose.yml` only (networks section + service network assignments) |
| Audit Trail | New: `services/audit/*`, `contracts/lib/<lang>/audit/`, `services/audit-db/init.sql`. Modified: every service that emits events (auth, chat, servers, voice, gateway), `docker-compose.yml` |

### 7.5. Migration considerations

- **TLS certificates**: when Reverse Proxy is introduced, move certificates from `services/gateway/certs/` to `services/reverse-proxy/certs/` (or a shared `infra/certs/`).
- **The Gateway's `main.go`**: keep the hardened timeouts even after removing TLS — they're still useful inside the private network.
- **The Gateway's test suite**: should continue to pass without modification. If any test starts failing, that's a signal that an architectural change accidentally leaked into application code.
- **The Web App's API client configuration**: must be updated to point to the Gateway via its **internal hostname** during server-side rendering, and via the **public domain through the proxy** during client-side fetches in the browser. Many SSR frameworks have separate env vars for this.
- **Documentation in README**: each pattern adds setup steps. Keep README current so new developers can bring up the full stack.
- **Audit instrumentation**: emitting audit events from existing services should be done with care — wrap the helper in a way that **never** breaks the main code path. Audit failures should log a warning but not return an error to the user.

---

## 8. Open questions for the team

1. **Reverse Proxy technology**: Nginx (recommended for ease), Traefik (better for Docker-native dynamic config), or HAProxy?
2. **Audit store technology**: recommended PostgreSQL with INSERT-only permissions for simplicity, but the team may prefer Elasticsearch or MinIO if there's a specific reason.
3. **SSR framework specifics**: what framework is the Web App using? This determines the exact URL patterns the Reverse Proxy must route to the SSR Server (`/_next/*` for Next.js, `/_nuxt/*` for Nuxt, etc.).
4. **Audit retention policy**: how long should audit events be kept? For the lab, indefinite retention is fine; in production this would be a compliance-driven decision.
5. **Hash chain scope**: global chain (single sequence across all events) or per-source chain (one sequence per service)? Recommended global for simplicity; document the trade-off in the deliverable.
6. **Should internal connectors also be encrypted (mTLS)?** Currently Secure Channel only covers the external connector. Adding mTLS for Reverse Proxy↔Gateway, Reverse Proxy↔SSR, Gateway↔services, and Audit Service↔broker is a separate decision and not strictly required by the lab.
