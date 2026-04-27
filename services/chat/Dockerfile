# --- Builder Stage ---
# Using 'rust:slim' pulls the latest stable compiler that supports Edition 2024
FROM rust:slim AS builder

WORKDIR /app
COPY . .
RUN cargo build --release

# --- Runtime Stage ---
FROM debian:bookworm-slim

# Install dependencies for the runtime
RUN apt-get update && apt-get install -y libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin
COPY --from=builder /app/target/release/chat-service .

# Default Environment Variables
ENV CASSANDRA_HOSTS=172.17.0.1:9042
ENV CASSANDRA_KEYSPACE=discord_chat

EXPOSE 3000
CMD ["./chat-service"]