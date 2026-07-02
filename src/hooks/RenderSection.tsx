import { type ComponentType, lazy, Suspense } from "react";
import { getSection, getSyncComponent } from "../cms/registry";

const componentCache = new Map<string, ComponentType<any>>();

function getOrCreateLazy(resolveType: string): ComponentType<any> | null {
  if (componentCache.has(resolveType)) {
    return componentCache.get(resolveType)!;
  }

  const loader = getSection(resolveType);
  if (!loader) return null;

  const LazyComponent = lazy(async () => {
    const mod = await loader();
    return { default: mod.default };
  });

  componentCache.set(resolveType, LazyComponent);
  return LazyComponent;
}

interface SectionLike {
  __resolveType?: string;
  Component?: ComponentType<any>;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Renders a Section-type prop from the CMS.
 *
 * Handles both the old Deco format ({ Component, props }) and
 * the new @decocms/start format ({ __resolveType, ...props }).
 *
 * Sync-first: sections registered as sync (`export const sync = true`,
 * bundled in the main chunk) render DIRECTLY — no React.lazy / Suspense.
 * This mirrors DecoPageRenderer's sync-first path and matters twice:
 *
 * - SSR streaming: React 19 omits the `<!--$-->` markers when a Suspense
 *   boundary resolves synchronously, which triggers a hydration mismatch
 *   (minified #418) — same reason DecoPageRenderer bifurcates.
 * - SPA commit: the lazy path suspends with `fallback ?? null` while the
 *   section chunk loads, so a route commit that renders content through
 *   RenderSection (e.g. a gate section like NotFoundChallenge) paints the
 *   page with a BLANK middle until the chunk resolves.
 *
 * Sites without registered sync components are unaffected:
 * `getSyncComponent()` returns undefined and the lazy path runs as before.
 */
export default function RenderSection({
  section,
  fallback,
}: {
  section: SectionLike | null | undefined;
  fallback?: React.ReactNode;
}) {
  if (!section) return null;

  if (section.Component) {
    const { Component, props = {}, ...overrides } = section;
    const mergedProps = { ...(props as Record<string, unknown>), ...overrides };
    if (typeof Component === "string") {
      const Sync = getSyncComponent(Component);
      if (Sync) return <Sync {...mergedProps} />;
      const Comp = getOrCreateLazy(Component);
      if (!Comp) return <>{fallback ?? null}</>;
      return (
        <Suspense fallback={fallback ?? null}>
          <Comp {...mergedProps} />
        </Suspense>
      );
    }
    return <Component {...mergedProps} />;
  }

  if (section.__resolveType) {
    const { __resolveType: _, ...props } = section;
    const Sync = getSyncComponent(section.__resolveType);
    if (Sync) return <Sync {...props} />;
    const Comp = getOrCreateLazy(section.__resolveType);
    if (!Comp) return <>{fallback ?? null}</>;
    return (
      <Suspense fallback={fallback ?? null}>
        <Comp {...props} />
      </Suspense>
    );
  }

  return null;
}
