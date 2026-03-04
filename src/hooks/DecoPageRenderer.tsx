import { Suspense, lazy, type ComponentType } from "react";
import type { ResolvedSection } from "../cms/resolve";
import { getSectionRegistry } from "../cms/registry";

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

function SectionFallback() {
  return <div className="w-full h-48 bg-base-200 animate-pulse rounded" />;
}

interface Props {
  sections: ResolvedSection[];
}

export function DecoPageRenderer({ sections }: Props) {
  return (
    <>
      {sections.map((section, index) => {
        const LazyComponent = getLazyComponent(section.component);

        if (!LazyComponent) return null;

        return (
          <section
            key={`${section.key}-${index}`}
            id={section.key
              .replace(/\//g, "-")
              .replace(/\.tsx$/, "")
              .replace(/^site-sections-/, "")}
            data-manifest-key={section.key}
          >
            <Suspense fallback={<SectionFallback />}>
              <LazyComponent {...section.props} />
            </Suspense>
          </section>
        );
      })}
    </>
  );
}
