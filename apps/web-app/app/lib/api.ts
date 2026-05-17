// API base path. Default is the ORIGIN-RELATIVE "/api", so the app works on
// any host — localhost, a LAN IP, or a public tunnel URL — with no rebuild.
// The reverse proxy strips /api and forwards to the gateway. An absolute URL
// can still be supplied via NEXT_PUBLIC_API_URL if ever needed.
const GATEWAY = process.env.NEXT_PUBLIC_API_URL || '/api';

export function getWebSocketUrl(path: string = '/ws'): string {
  // WebSockets go through the same /api prefix as REST calls; the reverse
  // proxy strips /api and the gateway sees the original path (/ws,
  // /voice/{id}/signal, ...).
  let wsGateway: string;
  if (/^https?:/i.test(GATEWAY)) {
    // Absolute API URL configured — just swap the scheme to ws(s).
    wsGateway = GATEWAY.replace(/^http/i, 'ws');
  } else if (typeof window !== 'undefined') {
    // Origin-relative base — build an absolute ws(s) URL from the current page.
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsGateway = `${scheme}//${window.location.host}${GATEWAY}`;
  } else {
    wsGateway = GATEWAY;
  }
  let url = `${wsGateway}${path}`;
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('access_token');
    if (token) {
      url += `?token=${token}`;
    }
  }
  return url;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${GATEWAY}/${path.replace(/^\/+/, '')}`;
  const headers = new Headers(init?.headers);
  
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('access_token');
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  let res = await fetch(url, { ...init, headers });

  if (res.status === 401 && typeof window !== 'undefined') {
    const refreshToken = localStorage.getItem('refresh_token');
    if (refreshToken) {
      try {
        const refreshRes = await fetch(`${GATEWAY}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });

        if (refreshRes.ok) {
          const { access_token } = await refreshRes.json();
          localStorage.setItem('access_token', access_token);
          headers.set('Authorization', `Bearer ${access_token}`);
          res = await fetch(url, { ...init, headers });
        } else {
          localStorage.removeItem('access_token');
          localStorage.removeItem('refresh_token');
          window.location.href = '/login';
        }
      } catch (err) {
        // ignore
      }
    }
  }

  return res;
}
