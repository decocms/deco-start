import { lazy, Suspense, type ComponentType } from "react";
import { getSection } from "../cms/registry";

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
    const Comp = getOrCreateLazy(section.__resolveType);
    if (!Comp) return <>{fallback ?? null}</>;

    const { __resolveType: _, ...props } = section;
    return (
      <Suspense fallback={fallback ?? null}>
        <Comp {...props} />
      </Suspense>
    );
  }

  return null;
}
