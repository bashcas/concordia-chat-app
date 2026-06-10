import type { NextConfig } from "next";

// Output mode:
//   - NEXT_OUTPUT=server -> a normal Next.js server build (run via `next start`).
//     Used for the server-hosted web deployment (AWS). Required so dynamic routes
//     like /servers/<id>/channels/<cid> render on demand — static export only
//     pre-renders the IDs from generateStaticParams() ([{id:'default'}]) and
//     hard-reloads to the root index.html for real IDs.
//   - production (no flag) -> static export to out/ (Electron loads it via electron-serve).
//   - dev -> next dev.
const output =
  process.env.NEXT_OUTPUT === "server"
    ? undefined
    : process.env.NODE_ENV === "production"
      ? ("export" as const)
      : undefined;

const nextConfig: NextConfig = {
  ...(output ? { output } : {}),
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // The dev server blocks cross-origin requests to /_next/* (incl. the HMR
  // WebSocket) by default. When the app is reached through a public tunnel,
  // the browser's origin is the tunnel host, so it must be allowed here.
  // The wildcard covers future tunnels; the explicit host is a guaranteed
  // fallback for the current cloudflared session.
  allowedDevOrigins: [
    "*.trycloudflare.com",
    "folks-focusing-garage-parker.trycloudflare.com",
    "localhost",
  ],
};

export default nextConfig;
