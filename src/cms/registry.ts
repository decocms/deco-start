import type { ComponentType } from "react";

export type OnBeforeResolveProps = (
  props: Record<string, unknown>,
) => Record<string, unknown>;

export type SectionModule = {
  default: ComponentType<any>;
  loader?: (props: any) => Promise<any> | any;
  onBeforeResolveProps?: OnBeforeResolveProps;
  LoadingFallback?: ComponentType<any>;
  ErrorFallback?: ComponentType<{ error: Error }>;
};

type RegistryEntry = () => Promise<SectionModule>;

export interface SectionOptions {
  /** Custom loading fallback component for this section. */
  loadingFallback?: ComponentType<any>;
  /** Custom error fallback component for this section. */
  errorFallback?: ComponentType<{ error: Error }>;
  /**
   * When true, the section is wrapped in `<ClientOnly>` from TanStack Router.
   * It renders only on the client — no SSR, no hydration mismatch.
   * Use for analytics scripts, GTM, third-party widgets, and other
   * browser-dependent components.
   */
  clientOnly?: boolean;
}

// globalThis-backed: server function split modules need access to the registry
const G = globalThis as any;
if (!G.__deco) G.__deco = {};
if (!G.__deco.sectionRegistry) G.__deco.sectionRegistry = {};
if (!G.__deco.sectionOptions) G.__deco.sectionOptions = {};
if (!G.__deco.resolvedComponents) G.__deco.resolvedComponents = {};
if (!G.__deco.syncComponents) G.__deco.syncComponents = {};
if (!G.__deco.onBeforeResolvePropsRegistry)
  G.__deco.onBeforeResolvePropsRegistry = {};

const registry: Record<string, RegistryEntry> = G.__deco.sectionRegistry;
const sectionOptions: Record<string, SectionOptions> = G.__deco.sectionOptions;

// Cache of already-resolved component references.
// When a module is loaded (server-side or after first client import),
// the default export is stored here so subsequent renders can use
// the component directly WITHOUT React.lazy/Suspense — preventing
// hydration flash on SSR'd content.
const resolvedComponents: Record<string, ComponentType<any>> = G.__deco.resolvedComponents;

// Static sync registry — components that were statically imported and
// are guaranteed available on BOTH server and client without any async import.
// These never need React.lazy/Suspense and render identically on SSR and hydration.
const syncComponents: Record<string, ComponentType<any>> = G.__deco.syncComponents;

// onBeforeResolveProps registry — functions that transform raw CMS props
// BEFORE resolvables are resolved. Allows sections to extract data from
// raw resolvable structures (e.g., collection IDs from loader refs) that
// would be lost after resolution.
const onBeforeResolvePropsRegistry: Record<string, OnBeforeResolveProps> =
  G.__deco.onBeforeResolvePropsRegistry;

export function registerSection(key: string, loader: RegistryEntry, options?: SectionOptions) {
  registry[key] = loader;
  if (options) sectionOptions[key] = options;
}

export function registerSections(
  sections: Record<string, RegistryEntry>,
  defaultOptions?: SectionOptions,
) {
  for (const [key, loader] of Object.entries(sections)) {
    registry[key] = loader;
    if (defaultOptions) sectionOptions[key] = { ...defaultOptions };
  }
}

export function getSection(resolveType: string): RegistryEntry | undefined {
  return registry[resolveType];
}

export function getSectionOptions(resolveType: string): SectionOptions | undefined {
  return sectionOptions[resolveType];
}

/**
 * Load a section module eagerly to extract LoadingFallback/ErrorFallback.
 * Used by DeferredSectionWrapper to show custom skeletons before the section
 * scrolls into view and its full props are fetched.
 */
export async function preloadSectionModule(
  resolveType: string,
): Promise<SectionOptions | undefined> {
  const existing = sectionOptions[resolveType];
  if (existing?.loadingFallback) return existing;

  const loader = registry[resolveType];
  if (!loader) return undefined;

  try {
    const mod = await loader();
    const opts: SectionOptions = { ...existing };
    if (mod.LoadingFallback) opts.loadingFallback = mod.LoadingFallback;
    if (mod.ErrorFallback) opts.errorFallback = mod.ErrorFallback;
    sectionOptions[resolveType] = opts;
    return opts;
  } catch (e) {
    console.warn(`[Registry] Failed to preload section module "${resolveType}":`, e);
    return existing;
  }
}

/**
 * Get a previously resolved component. Returns undefined if the module
 * hasn't been imported yet. Use this to render WITHOUT React.lazy/Suspense
 * for sections whose JS is already loaded — avoids hydration flash.
 */
