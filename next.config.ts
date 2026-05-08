import path from "path";
import { fileURLToPath } from "url";

import type { NextConfig } from "next";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: currentDirPath,
};

export default nextConfig;