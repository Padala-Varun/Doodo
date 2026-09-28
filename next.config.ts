import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Native / heavy server-only packages stay external to the server bundle.
  serverExternalPackages: ["sharp", "mathjax-full"],
};

export default nextConfig;
