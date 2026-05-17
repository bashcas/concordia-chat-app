import type { NextConfig } from "next";

// `output: "export"` with dynamic routes requires every visited URL to exist in
// `generateStaticParams()`. That cannot cover arbitrary server IDs during `next dev`,
// so we only enable static export for production builds (`npm run build`). Electron
// still loads `out/` from `next build`; `electron-serve` falls back to `index.html`
// for paths with no matching HTML file.
const nextConfig: NextConfig = {
  ...(process.env.NODE_ENV === "production" ? { output: "export" as const } : {}),
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
