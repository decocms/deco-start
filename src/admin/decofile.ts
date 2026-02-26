import { loadBlocks } from "../cms/loader";

export function handleDecofileRead(): Response {
  const blocks = loadBlocks();

  return new Response(JSON.stringify(blocks), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
  });
}

export function handleDecofileReload(request: Request): Response {
  const authHeader = request.headers.get("authorization") || "";
  const expectedToken = process.env.DECO_RELOAD_TOKEN;

  if (expectedToken && !authHeader.includes(expectedToken)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // In the future, this will hot-swap the in-memory decofile.
  // For now, a redeploy is needed to pick up new blocks.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
