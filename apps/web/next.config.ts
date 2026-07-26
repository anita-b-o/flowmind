import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@automation/ui"],
  async rewrites() {
    const origin = process.env.FLOWMIND_API_ORIGIN?.replace(/\/+$/, "");
    if (!origin) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${origin}/:path*`
      }
    ];
  }
};

export default nextConfig;
