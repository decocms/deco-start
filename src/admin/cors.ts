const ADMIN_ORIGINS = new Set([
  "https://admin.deco.cx",
  "https://v0-admin.deco.cx",
  "https://play.deco.cx",
  "https://admin-cx.deco.page",
  "https://deco.chat",
  "https://admin.decocms.com",
  "https://decocms.com",
]);

/**
 * Register additional allowed admin origins.
 * Useful for self-hosted admin UIs or custom dashboards.
 */
export function registerAdminOrigin(origin: string): void {
  ADMIN_ORIGINS.add(origin);
}

/**
 * Register multiple additional allowed admin origins.
 */
export function registerAdminOrigins(origins: string[]): void {
  for (const origin of origins) {
    ADMIN_ORIGINS.add(origin);
  }
}

export function isAdminOrLocalhost(request: Request): boolean {
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";

  if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
    return true;
  }

  for (const domain of ADMIN_ORIGINS) {
    if (origin.startsWith(domain)) return true;
  }
  return false;
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
    "Access-Control-Allow-Credentials": "true",
  };
}
