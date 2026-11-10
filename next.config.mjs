/** @type {import('next').NextConfig} */
const nextConfig = {
  // PGlite is only used for local development and tests (DATABASE_URL=pglite:...).
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  async headers() {
    return [
      {
        // The site itself may only be framed by itself, and never sniffs content types.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
