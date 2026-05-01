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
  /** Populated only when fix mode is on. */
  fixes?: FixAction[];
  /**
   * True when the rule has an `applyFix` implementation. Lets the CLI
   * tell users which findings would auto-fix vs require manual work.
   */
  supportsAutoFix: boolean;
}

export interface AuditReport {
  site: string;
  rules: RuleSummary[];
  totalFindings: number;
  /** Total fix actions across all rules (0 if not in fix mode). */
  totalFixActions: number;
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

/**
 * Mutating side of the FS adapter. Kept separate from `FsAdapter` so
 * read-only audits (the default) cannot accidentally write. Tests
 * substitute a recorder that captures actions without touching disk.
 */
export interface FsWriter {
  deleteFile(absPath: string): void;
  writeText(absPath: string, content: string): void;
}

/**
 * One concrete change applied (or that would have been applied) by a
 * rule's `applyFix` implementation. Consumed by the CLI to render a
 * summary, and by the JSON output for CI dashboards.
 */
export interface FixAction {
  /** Site-relative path the action targets. */
  file: string;
  /** "delete" | "rewrite-imports" | future: "edit" — kept open. */
  kind: string;
  /** Human-readable description, e.g. "deleted" or "rewrote 44 imports". */
  detail: string;
}

export interface Rule {
  id: string;
  title: string;
  run(ctx: RuleContext): Finding[];
  /**
   * Optional. Implement for rules whose findings can be safely
   * auto-corrected. Called only when the runner is in fix mode.
   * Must return one or more `FixAction`s describing what changed
   * (used both for output and for tests with a stubbed writer).
   */
  applyFix?(ctx: RuleContext, findings: Finding[], writer: FsWriter): FixAction[];
}
