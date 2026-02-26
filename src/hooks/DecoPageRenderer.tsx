import { Suspense, lazy, type ComponentType } from "react";
import type { ResolvedSection } from "../server/cms/resolve";

const sectionComponents: Record<
  string,
  () => Promise<{ default: ComponentType<any> }>
> = {
  "site/sections/Images/Carousel.tsx": () => import("../sections/Images/Carousel"),
  "site/sections/Images/Banner.tsx": () => import("../sections/Images/Banner"),
  "site/sections/Content/Hero.tsx": () => import("../sections/Content/Hero"),
  "site/sections/Content/Faq.tsx": () => import("../sections/Content/Faq"),
  "site/sections/Content/Intro.tsx": () => import("../sections/Content/Intro"),
  "site/sections/Content/Logos.tsx": () => import("../sections/Content/Logos"),
  "site/sections/Product/ProductShelf.tsx": () => import("../sections/Product/ProductShelf"),
  "site/sections/Product/ProductShelfTabbed.tsx": () => import("../sections/Product/ProductShelfTabbed"),
  "site/sections/Product/ProductDetails.tsx": () => import("../sections/Product/ProductDetails"),
  "site/sections/Product/SearchResult.tsx": () => import("../sections/Product/SearchResult"),
  "site/sections/Category/CategoryGrid.tsx": () => import("../sections/Category/CategoryGrid"),
  "site/sections/Header/Header.tsx": () => import("../sections/Header/Header"),
  "site/sections/Footer/Footer.tsx": () => import("../sections/Footer/Footer"),
  "site/sections/Theme/Theme.tsx": () => import("../sections/Theme/Theme"),
  "site/sections/Session.tsx": () => import("../sections/Session"),
  "site/sections/Newsletter/Newsletter.tsx": () => import("../sections/Newsletter/Newsletter"),
  "site/sections/Social/WhatsApp.tsx": () => import("../sections/Social/WhatsApp"),
  "site/sections/Miscellaneous/CookieConsent.tsx": () => import("../sections/Miscellaneous/CookieConsent"),
};

const lazyCache = new Map<string, React.LazyExoticComponent<any>>();

function getLazyComponent(key: string) {
  if (!lazyCache.has(key)) {
    const loader = sectionComponents[key];
    if (!loader) return null;
    lazyCache.set(key, lazy(loader));
  }
  return lazyCache.get(key)!;
}

function SectionFallback() {
  return <div className="w-full h-48 bg-base-200 animate-pulse rounded" />;
}

function UnknownSection({ component }: { component: string }) {
  return (
    <div className="w-full p-4 bg-warning/10 border border-warning rounded text-sm">
      <span className="font-mono">Unknown section: {component}</span>
    </div>
  );
}

interface Props {
  sections: ResolvedSection[];
}

export function DecoPageRenderer({ sections }: Props) {
  return (
    <>
      {sections.map((section, index) => {
        const LazyComponent = getLazyComponent(section.component);

        if (!LazyComponent) {
          if (import.meta.env.DEV) {
            return (
              <UnknownSection
                key={`${section.key}-${index}`}
                component={section.component}
              />
            );
          }
          return null;
        }

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
