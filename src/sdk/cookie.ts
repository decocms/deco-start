export function getCookie(name: string): string {
  return globalThis.window?.document?.cookie?.split("; ").reduce((r, v) => {
    const parts = v.split("=");
    return parts[0] === name ? decodeURIComponent(parts[1]) : r;
  }, "") ?? "";
}

export function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  if (globalThis?.window?.document) {
    globalThis.window.document.cookie =
      name + "=" + encodeURIComponent(value) + "; expires=" + expires + "; path=/";
  }
}

export function deleteCookie(name: string) {
  if (globalThis?.window?.document) {
    globalThis.window.document.cookie =
      name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  }
}

export function getServerSideCookie(req: Request, name: string): string {
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .find((c) => c.trim().startsWith(name))
    ?.split("=")[1];
  return cookie ? decodeURIComponent(cookie) : "";
}

export function decodeCookie(cookieValue: string): any {
  try {
    return JSON.parse(decodeURIComponent(cookieValue));
  } catch {
    return null;
  }
}
