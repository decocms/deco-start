/**
 * Volumes API — CRUD for .deco/ files with JSON patch support
 * and WebSocket realtime broadcast of file changes.
 *
 * Ported from: deco-cx/deco daemon/realtime/app.ts (without CRDT)
 */
import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep, posix } from "node:path";
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import fjp from "fast-json-patch";
import type { Operation } from "fast-json-patch";

// ---------------------------------------------------------------------------
// Types — ported from daemon/realtime/types.ts
// ---------------------------------------------------------------------------

interface BaseFilePatch {
  path: string;
}

interface JSONFilePatch extends BaseFilePatch {
  patches: Operation[];
}

interface TextFileSet extends BaseFilePatch {
  content: string | null;
}

type FilePatch = JSONFilePatch | TextFileSet;

interface VolumePatchRequest {
  messageId?: string;
  patches: FilePatch[];
}

interface FilePatchResult {
  path: string;
  accepted: boolean;
  content?: string;
  deleted?: boolean;
}

interface VolumePatchResponse {
  results: FilePatchResult[];
  timestamp: number;
}

function isJSONFilePatch(patch: FilePatch): patch is JSONFilePatch {
  return "patches" in patch && Array.isArray((patch as JSONFilePatch).patches);
}

function isTextFileSet(patch: FilePatch): patch is TextFileSet {
  return "content" in patch && !("patches" in patch);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toPosix = (p: string) => p.replaceAll(sep, "/");

function safePath(base: string, untrusted: string): string | null {
  const resolved = resolve(base, untrusted);
  if (!resolved.startsWith(base + sep) && resolved !== base) return null;
  return resolved;
}

async function readTextFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function ensureFile(path: string): Promise<void> {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// WebSocket realtime sessions
// ---------------------------------------------------------------------------

interface BroadcastMessage {
  path: string;
  timestamp: number;
  deleted?: boolean;
  messageId?: string;
}

interface VolumesState {
  sessions: WebSocket[];
  wss: WebSocketServer;
  timestamp: number;
}

function broadcast(state: VolumesState, msg: BroadcastMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of state.sessions) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// ---------------------------------------------------------------------------
// Walk directory (Node.js equivalent of @std/fs/walk)
// ---------------------------------------------------------------------------

async function walkFiles(
  root: string,
): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      const rel = toPosix(fullPath.replace(root, ""));
      if (
        rel.includes("/.git/") ||
        rel.includes("/node_modules/") ||
        rel.includes("/.agent-home/") ||
        rel.includes("/.claude/")
      ) {
        continue;
      }
      results.push(fullPath);
    }
  } catch {
    // root might be a file, not a directory
  }
  return results;
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

const cwd = process.cwd();

