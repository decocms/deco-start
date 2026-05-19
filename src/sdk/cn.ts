/**
 * `cn(...inputs)` — the canonical Tailwind class-name combinator
 * (clsx + tailwind-merge). Every storefront we audited shipped a
 * site-local copy of this; we promote it to the framework so sites
 * can drop the duplicate.
 *
 * Behaviour:
 *   - Accepts the full `clsx` input format (strings, objects, arrays,
 *     conditionals, falsy values).
 *   - De-duplicates conflicting Tailwind utilities via `tailwind-merge`
 *     (e.g. `cn("p-2", "p-4")` → `"p-4"`).
 *
 * The simpler `clx` (no tailwind-merge, just `filter+join`) is still
 * exported from `@decocms/start/sdk/clx` for cases where you want to
 * keep the literal class string. Re-exported here so a single import
 * covers both.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export { clx } from "./clx";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type { ClassValue };
