import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Load test for GET /channels/{id}/messages to measure the Cache-Aside pattern in
// the Chat service. Run once with the cache disabled (every request -> Cassandra)
// and once enabled (mostly Redis), then compare http_reqs (req/s),
// http_req_duration p95, and the cache_hit_rate.
//
// BASE_URL should point at the gateway through the public path, e.g.
//   https://<nlb>.elb.us-east-1.amazonaws.com/api
const BASE = __ENV.BASE_URL || 'http://localhost:8080';

const cacheHits = new Rate('cache_hit_rate');

export const options = {
  vus: parseInt(__ENV.VUS || '1', 10),
  duration: __ENV.DURATION || '30s',
};

function asJson(res) {
  try {
    return res.json();
  } catch (e) {
    return {};
  }
}

// setup() runs once: create a user, a server, a channel, and seed ~30 messages.
export function setup() {
  const ts = Date.now();
  const email = `cacheuser${ts}@example.com`;
  const password = 'Passw0rd!';

  http.post(
    `${BASE}/auth/register`,
    JSON.stringify({ username: `cacheuser${ts}`, email, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const token = asJson(
    http.post(`${BASE}/auth/login`, JSON.stringify({ email, password }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ).access_token;

  const authJson = {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
  const serverId = asJson(
    http.post(`${BASE}/servers`, JSON.stringify({ name: `cache-${ts}` }), authJson),
  ).server_id;
  const channelId = asJson(
    http.post(
      `${BASE}/servers/${serverId}/channels`,
      JSON.stringify({ name: 'general', type: 'text' }),
      authJson,
    ),
  ).channel_id;

  // Seed the channel history. Defaults are light/fast (the cache value here is the
  // DB offload via hit-rate, not payload size). Override MSG_COUNT / MSG_SIZE to
  // make the Cassandra read heavier.
  const count = parseInt(__ENV.MSG_COUNT || '30', 10);
  const content = 'x'.repeat(parseInt(__ENV.MSG_SIZE || '40', 10));
  for (let i = 0; i < count; i++) {
    http.post(
      `${BASE}/channels/${channelId}/messages`,
      JSON.stringify({ content: `${i}:${content}` }),
      authJson,
    );
  }

  return { token, channelId };
}

const LIMIT = __ENV.MSG_LIMIT || '100';

export default function (data) {
  const res = http.get(`${BASE}/channels/${data.channelId}/messages?limit=${LIMIT}`, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
  check(res, { 'status is 200': (r) => r.status === 200 });
  // X-Cache is HIT when served from Redis, MISS when it hit Cassandra.
  cacheHits.add((res.headers['X-Cache'] || '') === 'HIT');
  sleep(0.1);
}
