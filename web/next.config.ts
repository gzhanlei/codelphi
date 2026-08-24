import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/chapters/new", destination: "/projects/new", permanent: false },
      { source: "/chapters/:id", destination: "/projects/:id", permanent: false },
    ];
  },
  async rewrites() {
    const gw = process.env.GATEWAY_URL || "http://127.0.0.1:18080";
    return [{ source: "/media/:path*", destination: `${gw}/media/:path*` }];
  },
};

export default nextConfig;
