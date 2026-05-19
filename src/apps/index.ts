/**
 * Public entry point for app-install primitives.
 *
 * Sites import from `@decocms/start/apps`:
 *   - `autoconfigApps(blocks, registry)` — main bootstrap call
 *   - `AppRegistry`, `AppRegistryEntry` — registry types
 *   - `setupApps`, `AppDefinition` — lower-level primitives when composing custom registries
 */

export {
  autoconfigApps,
  type AppRegistry,
  type AppRegistryEntry,
} from "./autoconfig";

export {
  setupApps,
  registerAppMiddleware,
  getAppMiddleware,
  type AppDefinition,
  type AppDefinitionWithHandlers,
  type AppManifest,
  type AppMiddleware,
} from "../sdk/setupApps";
