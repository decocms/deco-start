import type { ComponentType } from "react";

export type SectionModule = {
  default: ComponentType<any>;
  loader?: (props: any) => Promise<any> | any;
  LoadingFallback?: ComponentType<any>;
};

type RegistryEntry = () => Promise<SectionModule>;

const registry: Record<string, RegistryEntry> = {};

export function registerSection(key: string, loader: RegistryEntry) {
  registry[key] = loader;
}

export function registerSections(sections: Record<string, RegistryEntry>) {
  Object.assign(registry, sections);
}

export function getSection(resolveType: string): RegistryEntry | undefined {
  return registry[resolveType];
}

export function listRegisteredSections(): string[] {
  return Object.keys(registry);
}
