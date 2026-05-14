/**
 * Chokidar watcher wrapper for the Next-side daemon path.
 *
 * The TanStack-side daemon receives Vite's existing watcher via
 * `createDaemonMiddleware`'s options and binds it via `bindWatcherToChannel`;
 * it never calls this function. The Next-side daemon has no Vite, so it
 * spins up its own chokidar instance lazily on the first watch/fs request.
 */
import chokidar, { type FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import {
  broadcastFsEvent,
  inferMetadata,
  shouldIgnorePath,
  toPosixPath,
} from "./watch";

export interface DecoWatcher {
  watcher: FSWatcher;
  close: () => Promise<void>;
}

export function createDecoWatcher(cwd: string): DecoWatcher {
  const watcher = chokidar.watch(cwd, {
    ignoreInitial: true,
    ignored: (p: string) => shouldIgnorePath(p),
  });
  bindWatcherToChannel(watcher, cwd);
  return {
    watcher,
    close: () => watcher.close(),
  };
}

/**
 * Wire any chokidar-style watcher (Vite's or our own) to the broadcast channel.
 * Pure side-effect helper — does not own the watcher's lifecycle.
 */
export function bindWatcherToChannel(
  watcher: { on(event: string, cb: (...args: unknown[]) => void): void },
  cwd: string = process.cwd(),
): void {
  const onChange = async (filePath: unknown, deleted = false) => {
    if (typeof filePath !== "string") return;
    if (shouldIgnorePath(filePath)) return;

    const metadata = deleted ? null : await inferMetadata(filePath);
    let mtime = Date.now();
    if (!deleted) {
      try {
        const stats = await stat(filePath);
        mtime = stats.mtimeMs;
      } catch {
        // use Date.now()
      }
    }

    broadcastFsEvent({
      type: "fs-sync",
      detail: {
        metadata,
        filepath: toPosixPath(filePath.replace(cwd, "")),
        timestamp: mtime,
      },
    });
  };

  watcher.on("change", (path: unknown) => onChange(path));
  watcher.on("add", (path: unknown) => onChange(path));
  watcher.on("unlink", (path: unknown) => onChange(path, true));
}