export function getResolvedComponent(key: string): ComponentType<any> | undefined {
  return resolvedComponents[key];
}

/**
 * Store a resolved component reference. Called after a successful import()
 * so future renders can skip React.lazy entirely.
 */
export function setResolvedComponent(key: string, component: ComponentType<any>): void {
  resolvedComponents[key] = component;
}

/**
 * Pre-import section modules and cache their default exports.
 * Called server-side after resolving eager sections so that
 * the SSR render tree uses direct component refs instead of React.lazy.
 */
export async function preloadSectionComponents(keys: string[]): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      if (resolvedComponents[key]) return;
      const loader = registry[key];
      if (!loader) return;
      try {
        const mod = await loader();
        if (mod?.default) {
          resolvedComponents[key] = mod.default;
        }
        if (mod?.onBeforeResolveProps && !onBeforeResolvePropsRegistry[key]) {
          onBeforeResolvePropsRegistry[key] = mod.onBeforeResolveProps;
        }
        const opts: SectionOptions = { ...sectionOptions[key] };
        if (mod.LoadingFallback) opts.loadingFallback = mod.LoadingFallback;
        if (mod.ErrorFallback) opts.errorFallback = mod.ErrorFallback;
        sectionOptions[key] = opts;
      } catch (e) {
        console.warn(`[Registry] Failed to preload component "${key}":`, e);
      }
    }),
  );
}

/**
 * A sync section entry: either a plain component reference or a full module
 * object with optional LoadingFallback and ErrorFallback.
 * Providing the full module allows DeferredSectionWrapper to show the correct
 * skeleton immediately (optionsReady=true on first render) without waiting for
 * the async preloadSectionModule() call.
 */
export type SyncSectionEntry =
  | ComponentType<any>
  | {
      default: ComponentType<any>;
      LoadingFallback?: ComponentType<any>;
      ErrorFallback?: ComponentType<{ error: Error }>;
    };

/**
 * Register sections with their already-imported component references.
 * These are available synchronously on both server and client — no dynamic
 * import, no React.lazy, no Suspense. Use for critical above-the-fold
 * sections that must never flash during hydration.
 *
 * Accepts either a plain component or a full module object (with optional
 * LoadingFallback / ErrorFallback). Providing the module object populates
 * sectionOptions immediately, so DeferredSectionWrapper can show the correct
 * skeleton without an extra async preloadSectionModule() round-trip.
 */
export function registerSectionsSync(sections: Record<string, SyncSectionEntry>): void {
  for (const [key, entry] of Object.entries(sections)) {
    const raw = typeof entry === "function" ? entry : (entry as any).default;
    // Accept functions and React wrapper objects (React.memo, forwardRef, lazy)
    const REACT_WRAPPERS = [
      Symbol.for("react.memo"),
      Symbol.for("react.forward_ref"),
      Symbol.for("react.lazy"),
    ];
    const component =
      typeof raw === "function" ||
      (raw != null &&
        typeof raw === "object" &&
        REACT_WRAPPERS.includes((raw as any).$$typeof))
        ? raw
        : undefined;
    if (!component) {
      console.warn(`[registerSectionsSync] "${key}" has no callable default export — skipping`);
      continue;
    }
    syncComponents[key] = component;
    resolvedComponents[key] = component;

    if (typeof entry !== "function") {
      const opts: SectionOptions = { ...sectionOptions[key] };
      if (entry.LoadingFallback) opts.loadingFallback = entry.LoadingFallback;
      if (entry.ErrorFallback) opts.errorFallback = entry.ErrorFallback;
      sectionOptions[key] = opts;
    }
  }
}

/**
 * Get a synchronously-registered component. Returns undefined if the
 * section was only registered with a lazy loader (registerSections).
 */
export function getSyncComponent(key: string): ComponentType<any> | undefined {
  return syncComponents[key];
}

/**
 * Register an onBeforeResolveProps function for a section.
 * Called with raw CMS props (containing unresolved `__resolveType` references)
 * BEFORE the resolution engine resolves them. Use to extract metadata from
 * resolvable structures that would be lost after resolution.
 */
export function registerOnBeforeResolveProps(
  sectionKey: string,
  fn: OnBeforeResolveProps,
): void {
  onBeforeResolvePropsRegistry[sectionKey] = fn;
}

/** Get the registered onBeforeResolveProps for a section, if any. */
export function getOnBeforeResolveProps(
  sectionKey: string,
): OnBeforeResolveProps | undefined {
  return onBeforeResolvePropsRegistry[sectionKey];
}

export function listRegisteredSections(): string[] {
  return Object.keys(registry);
}

export function getSectionRegistry(): Record<string, RegistryEntry> {
  return registry;
}
