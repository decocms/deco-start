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

const registry: Record<string, RegistryEntry> = {};
const sectionOptions: Record<string, SectionOptions> = {};

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

export function listRegisteredSections(): string[] {
  return Object.keys(registry);
}

export function getSectionRegistry(): Record<string, RegistryEntry> {
  return registry;
}
