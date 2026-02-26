const ADMIN_ORIGINS = [
  "https://admin.deco.cx",
  "https://v0-admin.deco.cx",
  "https://play.deco.cx",
  "https://admin-cx.deco.page",
  "https://deco.chat",
  "https://admin.decocms.com",
  "https://decocms.com",
];

export function isAdminOrLocalhost(request: Request): boolean {
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";

  if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
    return true;
  }

  return ADMIN_ORIGINS.some((domain) => origin.startsWith(domain));
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
