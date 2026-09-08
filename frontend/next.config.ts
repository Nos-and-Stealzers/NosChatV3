import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly — without this, Next.js/Turbopack can
  // misdetect the root if a package-lock.json exists in a parent directory
  // outside this git repo (it did, on this machine).
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
