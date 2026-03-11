import type { ComponentType } from "react";

export type SectionModule = {
  default: ComponentType<any>;
  loader?: (props: any) => Promise<any> | any;
  LoadingFallback?: ComponentType<any>;
  ErrorFallback?: ComponentType<{ error: Error }>;
};

type RegistryEntry = () => Promise<SectionModule>;

export interface SectionOptions {
  /** Custom loading fallback component for this section. */
  loadingFallback?: ComponentType<any>;
  /** Custom error fallback component for this section. */
  errorFallback?: ComponentType<{ error: Error }>;
}

// globalThis-backed: server function split modules need access to the registry
const G = globalThis as any;
if (!G.__deco) G.__deco = {};
if (!G.__deco.sectionRegistry) G.__deco.sectionRegistry = {};
if (!G.__deco.sectionOptions) G.__deco.sectionOptions = {};
if (!G.__deco.resolvedComponents) G.__deco.resolvedComponents = {};
if (!G.__deco.syncComponents) G.__deco.syncComponents = {};

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
  } catch {
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
        const opts: SectionOptions = { ...sectionOptions[key] };
        if (mod.LoadingFallback) opts.loadingFallback = mod.LoadingFallback;
        if (mod.ErrorFallback) opts.errorFallback = mod.ErrorFallback;
        sectionOptions[key] = opts;
      } catch {
        /* ignore — will fall back to React.lazy */
      }
    }),
  );
}

/**
 * Register sections with their already-imported component references.
 * These are available synchronously on both server and client — no dynamic
 * import, no React.lazy, no Suspense. Use for critical above-the-fold
 * sections that must never flash during hydration.
 */
export function registerSectionsSync(sections: Record<string, ComponentType<any>>): void {
  for (const [key, component] of Object.entries(sections)) {
    syncComponents[key] = component;
    resolvedComponents[key] = component;
  }
}

/**
 * Get a synchronously-registered component. Returns undefined if the
 * section was only registered with a lazy loader (registerSections).
 */
export function getSyncComponent(key: string): ComponentType<any> | undefined {
  return syncComponents[key];
}

export function listRegisteredSections(): string[] {
  return Object.keys(registry);
}

export function getSectionRegistry(): Record<string, RegistryEntry> {
  return registry;
}
