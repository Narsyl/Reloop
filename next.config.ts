import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // A stray package-lock.json exists in the user's home dir; pin the
  // workspace root so Turbopack doesn't walk up and pick it.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
