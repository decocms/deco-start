/**
 * Post-migration cleanup audit — shared types.
 *
 * The audit runner is a thin orchestrator: it loads the site, runs each
 * rule, and prints the findings. The interesting bits live in `rules.ts`.
 *
 * Rules are pure(ish) functions over an injected `FsAdapter`, which means
 * they can be unit-tested with an in-memory file system and never touch
 * the real disk in CI.
 */

export type Severity = "info" | "warning";

export interface Finding {
  /** Stable rule identifier (e.g. "dead-lib-shims"). */
  rule: string;
  severity: Severity;
  /** Site-relative path of the file the finding refers to. */
  file: string;
  /** One-line message — shown in default text output. */
  message: string;
  /** Suggested human action, if any. */
  fix?: string;
  /** Free-form structured payload for JSON consumers. */
  meta?: Record<string, unknown>;
}

export interface RuleSummary {
  /** Stable rule identifier. */
  rule: string;
  /** Human-readable section title. */
  title: string;
  findings: Finding[];
}

export interface AuditReport {
  site: string;
  rules: RuleSummary[];
  totalFindings: number;
}

/**
 * Minimal file-system adapter — read + glob. Keeping the surface tiny
 * is what lets us pass an in-memory map in unit tests.
 */
export interface FsAdapter {
  exists(absPath: string): boolean;
  readText(absPath: string): string;
  /**
   * Return absolute paths matching the glob, ordered by path. Globs are
   * relative to `siteDir`. Implementations must respect `excludeDirs` and
   * skip them entirely.
   */
  glob(siteDir: string, pattern: string, excludeDirs?: string[]): string[];
}

export interface RuleContext {
  siteDir: string;
  fs: FsAdapter;
}

export interface Rule {
  id: string;
  title: string;
  run(ctx: RuleContext): Finding[];
}
