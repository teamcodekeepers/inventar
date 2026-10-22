import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";
/** Swagger UI (/docs/api/swagger) се зарежда от този CDN. */
const CDN = "https://cdn.jsdelivr.net";

const csp = [
  "default-src 'self'",
  // Next.js вгражда inline скриптове за хидратация; в dev режим и eval за Fast Refresh
  `script-src 'self' 'unsafe-inline' ${CDN}${dev ? " 'unsafe-eval'" : ""}`,
  `style-src 'self' 'unsafe-inline' ${CDN}`,
  `img-src 'self' data: blob: ${CDN}`,
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // камерата е нужна за сканирането на баркодове
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];

// Споделеният хостинг (Hostinger) ограничава броя процеси и нишки. По подразбиране build пуска worker на
// ядро (63 там), а native модулите — нишка на ядро → „OS can't spawn worker thread“.
process.env.TOKIO_WORKER_THREADS ??= "2";

const nextConfig: NextConfig = {
  // pdfkit чете собствените си файлове с данни по време на изпълнение — не се пакетира
  serverExternalPackages: ["pdfkit", "bwip-js"],
  experimental: {
    cpus: 2,
    // Качване на снимки на артикули (до 10 MB на файл); по подразбиране е 1 MB.
    serverActions: { bodySizeLimit: "40mb" },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // токенът е в адреса: да не изтича чрез Referer
      { source: "/reset-password", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
