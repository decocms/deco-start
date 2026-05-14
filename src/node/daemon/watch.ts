/**
 * Daemon broadcast channel + .deco/ file scanner + metadata inference.
 *
 * Framework-neutral. Both the Connect-style watch handler (consumed by Vite's
 * middleware stack) and the Web-standard `handleWatchSse` consume from here.
 *
 * Ported from: deco-cx/deco daemon/sse/api.ts + daemon/sse/channel.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";

export interface FsEvent {
  type: "fs-sync" | "fs-snapshot" | "worker-status" | "meta-info";
  detail: Record<string, unknown>;
}

const channel = new EventTarget();

/** Publish an event to all subscribers. */
export function broadcastFsEvent(event: FsEvent): void {
  channel.dispatchEvent(new CustomEvent("broadcast", { detail: event }));
}

/** Subscribe to broadcast events. Returns an unsubscribe function. */
export function subscribeFsEvents(listener: (event: FsEvent) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<FsEvent>).detail);
  channel.addEventListener("broadcast", handler);
  return () => channel.removeEventListener("broadcast", handler);
}

const toPosix = (p: string) => p.replaceAll(sep, "/");

function shouldIgnore(path: string): boolean {
  return (
    path.includes(`${sep}.git${sep}`) ||
    path.includes(`${sep}node_modules${sep}`) ||
    path.includes(`${sep}.agent-home${sep}`) ||
    path.includes(`${sep}.claude${sep}`)
  );
}

function inferBlockType(resolveType: string): string | null {
  if (!resolveType) return null;
  if (resolveType.includes("/pages/")) return "pages";
  if (resolveType.includes("/sections/")) return "sections";
  if (resolveType.includes("/loaders/")) return "loaders";
  if (resolveType.includes("/actions/")) return "actions";
  if (resolveType.includes("/matchers/")) return "matchers";
  if (resolveType.includes("/flags/")) return "sections";
  return null;
}

export interface Metadata {
  kind: "block" | "file";
  blockType?: string;
  __resolveType?: string;
  name?: string;
  path?: string;
}

/** Read a JSON file and infer its block metadata (block type, resolveType, …). */
export async function inferMetadata(filepath: string): Promise<Metadata | null> {
  try {
    const raw = await readFile(filepath, "utf-8");
    const parsed = JSON.parse(raw);
    const { __resolveType, name, path: pagePath } = parsed;

    if (!__resolveType) return { kind: "file" };
    const blockType = inferBlockType(__resolveType);
    if (!blockType) return { kind: "file" };

    if (blockType === "pages") {
      return {
        kind: "block",
        blockType,
        __resolveType,
        name: name ?? undefined,
        path: pagePath ?? undefined,
      };
    }
    return { kind: "block", blockType, __resolveType };
  } catch {
    return { kind: "file" };
  }
}

/** Yield fs-sync events for every .deco/ file modified after `since`. */
export async function* scanDecoFiles(cwd: string, since: number): AsyncGenerator<FsEvent> {
  const decoDir = join(cwd, ".deco");
  try {
    const entries = await readdir(decoDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      if (shouldIgnore(fullPath)) continue;

      let mtime: number;
      try {
        const stats = await stat(fullPath);
        mtime = stats.mtimeMs;
      } catch {
        mtime = Date.now();
      }
      if (mtime < since) continue;

      const metadata = await inferMetadata(fullPath);
      const filepath = toPosix(fullPath.replace(cwd, ""));
      yield { type: "fs-sync", detail: { metadata, filepath, timestamp: mtime } };
    }
  } catch {
    // .deco dir might not exist yet
  }
  yield { type: "fs-snapshot", detail: { timestamp: Date.now() } };
}

/** Common ignore predicate, exported for the watcher wrappers. */
export function shouldIgnorePath(path: string): boolean {
  return shouldIgnore(path);
}

export const toPosixPath = toPosix;
