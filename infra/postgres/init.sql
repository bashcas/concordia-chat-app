-- Runs once on first container start (postgres docker-entrypoint-initdb.d).
-- POSTGRES_DB=discord_auth is created automatically by the env var.
-- These additional databases are created here for the other services.

CREATE DATABASE auth_db;
CREATE DATABASE servers_db;
CREATE DATABASE tips_db;
