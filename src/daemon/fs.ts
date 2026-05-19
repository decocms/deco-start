/**
 * Filesystem REST API — read, patch, delete .deco/ files.
 *
 * The admin UI reads individual files via GET /fs/file/<path>.
 * This is separate from the volumes/realtime WebSocket API.
 *
 * Ported from: deco-cx/deco daemon/fs/api.ts
 */
import { readFile, writeFile, rm, stat, mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import fjp from "fast-json-patch";
import type { Operation } from "fast-json-patch";
import { inferMetadata, broadcastFSEvent, type Metadata } from "./watch";

const cwd = process.cwd();
const toPosix = (p: string) => p.replaceAll(sep, "/");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safePath(untrusted: string): string | null {
  const resolved = resolve(cwd, untrusted.startsWith("/") ? `.${untrusted}` : untrusted);
  if (!resolved.startsWith(cwd + sep) && resolved !== cwd) return null;
  return resolved;
}

function extractFilePath(url: string): string {
  // URL: /fs/file/.deco/blocks/site.json
  const [, ...segments] = url.split("/file");
  return segments.join("/file") || "/";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function mtimeFor(filepath: string): Promise<number> {
  try {
    const stats = await stat(filepath);
    return stats.mtimeMs;
  } catch {
    return Date.now();
  }
}

// ---------------------------------------------------------------------------
// Patch application — matches daemon/fs/common.ts
// ---------------------------------------------------------------------------

interface Patch {
  type: "json" | "text";
  payload: Operation[];
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
    if (
      err instanceof fjp.JsonPatchError &&
      err.name === "TEST_OPERATION_FAILED"
    ) {
      return { conflict: true };
    }
    throw err;
  }
  return { conflict: true };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createFSHandler() {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    // Only handle /fs/file/* paths
    if (!pathname.startsWith("/fs/file")) {
      // Also handle /fs/grep (admin search)
      if (pathname === "/fs/grep") {
        // Minimal grep stub — return empty results
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ matches: [], totalMatches: 0 }));
        return;
      }
      next();
      return;
    }

    const filePath = extractFilePath(pathname);
    const systemPath = safePath(filePath);

    if (!systemPath) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Path traversal denied" }));
      return;
    }

    // GET /fs/file/* — read file
    if (req.method === "GET") {
      try {
        const [content, metadata, mtime] = await Promise.all([
          readFile(systemPath, "utf-8"),
          inferMetadata(systemPath),
          mtimeFor(systemPath),
        ]);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content, metadata, timestamp: mtime }));
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ timestamp: Date.now() }));
          return;
        }
        throw err;
      }
      return;
    }

    // PATCH /fs/file/* — apply JSON patch
    if (req.method === "PATCH") {
      const raw = await readBody(req);
      let body: { patch: Patch; timestamp: number };
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
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
        const dir = join(systemPath, "..");
        await mkdir(dir, { recursive: true });
        await writeFile(systemPath, result.content, "utf-8");
      }

      const [metadata, mtimeAfter] = await Promise.all([
        inferMetadata(systemPath),
        mtimeFor(systemPath),
      ]);

      // Broadcast change for SSE listeners
      broadcastFSEvent({
        type: "fs-sync",
        detail: {
          metadata,
          timestamp: mtimeAfter,
          filepath: toPosix(systemPath.replace(cwd, "")),
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

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(update));
      return;
    }

    // DELETE /fs/file/*
    if (req.method === "DELETE") {
      try {
        await rm(systemPath, { force: true });
      } catch {
        // ignore
      }

      broadcastFSEvent({
        type: "fs-sync",
        detail: {
          metadata: null,
          timestamp: Date.now(),
          filepath: toPosix(systemPath.replace(cwd, "")),
        },
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          conflict: false,
          metadata: null,
          timestamp: Date.now(),
        }),
      );
      return;
    }

    res.writeHead(405);
    res.end();
  };
}
