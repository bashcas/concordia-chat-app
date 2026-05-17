FROM golang:1.26-alpine AS build
WORKDIR /workspace

# Copy workspace descriptor so Go resolves local module replacements.
COPY go.work go.work.sum ./

# go.mod-only for workspace modules the audit service does not import — the
# workspace loader just needs them to exist.
COPY contracts/lib/go/authmw/go.mod contracts/lib/go/authmw/go.mod
COPY contracts/proto/gen/go/go.mod  contracts/proto/gen/go/go.mod
COPY services/gateway/go.mod        services/gateway/go.mod
COPY services/presence/go.mod       services/presence/go.mod

# Full source for the modules the audit service builds against.
COPY contracts/lib/go/audit contracts/lib/go/audit
COPY services/audit        services/audit

WORKDIR /workspace/services/audit
RUN CGO_ENABLED=0 go build -o /audit .

FROM alpine:3.20
COPY --from=build /audit /audit
ENTRYPOINT ["/audit"]
