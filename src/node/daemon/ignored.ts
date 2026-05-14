/**
 * Canonical list of directories the daemon never reports on.
 *
 * Used by both the broadcast channel's pre-publish filter (`bindWatcherToChannel`
 * in `./watcher.ts`) and the volumes WebSocket walker (`walkFiles` /
 * `broadcastChange` in `src/tanstack/daemon/volumes.ts`). Keep both call sites
 * pointed at this list so framework artifact dirs (Next's `.next`, Vite's
 * `dist`, Turbopack's `.turbo`, etc.) can't drift between the two paths.
 *
 * The match runs against absolute or relative POSIX paths. Each entry is
 * matched as a path segment (surrounded by `/`), so partial-name collisions
 * (e.g. `dist-foo`) don't false-positive.
 */
export const DAEMON_IGNORED_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  ".agent-home",
  ".claude",
  // Framework build artefacts — observed flooding the SSE channel during
  // Next 16 / Turbopack consumer testing (May 2026).
  ".next",
  ".turbo",
  "dist",
  "build",
  ".cache",
  "coverage",
];

const toPosix = (p: string) => p.replaceAll("\\", "/");

/**
 * True when the given path passes through any of the daemon-ignored dirs as
 * a complete segment. Accepts absolute, relative, POSIX, or Windows paths.
 */
export function isIgnoredPath(path: string): boolean {
  const posix = toPosix(path);
  for (const dir of DAEMON_IGNORED_DIRS) {
    if (posix.includes(`/${dir}/`)) return true;
  }
  return false;
}
