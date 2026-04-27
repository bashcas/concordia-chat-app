FROM golang:1.26-alpine AS build
WORKDIR /workspace

# Copy workspace descriptor so Go resolves local module replacements.
COPY go.work go.work.sum ./

# Copy every local module declared in go.work.
COPY contracts/lib/go/authmw contracts/lib/go/authmw
COPY contracts/proto/gen/go  contracts/proto/gen/go

# Presence is in go.work but not imported by gateway; only its go.mod is needed
# to satisfy the workspace loader.
COPY services/presence/go.mod services/presence/go.mod

# Copy gateway source last so earlier layers are cached across source changes.
COPY services/gateway services/gateway

WORKDIR /workspace/services/gateway
RUN CGO_ENABLED=0 go build -o /gateway .

FROM alpine:3.20
COPY --from=build /gateway /gateway
ENTRYPOINT ["/gateway"]