async function handleGetFiles(
  req: IncomingMessage,
  res: ServerResponse,
  state: VolumesState,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const [, ...segments] = url.pathname.split("/files");
  const filePath = segments.join("/files") || "/";
  const withContent = url.searchParams.get("content") === "true";

  const root = safePath(cwd, filePath);
  if (!root) {
    res.writeHead(403);
    res.end("Path traversal denied");
    return;
  }
  const fs: Record<string, { content: string | null }> = {};

  const files = await walkFiles(root);
  if (files.length > 0) {
    for (const fullPath of files) {
      const key = toPosix(fullPath.replace(root, "/"));
      fs[key] = {
        content: withContent ? await readTextFileSafe(fullPath) : null,
      };
    }
  } else {
    // Might be a single file
    const content = withContent ? await readTextFileSafe(root) : null;
    fs[toPosix(filePath)] = { content };
  }

  const body = JSON.stringify({ timestamp: state.timestamp, fs });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

async function handlePatchFiles(
  req: IncomingMessage,
  res: ServerResponse,
  state: VolumesState,
): Promise<void> {
  const raw = await readBody(req);
  let request: VolumePatchRequest;
  try {
    request = JSON.parse(raw);
  } catch {
    res.writeHead(400);
    res.end("Invalid JSON");
    return;
  }

  const results: FilePatchResult[] = [];

  for (const patch of request.patches) {
    // Validate path traversal for every patch
    const resolvedPath = safePath(cwd, patch.path);
    if (!resolvedPath) {
      results.push({ accepted: false, path: patch.path });
      continue;
    }

    if (isJSONFilePatch(patch)) {
      const { path: filePath, patches: operations } = patch;
      const content =
        (await readTextFileSafe(resolvedPath)) ?? "{}";
      try {
        const newContent = JSON.stringify(
          operations.reduce(fjp.applyReducer, JSON.parse(content)),
        );
        results.push({
          accepted: true,
          path: filePath,
          content: newContent,
          deleted: newContent === "null",
        });
      } catch (error) {
        console.error(error);
        results.push({ accepted: false, path: filePath, content });
      }
    } else if (isTextFileSet(patch)) {
      const { path: filePath, content } = patch;
      results.push({
        accepted: true,
        path: filePath,
        content: content ?? "",
        deleted: content === null,
      });
    }
  }

  state.timestamp = Date.now();

  // Atomic: only commit writes if all patches accepted
  const shouldWrite = results.every((r) => r.accepted);
  if (shouldWrite) {
    await Promise.all(
      results.map(async (r) => {
        try {
          const system = join(cwd, r.path);
          if (r.deleted) {
            await rm(system, { force: true });
          } else if (r.content != null) {
            await ensureFile(system);
            await writeFile(system, r.content, "utf-8");
          }
        } catch (error) {
          console.error(error);
          r.accepted = false;
        }
      }),
    );
  }

  const body: VolumePatchResponse = { timestamp: state.timestamp, results };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Body reader helper
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Setup: attach WebSocket server and file watcher
// ---------------------------------------------------------------------------

export interface VolumesOptions {
  /** Vite's HTTP server to attach WebSocket upgrades to. */
  httpServer: HttpServer;
  /** Vite's file watcher (chokidar instance) for broadcasting changes. */
  watcher: { on(event: string, cb: (...args: unknown[]) => void): void };
}

export function createVolumesHandler(opts: VolumesOptions) {
  const state: VolumesState = {
    sessions: [],
    wss: new WebSocketServer({ noServer: true }),
    timestamp: Date.now(),
  };

  // Handle WebSocket upgrades for /volumes/*/files paths with x-daemon-api
  opts.httpServer.on("upgrade", (req, socket, head) => {
    const isDaemon =
      req.headers["x-daemon-api"] ?? req.headers["x-hypervisor-api"];
    if (!isDaemon) return;

    const url = req.url ?? "";
    if (!url.includes("/volumes/") || !url.includes("/files")) return;

    state.wss.handleUpgrade(req, socket, head, (ws) => {
      state.sessions.push(ws);
      console.log("[deco] admin websocket connected");

      ws.on("close", () => {
        console.log("[deco] admin websocket disconnected");
        const idx = state.sessions.indexOf(ws);
        if (idx > -1) state.sessions.splice(idx, 1);
      });
    });
  });

  // Broadcast file changes from Vite's watcher
  const broadcastChange = (filePath: string, deleted = false) => {
    const rel = toPosix(filePath).replace(toPosix(cwd), "");
    if (
      rel.includes("/.git/") ||
      rel.includes("/node_modules/") ||
      rel.includes("/.agent-home/") ||
      rel.includes("/.claude/")
    ) {
      return;
    }
    broadcast(state, { path: rel, timestamp: Date.now(), deleted });
  };

  opts.watcher.on("change", (path: unknown) => {
    if (typeof path === "string") broadcastChange(path);
  });
  opts.watcher.on("add", (path: unknown) => {
    if (typeof path === "string") broadcastChange(path);
  });
  opts.watcher.on("unlink", (path: unknown) => {
    if (typeof path === "string") broadcastChange(path, true);
  });

  // Connect-style middleware for HTTP requests
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = req.url ?? "";

    // Match /volumes/:id/files patterns
    if (!url.includes("/volumes/") || !url.includes("/files")) {
      next();
      return;
    }

    if (req.method === "GET") {
      await handleGetFiles(req, res, state);
    } else if (req.method === "PATCH") {
      await handlePatchFiles(req, res, state);
    } else {
      res.writeHead(405);
      res.end();
    }
  };
}
