/**
 * Server-Timing header builder.
 *
 * Tracks named timing entries during a request and serializes them
 * into the `Server-Timing` HTTP header for visibility in DevTools.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Server-Timing
 *
 * @example
 * ```ts
 * const timings = createServerTimings();
 * const end = timings.start("resolve-cms");
 * await resolvePage();
 * end();
 * response.headers.set("Server-Timing", timings.toHeader());
 * ```
 */
export interface ServerTimings {
  /** Start a named timing. Returns a function to call when done. */
  start(name: string, description?: string): () => void;
  /** Record a completed timing with a known duration. */
  record(name: string, durationMs: number, description?: string): void;
  /** Serialize all timings to a `Server-Timing` header value. */
  toHeader(): string;
  /** Get all recorded entries for diagnostics. */
  entries(): TimingEntry[];
}

export interface TimingEntry {
  name: string;
  durationMs: number;
  description?: string;
}

export function createServerTimings(): ServerTimings {
  const timingEntries: TimingEntry[] = [];

  return {
    start(name: string, description?: string) {
      const startTime = performance.now();
      return () => {
        const durationMs = performance.now() - startTime;
        timingEntries.push({ name, durationMs, description });
      };
    },

    record(name: string, durationMs: number, description?: string) {
      timingEntries.push({ name, durationMs, description });
    },

    toHeader(): string {
      return timingEntries
        .map((entry) => {
          let value = entry.name;
          if (entry.description) {
            value += `;desc="${entry.description}"`;
          }
          value += `;dur=${entry.durationMs.toFixed(1)}`;
          return value;
        })
        .join(", ");
    },

    entries() {
      return [...timingEntries];
    },
  };
}
