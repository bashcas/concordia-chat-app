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
};

export default nextConfig;
