-- Runs once via cassandra-init after Cassandra passes its healthcheck.
-- SimpleStrategy with RF=1 is appropriate for a single-node dev cluster.

CREATE KEYSPACE IF NOT EXISTS discord_chat
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
