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
    const registry = getSectionRegistry();
    const loader = registry[key];
    if (!loader) return null;
    lazyCache.set(
      key,
      lazy(() => {
        // If already resolved (from preloadSectionComponents on server,
        // or from route loader on client SPA), return a sync thenable.
        // React reads thenable.status/value synchronously — no Suspense.
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

/** Fast DJB2 hash for cache key differentiation. */
function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
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

  return (
    <Suspense fallback={<NestedSectionFallback />}>
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
// Batch coordinator — collects deferred section load requests in a microtask
// and sends them in a single network request for deterministic ordering.
// ---------------------------------------------------------------------------

type BatchRequest = {
  component: string;
  rawProps: Record<string, unknown>;
  pagePath: string;
  pageUrl?: string;
  resolve: (result: ResolvedSection | null) => void;
  reject: (error: Error) => void;
};

let batchQueue: BatchRequest[] = [];
let batchScheduled = false;
let batchLoadFn: ((data: {
  sections: Array<{ component: string; rawProps: Record<string, any> }>;
  pagePath: string;
  pageUrl?: string;
}) => Promise<Array<ResolvedSection | null>>) | null = null;

/**
 * Set the batch load function. Called once from DecoPageRenderer.
 */
export function setBatchLoadFn(fn: typeof batchLoadFn) {
  batchLoadFn = fn;
}

function flushBatch() {
  batchScheduled = false;
  const items = batchQueue;
  batchQueue = [];
  if (!items.length) return;

  // Group by pagePath+pageUrl (normally all same page)
  const groups = new Map<string, BatchRequest[]>();
  for (const item of items) {
    const key = `${item.pagePath}::${item.pageUrl ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  for (const [, group] of groups) {
    const first = group[0];
    if (batchLoadFn && group.length > 1) {
      // Batch: single request for all sections in this group
      batchLoadFn({
        sections: group.map((g) => ({ component: g.component, rawProps: g.rawProps as Record<string, any> })),
        pagePath: first.pagePath,
        pageUrl: first.pageUrl,
      })
        .then((results) => {
          for (let i = 0; i < group.length; i++) {
            group[i].resolve(results[i] ?? null);
          }
        })
        .catch((err) => {
          for (const g of group) g.reject(err);
        });
    } else {
      // Fallback: individual loads (single section or no batch fn)
      for (const item of group) {
        item.resolve(null); // Will fall through to individual loadFn
      }
    }
  }
}

function enqueueBatchLoad(request: Omit<BatchRequest, "resolve" | "reject">): Promise<ResolvedSection | null> {
  return new Promise((resolve, reject) => {
    batchQueue.push({ ...request, resolve, reject });
    if (!batchScheduled) {
      batchScheduled = true;
      queueMicrotask(flushBatch);
    }
  });
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
  const propsHash = djb2(JSON.stringify(deferred.rawProps));
  const stableKey = `${pagePath}::${deferred.component}::${deferred.index}::${propsHash}`;
  const [section, setSection] = useState<ResolvedSection | null>(() =>
    typeof document === "undefined" ? null : getCachedDeferredSection(stableKey),
  );
  const [error, setError] = useState<Error | null>(null);
  const [loadedOptions, setLoadedOptions] = useState<SectionOptions | undefined>(() =>
    getSectionOptions(deferred.component),
  );
  const isSSR = typeof document === "undefined";
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

  // Helper: load via batch coordinator (falls back to individual loadFn)
  const doLoad = (cacheKey: string) => {
    if (batchLoadFn) {
      // Use batch coordinator — groups with other deferred sections in same microtask
      enqueueBatchLoad({
        component: deferred.component,
        rawProps: deferred.rawProps,
        pagePath,
        pageUrl,
      })
        .then((result) => {
          if (result) deferredSectionCache.set(cacheKey, { section: result, ts: Date.now() });
          setSection(result);
        })
        .catch((e) => setError(e));
    } else {
      // Fallback: individual load
      loadFn({
        component: deferred.component,
        rawProps: deferred.rawProps,
        pagePath,
        pageUrl,
      })
        .then((result) => {
          if (result) deferredSectionCache.set(cacheKey, { section: result, ts: Date.now() });
          setSection(result);
        })
        .catch((e) => setError(e));
    }
  };

  useEffect(() => {
    if (triggered.current || section) return;

    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === "undefined") {
      triggered.current = true;
      doLoad(stableKey);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !triggered.current) {
          triggered.current = true;
          observer.disconnect();
          doLoad(stableKey);
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
  pagePath?: string;
  /** Original page URL (with query params) — forwarded to deferred section loaders. */
  pageUrl?: string;
  loadingFallback?: ReactNode;
  errorFallback?: ReactNode;
  loadDeferredSectionFn?: (data: {
    component: string;
    rawProps: Record<string, unknown>;
    pagePath: string;
    pageUrl?: string;
  }) => Promise<ResolvedSection | null>;
  /** Batch load function — resolves multiple deferred sections in one request. */
  loadDeferredSectionBatchFn?: (data: {
    sections: Array<{ component: string; rawProps: Record<string, any> }>;
    pagePath: string;
    pageUrl?: string;
  }) => Promise<Array<ResolvedSection | null>>;
}

export function DecoPageRenderer({
  sections,
  deferredSections,
  pagePath = "/",
  pageUrl,
  loadingFallback,
  errorFallback,
  loadDeferredSectionFn,
  loadDeferredSectionBatchFn,
}: Props) {
  // Wire up batch coordinator when batch function is provided
  if (loadDeferredSectionBatchFn) {
    setBatchLoadFn(loadDeferredSectionBatchFn);
  }

  const items = mergeSections(sections ?? [], deferredSections ?? []);
  const hasDeferred = deferredSections && deferredSections.length > 0;

  return (
    <>
      {hasDeferred && <FadeInStyle />}
      {items.map((item, index) => {
        if (item.type === "deferred") {
          if (!loadDeferredSectionFn) {
            return null;
          }
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

        const { section } = item;

        const options = getSectionOptions(section.component);
        const errFallback = options?.errorFallback
          ? createElement(options.errorFallback, { error: new Error("") })
          : errorFallback;

        const sectionId = section.key
          .replace(/\//g, "-")
          .replace(/\.tsx$/, "")
          .replace(/^site-sections-/, "");

        // Only use sync path for sections explicitly registered via registerSectionsSync.
        // DO NOT fallback to getResolvedComponent: that is populated server-side by
        // preloadSectionComponents but NOT on the client, causing hydration mismatches
        // (server renders <ul>, client renders <Suspense> for the same component).
        const SyncComp = getSyncComponent(section.component);
        if (SyncComp) {
          return (
            <section key={`${section.key}-${index}`} id={sectionId} data-manifest-key={section.key}>
              <SectionErrorBoundary sectionKey={section.key} fallback={errFallback}>
                <SyncComp {...section.props} />
              </SectionErrorBoundary>
            </section>
          );
        }

        // Fallback: React.lazy with syncThenable for pre-loaded modules.
        // fallback={null} preserves server HTML during hydration.
        const LazyComponent = getLazyComponent(section.component);
        if (!LazyComponent) return null;

        return (
          <section key={`${section.key}-${index}`} id={sectionId} data-manifest-key={section.key}>
            <SectionErrorBoundary sectionKey={section.key} fallback={errFallback}>
              <Suspense fallback={null}>
                <LazyComponent {...section.props} />
              </Suspense>
            </SectionErrorBoundary>
          </section>
        );
      })}
    </>
  );
}
