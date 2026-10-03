import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  webpack: (config) => {
    // Bundle markdown files (e.g. the H3 prompt guide) as raw source strings.
    if (!config.module) config.module = {};
    if (!config.module.rules) config.module.rules = [];
    config.module.rules.push({ test: /\.md$/, type: "asset/source" });
    return config;
  },
};

export default nextConfig;
