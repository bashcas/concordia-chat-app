FROM golang:1.22-alpine AS build
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 go build -o /app/gateway .

FROM alpine:3.20
COPY --from=build /app/gateway /gateway
ENTRYPOINT ["/gateway"]
