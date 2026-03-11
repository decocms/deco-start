import { type ComponentType, createElement, lazy, type ReactNode, Suspense } from "react";
import { getSectionOptions, getSectionRegistry } from "../cms/registry";
import type { ResolvedSection } from "../cms/resolve";
import { SectionErrorBoundary } from "./SectionErrorFallback";

type LazyComponent = ReturnType<typeof lazy>;

const lazyCache = new Map<string, LazyComponent>();

function getLazyComponent(key: string) {
  if (!lazyCache.has(key)) {
    const registry = getSectionRegistry();
    const loader = registry[key];
    if (!loader) return null;
    lazyCache.set(key, lazy(loader as () => Promise<{ default: ComponentType<any> }>));
  }
  return lazyCache.get(key)!;
}

function DefaultSectionFallback() {
  return <div className="w-full h-48 bg-base-200 animate-pulse rounded" />;
}

interface Props {
  sections: ResolvedSection[];
  /** Global fallback for loading states. Per-section fallbacks from the registry take priority. */
  loadingFallback?: ReactNode;
  /** Global fallback for error states. Per-section error fallbacks take priority. */
  errorFallback?: ReactNode;
}

export function DecoPageRenderer({ sections, loadingFallback, errorFallback }: Props) {
  return (
    <>
      {sections.map((section, index) => {
        const LazyComponent = getLazyComponent(section.component);

        if (!LazyComponent) return null;

        const options = getSectionOptions(section.component);
        const fallback = options?.loadingFallback
          ? createElement(options.loadingFallback)
          : (loadingFallback ?? <DefaultSectionFallback />);

        const errFallback = options?.errorFallback
          ? createElement(options.errorFallback, { error: new Error("") })
          : errorFallback;

        const sectionId = section.key
          .replace(/\//g, "-")
          .replace(/\.tsx$/, "")
          .replace(/^site-sections-/, "");

        return (
          <section key={`${section.key}-${index}`} id={sectionId} data-manifest-key={section.key}>
            <SectionErrorBoundary sectionKey={section.key} fallback={errFallback}>
              <Suspense fallback={fallback}>
                <LazyComponent {...section.props} />
              </Suspense>
            </SectionErrorBoundary>
          </section>
        );
      })}
    </>
  );
}
