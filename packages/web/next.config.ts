import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These open the SQLite file and read changesets from disk; they must load as
  // real Node modules at runtime, not be bundled.
  serverExternalPackages: ["@apiwatcher/server", "apiwatcher-cli"],
  // The scanner and dashboard share one box; no image pipeline is needed.
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default nextConfig;
