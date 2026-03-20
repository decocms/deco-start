import {
  type ComponentType,
  createElement,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { Await, ClientOnly } from "@tanstack/react-router";
import type { SectionOptions } from "../cms/registry";
import {
  getResolvedComponent,
  getSectionOptions,
  getSectionRegistry,
  getSyncComponent,
  preloadSectionModule,
  setResolvedComponent,
} from "../cms/registry";
import type { DeferredSection, ResolvedSection } from "../cms/resolve";
import { djb2Hex } from "../sdk/djb2";
import { SectionErrorBoundary } from "./SectionErrorFallback";

type LazyComponent = ReturnType<typeof lazy>;

const lazyCache = new Map<string, LazyComponent>();

/**
 * Create a React.lazy-compatible thenable that is already fulfilled.
 * React internally checks `thenable.status === "fulfilled"` and reads
 * `thenable.value` synchronously — no Suspense activation, no microtask.
 */
function syncThenable(mod: {
  default: ComponentType<any>;
}): Promise<{ default: ComponentType<any> }> {
  const t = Promise.resolve(mod);
  // React uses these internal properties to detect sync-resolved thenables
  (t as any).status = "fulfilled";
  (t as any).value = mod;
  return t;
}

function getLazyComponent(key: string) {
  if (!lazyCache.has(key)) {
    // If sync-registered, wrap in a pre-fulfilled lazy so React.lazy
    // resolves synchronously — same tree structure as lazy-only path.
    const sync = getSyncComponent(key);
    if (sync) {
      lazyCache.set(key, lazy(() => syncThenable({ default: sync })));
      return lazyCache.get(key)!;
    }

    const registry = getSectionRegistry();
    const loader = registry[key];
    if (!loader) return null;
    lazyCache.set(
      key,
      lazy(() => {
        const resolved = getResolvedComponent(key);
        if (resolved) {
          return syncThenable({ default: resolved });
        }

        return (loader as () => Promise<{ default: ComponentType<any> }>)().then((mod) => {
          if (!mod?.default) {
            console.error(`[DecoSection] "${key}" has no default export`, Object.keys(mod ?? {}));
            return { default: () => null } as { default: ComponentType<any> };
          }
          setResolvedComponent(key, mod.default);
          return mod as { default: ComponentType<any> };
        });
      }),
    );
  }
  return lazyCache.get(key)!;
}

function DefaultSectionFallback() {
  return <div className="w-full h-48 bg-base-200 animate-pulse rounded" />;
}

function NestedSectionFallback() {
  return <div className="w-full h-24 bg-base-200 animate-pulse rounded" />;
}

import { isDevMode } from "../sdk/env";

const isDev = isDevMode();

// ---------------------------------------------------------------------------
// Deferred section data cache — persists resolved section props across SPA
// navigations so navigating back to a page doesn't re-fetch already-loaded
// sections. TTL is aligned with cmsRouteConfig staleTime (5 min prod / 5s dev).
// ---------------------------------------------------------------------------

const DEFERRED_CACHE_TTL = isDev ? 5_000 : 5 * 60 * 1000;

interface DeferredCacheEntry {
  section: ResolvedSection;
  ts: number;
}

const deferredSectionCache = new Map<string, DeferredCacheEntry>();

function getCachedDeferredSection(stableKey: string): ResolvedSection | null {
  const entry = deferredSectionCache.get(stableKey);
  if (!entry) return null;
  if (Date.now() - entry.ts > DEFERRED_CACHE_TTL) {
    deferredSectionCache.delete(stableKey);
    return null;
  }
  return entry.section;
}


const DEFERRED_FADE_CSS = `@keyframes decoFadeIn{from{opacity:0}to{opacity:1}}`;

function FadeInStyle() {
  return <style dangerouslySetInnerHTML={{ __html: DEFERRED_FADE_CSS }} />;
}

function DevMissingFallbackWarning({ component }: { component: string }) {
  if (!isDev) return null;
  return (
    <div
      style={{
        position: "relative",
        border: "2px dashed #e53e3e",
        borderRadius: 8,
        padding: 8,
        margin: "4px 0",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "#e53e3e",
          fontFamily: "monospace",
          marginBottom: 4,
        }}
      >
        [AsyncRender] Missing LoadingFallback for &quot;{component}&quot;.
        <br />
        Export a LoadingFallback from your section for better UX.
        <br />
        See: https://deco.cx/docs/async-rendering
      </div>
      <DefaultSectionFallback />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section type — same shape as deco-cx/deco (Fresh): { Component, props }
// ---------------------------------------------------------------------------

interface Section {
  Component: string | ComponentType<any>;
  props: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SectionRenderer — renders a single nested section
// ---------------------------------------------------------------------------

export function SectionRenderer({ section }: { section: Section | null | undefined }) {
  if (!section?.Component) return null;

  if (typeof section.Component === "function") {
    const Comp = section.Component;
    return <Comp {...(section.props ?? {})} />;
  }

  const Lazy = getLazyComponent(section.Component);
  if (!Lazy) {
    console.warn(`[SectionRenderer] No component registered for: ${section.Component}`);
    return null;
  }

  // Use the section's registered loadingFallback (if available) instead of
  // the generic NestedSectionFallback. This lets parent sections (e.g.
  // NotFoundChallenge) show a meaningful skeleton for nested children
  // (e.g. MountedPDP) while the lazy chunk loads.
  const options = getSectionOptions(section.Component);
  const fallback = options?.loadingFallback
    ? createElement(options.loadingFallback, section.props ?? {})
    : <NestedSectionFallback />;

  return (
    <Suspense fallback={fallback}>
      <Lazy {...(section.props ?? {})} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// SectionList — renders an array of nested sections
// ---------------------------------------------------------------------------

export function SectionList({ sections }: { sections: Section[] | null | undefined }) {
  if (!sections?.length) return null;
  return (
    <>
      {sections.map((section, i) => {
        const key = typeof section.Component === "string" ? section.Component : `nested-${i}`;
        return <SectionRenderer key={key} section={section} />;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// DeferredSectionWrapper — loads a section when it scrolls into view
// ---------------------------------------------------------------------------

interface DeferredSectionWrapperProps {
  deferred: DeferredSection;
  pagePath: string;
  pageUrl?: string;
  loadingFallback?: ReactNode;
  errorFallback?: ReactNode;
  loadFn: (data: {
    component: string;
    rawProps: Record<string, unknown>;
    pagePath: string;
    pageUrl?: string;
  }) => Promise<ResolvedSection | null>;
}

function DeferredSectionWrapper({
  deferred,
  pagePath,
  pageUrl,
  loadingFallback,
  errorFallback,
  loadFn,
}: DeferredSectionWrapperProps) {
  const propsHash = djb2Hex(JSON.stringify(deferred.rawProps));
  const stableKey = `${pagePath}::${deferred.component}::${deferred.index}::${propsHash}`;
  const [section, setSection] = useState<ResolvedSection | null>(() =>
    typeof document === "undefined" ? null : getCachedDeferredSection(stableKey),
  );
  const [error, setError] = useState<Error | null>(null);
  const [loadedOptions, setLoadedOptions] = useState<SectionOptions | undefined>(() =>
    getSectionOptions(deferred.component),
  );
  const isSSR = typeof document === "undefined";
  // Allow SSR to render the loadingFallback when registered sync via
  // registerSection(). Previous `isSSR ? false` always returned null,
  // hiding the skeleton from the HTML stream.
  const [optionsReady, setOptionsReady] = useState(() =>
    !!getSectionOptions(deferred.component),
  );
  const ref = useRef<HTMLDivElement>(null);
  const triggered = useRef(false);
  const prevKeyRef = useRef(stableKey);

  if (prevKeyRef.current !== stableKey) {
    prevKeyRef.current = stableKey;
    triggered.current = false;
    const cached = getCachedDeferredSection(stableKey);
    if (section !== cached) setSection(cached);
    if (error) setError(null);
  }

  useEffect(() => {
    if (optionsReady) return;
    preloadSectionModule(deferred.component).then((opts) => {
      if (opts) setLoadedOptions(opts);
      setOptionsReady(true);
    });
  }, [deferred.component, optionsReady]);

  const hasCustomFallback = !!loadedOptions?.loadingFallback;
  const skeleton = !optionsReady
    ? null
    : hasCustomFallback
      ? createElement(loadedOptions!.loadingFallback!, deferred.rawProps)
      : (loadingFallback ??
        (isDev ? (
          <DevMissingFallbackWarning component={deferred.component} />
        ) : (
          <DefaultSectionFallback />
        )));

  useEffect(() => {
    if (triggered.current || section) return;

    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === "undefined") {
      triggered.current = true;
      const key0 = stableKey;
      loadFn({
        component: deferred.component,
        rawProps: deferred.rawProps,
        pagePath,
        pageUrl,
      })
        .then((result) => {
          if (result) deferredSectionCache.set(key0, { section: result, ts: Date.now() });
          setSection(result);
        })
        .catch((e) => setError(e));
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !triggered.current) {
          triggered.current = true;
          observer.disconnect();
          const key1 = stableKey;
          loadFn({
            component: deferred.component,
            rawProps: deferred.rawProps,
            pagePath,
            pageUrl,
          })
            .then((result) => {
              if (result) deferredSectionCache.set(key1, { section: result, ts: Date.now() });
              setSection(result);
            })
            .catch((e) => setError(e));
        }
      },
      { rootMargin: "300px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [deferred.component, deferred.rawProps, pagePath, pageUrl, section, loadFn]);

  if (error) {
    const errFallback = loadedOptions?.errorFallback
      ? createElement(loadedOptions.errorFallback, { error })
      : errorFallback;
    return <>{errFallback ?? null}</>;
  }

  if (section) {
    const sectionId = section.key
      .replace(/\//g, "-")
      .replace(/\.tsx$/, "")
      .replace(/^site-sections-/, "");

    const LazyComponent = getLazyComponent(section.component);
    if (!LazyComponent) return null;

    return (
      <section
        id={sectionId}
        data-manifest-key={section.key}
        style={{ animation: "decoFadeIn 0.3s ease-out" }}
      >
        <SectionErrorBoundary sectionKey={section.key} fallback={errorFallback}>
          <Suspense fallback={skeleton}>
            <LazyComponent {...section.props} />
          </Suspense>
        </SectionErrorBoundary>
      </section>
    );
  }

  const sectionId = deferred.key
    .replace(/\//g, "-")
    .replace(/\.tsx$/, "")
    .replace(/^site-sections-/, "");

  return (
    <section ref={ref} id={sectionId} data-manifest-key={deferred.key} data-deferred="true">
      {skeleton}
    </section>
  );
}

// ---------------------------------------------------------------------------
// DeferredSectionSkeleton — resolves the best fallback for a deferred section
// ---------------------------------------------------------------------------

function DeferredSectionSkeleton({
  deferred,
  fallback,
}: {
  deferred: DeferredSection;
  fallback?: ReactNode;
}) {
  const options = getSectionOptions(deferred.component);
  if (options?.loadingFallback) {
    return createElement(options.loadingFallback, deferred.rawProps);
  }
  if (fallback) return <>{fallback}</>;
  if (isDev) return <DevMissingFallbackWarning component={deferred.component} />;
  return <DefaultSectionFallback />;
}

// ---------------------------------------------------------------------------
// Merge helper — combines eager and deferred sections in original order
// ---------------------------------------------------------------------------

type PageItem =
  | { type: "eager"; section: ResolvedSection; originalIndex: number }
  | { type: "deferred"; deferred: DeferredSection };

function mergeSections(resolved: ResolvedSection[], deferred: DeferredSection[]): PageItem[] {
  if (!resolved?.length && !deferred?.length) return [];
  const safeResolved = resolved ?? [];
  const safeDeferred = deferred ?? [];

  if (!safeDeferred.length) {
    return safeResolved.map((s, i) => ({ type: "eager", section: s, originalIndex: i }));
  }

  // Use the `index` property stamped by resolveDecoPage to sort all
  // sections (eager + deferred) back into their original CMS order.
  const items: (PageItem & { _sort: number })[] = [];

  for (let i = 0; i < safeResolved.length; i++) {
    const s = safeResolved[i];
    items.push({ type: "eager", section: s, originalIndex: i, _sort: s.index ?? i });
  }

  for (const d of safeDeferred) {
    items.push({ type: "deferred", deferred: d, _sort: d.index } as PageItem & { _sort: number });
  }

  items.sort((a, b) => a._sort - b._sort);

  return items;
}

// ---------------------------------------------------------------------------
// DecoPageRenderer — renders top-level resolved sections from a CMS page
// ---------------------------------------------------------------------------


interface Props {
  sections: ResolvedSection[];
  deferredSections?: DeferredSection[];
  /**
   * Unawaited promises for deferred sections, keyed by `d_<index>`.
   * Created by the route loader for TanStack native SSR streaming.
   * When provided, takes precedence over `loadDeferredSectionFn`.
   */
  deferredPromises?: Record<string, Promise<ResolvedSection | null>>;
  pagePath?: string;
  /** Original page URL (with query params) — forwarded to deferred section loaders. */
  pageUrl?: string;
  loadingFallback?: ReactNode;
  errorFallback?: ReactNode;
  /** @deprecated Use deferredPromises instead (TanStack native streaming). */
  loadDeferredSectionFn?: (data: {
    component: string;
    rawProps: Record<string, unknown>;
    pagePath: string;
    pageUrl?: string;
  }) => Promise<ResolvedSection | null>;
}

export function DecoPageRenderer({
  sections,
  deferredSections,
  deferredPromises,
  pagePath = "/",
  pageUrl,
  loadingFallback,
  errorFallback,
  loadDeferredSectionFn,
}: Props) {
  const items = mergeSections(sections ?? [], deferredSections ?? []);
  const hasDeferred = deferredSections && deferredSections.length > 0;

  return (
    <>
      {hasDeferred && <FadeInStyle />}
      {items.map((item, index) => {
        if (item.type === "deferred") {
          const promiseKey = `d_${item.deferred.index}`;
          const promise = deferredPromises?.[promiseKey];

          // TanStack native streaming path — uses <Await> for SSR-streamed data
          if (promise) {
            const deferredSectionId = item.deferred.key
              .replace(/\//g, "-")
              .replace(/\.tsx$/, "")
              .replace(/^site-sections-/, "");

            return (
              <SectionErrorBoundary
                key={`deferred-${pagePath}-${item.deferred.key}-${item.deferred.index}`}
                sectionKey={item.deferred.key}
                fallback={errorFallback}
              >
                <Suspense fallback={
                  <section id={deferredSectionId} data-manifest-key={item.deferred.key} data-deferred="true">
                    <DeferredSectionSkeleton deferred={item.deferred} fallback={loadingFallback} />
                  </section>
                }>
                  <Await promise={promise}>
                    {(resolved) => {
                      if (!resolved) return null;
                      const LazyComponent = getLazyComponent(resolved.component);
                      if (!LazyComponent) return null;
                      const resolvedOptions = getSectionOptions(resolved.component);
                      const isClientOnly = resolvedOptions?.clientOnly === true;
                      const sectionId = resolved.key
                        .replace(/\//g, "-")
                        .replace(/\.tsx$/, "")
                        .replace(/^site-sections-/, "");

                      const inner = (
                        <Suspense fallback={null}>
                          <LazyComponent {...resolved.props} />
                        </Suspense>
                      );

                      return (
                        <section
                          id={sectionId}
                          data-manifest-key={resolved.key}
                          style={{ animation: "decoFadeIn 0.3s ease-out" }}
                        >
                          {isClientOnly ? (
                            <ClientOnly fallback={null}>{inner}</ClientOnly>
                          ) : (
                            inner
                          )}
                        </section>
                      );
                    }}
                  </Await>
                </Suspense>
              </SectionErrorBoundary>
            );
          }

          // Fallback: legacy POST-based IntersectionObserver path
          if (loadDeferredSectionFn) {
            return (
              <DeferredSectionWrapper
                key={`deferred-${pagePath}-${item.deferred.key}-${item.deferred.index}`}
                deferred={item.deferred}
                pagePath={pagePath}
                pageUrl={pageUrl}
                loadingFallback={loadingFallback}
                errorFallback={errorFallback}
                loadFn={loadDeferredSectionFn}
              />
            );
          }
          return null;
        }

        const { section } = item;

        const options = getSectionOptions(section.component);
        const errFallback = options?.errorFallback
          ? createElement(options.errorFallback, { error: new Error("") })
          : errorFallback;

        const sectionId = section.key
          .replace(/\//g, "-")
          .replace(/\.tsx$/, "")
          .replace(/^site-sections-/, "");

        // Unified render path: always use React.lazy + Suspense.
        // For sync-registered components, getLazyComponent wraps them in a
        // pre-fulfilled lazy (via syncThenable) so React renders them
        // synchronously — same behavior as the old sync path, but with an
        // identical tree structure on both server and client (always has
        // <Suspense>). This prevents hydration mismatches when sites remove
        // registerSectionsSync.
        const LazyComponent = getLazyComponent(section.component);
        if (!LazyComponent) return null;

        // ClientOnly sections: render only on client, no SSR, no hydration mismatch.
        // Used for analytics scripts, GTM, third-party widgets.
        const isClientOnly = options?.clientOnly === true;
        const fallbackEl = options?.loadingFallback
          ? createElement(options.loadingFallback, section.props)
          : null;

        const content = isClientOnly ? (
          <ClientOnly fallback={fallbackEl}>
            <Suspense fallback={null}>
              <LazyComponent {...section.props} />
            </Suspense>
          </ClientOnly>
        ) : (
          <Suspense fallback={null}>
            <LazyComponent {...section.props} />
          </Suspense>
        );

        // Dev warning: eager section not sync-registered may blank during hydration
        if (isDev && !isClientOnly && !getSyncComponent(section.component)) {
          console.warn(
            `[DecoPageRenderer] Eager section "${section.component}" is not in registerSectionsSync(). ` +
              `This may cause blank content during hydration. Add it to registerSectionsSync() in setup.ts.`,
          );
        }

        return (
          <section key={`${section.key}-${index}`} id={sectionId} data-manifest-key={section.key}>
            <SectionErrorBoundary sectionKey={section.key} fallback={errFallback}>
              {content}
            </SectionErrorBoundary>
          </section>
        );
      })}
    </>
  );
}
