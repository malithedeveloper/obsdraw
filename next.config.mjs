const development = process.env.NODE_ENV !== "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  compress: true,
  turbopack: {
    root: process.cwd(),
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
  async rewrites() {
    return [{ source: "/view=:key", destination: "/view/:key" }];
  },
  async headers() {
    const scriptSources = ["'self'", "'unsafe-inline'"];
    if (development) scriptSources.push("'unsafe-eval'");
    const contentSecurityPolicy = [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' blob: data: https:",
      "media-src 'self' blob: https:",
      "object-src 'none'",
      `script-src ${scriptSources.join(" ")}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "worker-src 'self' blob:",
    ].join("; ");

    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};

export default nextConfig;
