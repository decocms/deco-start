/**
 * Section Loader Mixins
 *
 * Reusable section loader factories for common patterns like device detection,
 * mobile flag injection, and search param extraction. Eliminates repetitive
 * `(props, req) => ({ ...props, device: detectDevice(...) })` boilerplate.
 *
 * @example
 * ```ts
 * import { withDevice, withMobile, compose } from "@decocms/start/cms";
 *
 * registerSectionLoaders({
 *   "site/sections/Product/ProductShelf.tsx": withDevice(),
 *   "site/sections/Images/Carousel.tsx": withMobile(),
 *   "site/sections/Header/Header.tsx": compose(withDevice(), withSearchParam()),
 * });
 * ```
 */
import { detectDevice } from "../sdk/useDevice";
import type { SectionLoaderFn } from "./sectionLoaders";

/**
 * Injects `device: "mobile" | "desktop" | "tablet"` from the request User-Agent.
 */
export function withDevice(): SectionLoaderFn {
  return (props, req) => ({
    ...props,
    device: detectDevice(req.headers.get("user-agent") ?? ""),
  });
}

/**
 * Injects `isMobile: boolean` (true for mobile and tablet) from the request User-Agent.
 */
export function withMobile(): SectionLoaderFn {
  return (props, req) => {
    const d = detectDevice(req.headers.get("user-agent") ?? "");
    return { ...props, isMobile: d === "mobile" || d === "tablet" };
  };
}

const REGEX_QUERY_VALUE = /[?&]q=([^&]*)/;

/**
 * Injects `currentSearchParam: string | undefined` extracted from the `?q=` URL parameter.
 */
export function withSearchParam(): SectionLoaderFn {
  return (props, req) => {
    const match = req.url.match(REGEX_QUERY_VALUE);
    return {
      ...props,
      currentSearchParam: match ? decodeURIComponent(match[1]) : undefined,
    };
  };
}

/**
 * Composes multiple section loader mixins into a single loader.
 * Each mixin's result is merged left-to-right (later mixins override earlier ones).
 *
 * @example
 * ```ts
 * compose(withDevice(), withSearchParam())
 * // Equivalent to: (props, req) => ({ ...props, device: ..., currentSearchParam: ... })
 * ```
 */
export function compose(...mixins: SectionLoaderFn[]): SectionLoaderFn {
  return async (props, req) => {
    let result = { ...props };
    for (const mixin of mixins) {
      const partial = await mixin(result, req);
      result = { ...result, ...partial };
    }
    return result;
  };
}

/**
 * Wraps a section module's exported `loader` so it can be composed alongside
 * mixins like {@link withDevice}, {@link withMobile}, {@link withSearchParam}.
 *
 * The `modImport` argument is a lazy factory (typically `() => import("~/sections/...")`)
 * — the module is loaded on first call. If the module does not export a
 * `loader`, the original `props` are returned unchanged (no-op).
 *
 * Why this exists: the migrator and many sites lifted from Fresh declare a
 * `loader` export on the section file (often re-exported from the inner
 * component). That loader sets things like `url: req.url`, runs platform
 * invocations, or calls the section's domain logic. If the section is wired
 * in `registerSectionLoaders` with mixin-only (e.g. `withSearchParam()`),
 * the section's own loader is silently *replaced* — its work never runs and
 * its returned props are dropped.
 *
 * Compose this helper FIRST in the chain so mixin-injected props
 * (`device`, `currentSearchParam`, …) are available to the section's loader,
 * then the section's loader has the final word over what is returned.
 *
 * @example
 * ```ts
 * import {
 *   compose,
 *   withMobile,
 *   withSearchParam,
 *   withSectionLoader,
 * } from "@decocms/start/cms";
 *
 * registerSectionLoaders({
 *   "site/sections/Product/SearchContainerV2.tsx": compose(
 *     withMobile(),
 *     withSearchParam(),
 *     withSectionLoader(() => import("~/sections/Product/SearchContainerV2")),
 *   ),
 * });
 * ```
 */
export function withSectionLoader(
  modImport: () => Promise<unknown>,
): SectionLoaderFn {
  return async (props, req) => {
    const mod = (await modImport()) as { loader?: unknown } | undefined;
    const loader = mod?.loader;
    if (typeof loader !== "function") return props;
    try {
      const result = await (loader as SectionLoaderFn)(props, req);
      return result ?? props;
    } catch (error) {
      console.error("[withSectionLoader] section loader threw:", error);
      return props;
    }
  };
}
