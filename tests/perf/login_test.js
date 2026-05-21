import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const USER = {
  email: __ENV.TEST_EMAIL || 'loadtest@example.com',
  password: __ENV.TEST_PASSWORD || 'LoadTest123!',
};

export const options = {
  vus: parseInt(__ENV.VUS || '1', 10),
  duration: __ENV.DURATION || '30s',
};

export function setup() {
  http.post(
    `${BASE}/auth/register`,
    JSON.stringify({
      username: 'loadtest',
      email: USER.email,
      password: USER.password,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

export default function () {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify(USER),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
