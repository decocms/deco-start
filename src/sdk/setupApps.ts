/**
 * App system integration pipeline.
 *
 * Consumes AppDefinition objects from @decocms/apps and automates:
 * 1. Invoke handler registration (from manifest + explicit handlers)
 * 2. Section registration (when manifest.sections is available)
 * 3. App middleware registration (with state injection into RequestContext)
 *
 * @example
 * ```ts
 * import { setupApps } from "@decocms/start/sdk/setupApps";
 * import * as vtexApp from "@decocms/apps/vtex/mod";
 * import * as resendApp from "@decocms/apps/resend/mod";
 *
 * const vtex = await vtexApp.configure(blocks["deco-vtex"], resolveSecret);
 * const resend = await resendApp.configure(blocks["deco-resend"], resolveSecret);
 *
 * await setupApps([vtex, resend].filter(Boolean));
 * ```
 */

import { clearInvokeHandlers, registerInvokeHandlers } from "../admin/invoke";
import { registerSections } from "../cms/registry";
import { RequestContext } from "./requestContext";

// ---------------------------------------------------------------------------
// Types — mirrors @decocms/apps/commerce/app-types without importing it
// ---------------------------------------------------------------------------

export interface AppManifest {
  name: string;
  loaders: Record<string, Record<string, unknown>>;
  actions: Record<string, Record<string, unknown>>;
  sections?: Record<string, () => Promise<any>>;
}

export interface AppMiddleware {
  (request: Request, next: () => Promise<Response>): Promise<Response>;
}

export interface AppDefinition<TState = unknown> {
  name: string;
  manifest: AppManifest;
  state: TState;
  middleware?: AppMiddleware;
  dependencies?: AppDefinition[];
}

/**
 * Extended definition with optional explicit handlers.
 * autoconfigApps() attaches mod.handlers here before calling setupApps().
 */
export interface AppDefinitionWithHandlers<TState = unknown>
  extends AppDefinition<TState> {
  /** Pre-wrapped handlers from the app's mod.ts (e.g. unwrapped VTEX actions). */
  handlers?: Record<string, (props: any, request: Request) => Promise<any>>;
}

// ---------------------------------------------------------------------------
// App middleware registry
// ---------------------------------------------------------------------------

/** Per-app state entries — injected into RequestContext.bag on every request. */
const appStates: Array<{ name: string; state: unknown }> = [];

const appMiddlewares: Array<{
  name: string;
  middleware: AppMiddleware;
}> = [];

function registerAppState(name: string, state: unknown) {
  appStates.push({ name, state });
}

export function registerAppMiddleware(
  name: string,
  mw: AppMiddleware,
) {
  appMiddlewares.push({ name, middleware: mw });
}

/**
 * Clear all registrations. Called before re-running setupApps()
 * on admin hot-reload to prevent duplicate middleware/state entries.
 */
function clearRegistrations() {
  appStates.length = 0;
  appMiddlewares.length = 0;
}

/**
 * Returns a chained middleware that runs all registered app middlewares.
 * The site wires this into its own createMiddleware() chain.
 *
 * Before running app middlewares, all app states are injected into
 * RequestContext.bag so loaders can access them via getAppState().
 *
 * Returns undefined if no app states or middlewares were registered.
 */
export function getAppMiddleware(): AppMiddleware | undefined {
  if (appStates.length === 0 && appMiddlewares.length === 0) return undefined;

  return async (request, next) => {
    // Inject all app states into RequestContext bag
    for (const { name, state } of appStates) {
      RequestContext.setBag(`app:${name}:state`, state);
    }

    // Chain app middlewares (first registered runs outermost)
    if (appMiddlewares.length === 0) return next();
    const run = async (i: number): Promise<Response> => {
      if (i >= appMiddlewares.length) return next();
      return appMiddlewares[i].middleware(request, () => run(i + 1));
    };
    return run(0);
  };
}

// ---------------------------------------------------------------------------
// Dependency flattening
// ---------------------------------------------------------------------------

/**
 * Topological sort: dependencies before parents.
 * Combined with first-wins registration in registerInvokeHandlers,
 * this means parent apps can override handlers from their dependencies
 * by providing explicit `handlers` (registered before manifest flatten).
 */
function flattenDependencies(apps: AppDefinition[]): AppDefinition[] {
  const seen = new Set<string>();
  const result: AppDefinition[] = [];

  function visit(app: AppDefinition) {
    if (seen.has(app.name)) return;
    seen.add(app.name);
    if (app.dependencies) {
      for (const dep of app.dependencies) visit(dep);
    }
    result.push(app);
  }

  for (const app of apps) visit(app);
  return result;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Initialize apps from their AppDefinitions.
 *
 * Call once in setup.ts after configuring apps via their mod.configure().
 * Handles: invoke handler registration, section registration, middleware setup.
 */
export async function setupApps(
  apps: Array<AppDefinitionWithHandlers | AppDefinition>,
): Promise<void> {
  if (typeof document !== "undefined") return; // server-only

  // Clear previous registrations (safe for hot-reload via onChange)
  clearRegistrations();
  clearInvokeHandlers();

  for (const app of flattenDependencies(apps as AppDefinition[])) {
    const appWithHandlers = app as AppDefinitionWithHandlers;

    // 1. Register explicit handlers (pre-unwrapped by the app, e.g. resend)
    if (appWithHandlers.handlers) {
      registerInvokeHandlers(appWithHandlers.handlers);
    }

    // 2. Flatten manifest modules → individual invoke handlers
    // manifest.actions["vtex/actions/checkout"] = { getOrCreateCart, addItemsToCart, ... }
    // → register "vtex/actions/checkout/getOrCreateCart" as handler
    for (const category of ["loaders", "actions"] as const) {
      const modules = app.manifest[category];
      if (!modules) continue;

      for (const [moduleKey, moduleExports] of Object.entries(modules)) {
        for (const [fnName, fn] of Object.entries(
          moduleExports as Record<string, unknown>,
        )) {
          if (typeof fn !== "function") continue;
          const key = `${moduleKey}/${fnName}`;
          const handler = (props: any, req: Request) =>
            (fn as Function)(props, req);
          registerInvokeHandlers({
            [key]: handler,
            [`${key}.ts`]: handler,
          });
        }
      }
    }

    // 3. Register sections from manifest (future — when apps export sections)
    if (app.manifest.sections) {
      registerSections(
        app.manifest.sections as Record<string, () => Promise<any>>,
      );
    }

    // 4. Always register app state (so getAppState() works for all apps)
    registerAppState(app.name, app.state);

    // 5. Register middleware (optional — not all apps have middleware)
    if (app.middleware) {
      registerAppMiddleware(app.name, app.middleware);
    }
  }
}
