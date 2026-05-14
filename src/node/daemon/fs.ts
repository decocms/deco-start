import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import fjp from "fast-json-patch";
import type { Operation } from "fast-json-patch";
import { broadcastFsEvent, inferMetadata, toPosixPath } from "./watch";

export interface FsHandlerOptions {
  /** Filesystem root that path resolutions must stay within. */
  cwd: string;
}

interface Patch {
  type: "json" | "text";
  payload: Operation[];
}

/**
 * Web-standard `/fs/*` handler. Implements GET/PATCH/DELETE on
 * `/fs/file/<path>` and a `/fs/grep` stub used by the admin search UI.
 */
export async function handleFsRequest(
  req: Request,
  opts: FsHandlerOptions,
): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/fs/grep") {
    return jsonResponse(200, { matches: [], totalMatches: 0 });
  }

  if (!pathname.startsWith("/fs/file")) {
    return new Response(null, { status: 404 });
  }

  const filePath = extractFilePath(pathname);
  const systemPath = safePath(opts.cwd, filePath);
  if (!systemPath) return jsonResponse(403, { error: "Path traversal denied" });

  if (req.method === "GET") return getFile(systemPath);
  if (req.method === "PATCH") return patchFile(req, opts.cwd, systemPath);
  if (req.method === "DELETE") return deleteFile(opts.cwd, systemPath);
  return new Response(null, { status: 405 });
}

function safePath(cwd: string, untrusted: string): string | null {
  const resolved = resolve(cwd, untrusted.startsWith("/") ? `.${untrusted}` : untrusted);
  if (!resolved.startsWith(cwd + sep) && resolved !== cwd) return null;
  return resolved;
}

function extractFilePath(url: string): string {
  const [, ...segments] = url.split("/file");
  return segments.join("/file") || "/";
}

async function mtimeFor(filepath: string): Promise<number> {
  try {
    return (await stat(filepath)).mtimeMs;
  } catch {
    return Date.now();
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getFile(systemPath: string): Promise<Response> {
  try {
    const [content, metadata, timestamp] = await Promise.all([
      readFile(systemPath, "utf-8"),
      inferMetadata(systemPath),
      mtimeFor(systemPath),
    ]);
    return jsonResponse(200, { content, metadata, timestamp });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return jsonResponse(404, { timestamp: Date.now() });
    }
    throw err;
  }
}

function applyPatch(
  content: string | null,
  patch: Patch,
): { conflict: boolean; content?: string } {
  try {
    if (patch.type === "json") {
      const result = patch.payload.reduce(
        fjp.applyReducer,
        JSON.parse(content ?? "{}"),
      );
      return { conflict: false, content: JSON.stringify(result, null, 2) };
    }
    if (patch.type === "text") {
      const result = patch.payload.reduce(
        fjp.applyReducer,
        content?.split("\n") ?? [],
      );
      return { conflict: false, content: (result as string[]).join("\n") };
    }
  } catch (err: unknown) {
    if (err instanceof fjp.JsonPatchError && err.name === "TEST_OPERATION_FAILED") {
      return { conflict: true };
    }
    throw err;
  }
  return { conflict: true };
}

async function patchFile(
  req: Request,
  cwd: string,
  systemPath: string,
): Promise<Response> {
  let body: { patch: Patch; timestamp: number };
  try {
    body = (await req.json()) as { patch: Patch; timestamp: number };
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }

  const mtimeBefore = await mtimeFor(systemPath);
  let content: string | null;
  try {
    content = await readFile(systemPath, "utf-8");
  } catch {
    content = null;
  }

  const result = applyPatch(content, body.patch);
  if (!result.conflict && result.content != null) {
    await mkdir(join(systemPath, ".."), { recursive: true });
    await writeFile(systemPath, result.content, "utf-8");
  }

  const [metadata, mtimeAfter] = await Promise.all([
    inferMetadata(systemPath),
    mtimeFor(systemPath),
  ]);

  broadcastFsEvent({
    type: "fs-sync",
    detail: {
      metadata,
      timestamp: mtimeAfter,
      filepath: toPosixPath(systemPath.replace(cwd, "")),
    },
  });

  const update = result.conflict
    ? { conflict: true, metadata, timestamp: mtimeAfter, content }
    : {
        conflict: false,
        metadata,
        timestamp: mtimeAfter,
        content: mtimeBefore !== body.timestamp ? result.content : undefined,
      };
  return jsonResponse(200, update);
}

async function deleteFile(cwd: string, systemPath: string): Promise<Response> {
  try {
    await rm(systemPath, { force: true });
  } catch {
    // ignore
  }

  broadcastFsEvent({
    type: "fs-sync",
    detail: {
      metadata: null,
      timestamp: Date.now(),
      filepath: toPosixPath(systemPath.replace(cwd, "")),
    },
  });
  return jsonResponse(200, { conflict: false, metadata: null, timestamp: Date.now() });
}
