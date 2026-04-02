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
