/**
 * @decocms/start/core — framework-agnostic surface.
 *
 * No imports from @tanstack/*, next/*, or top-level node:async_hooks.
 * Safe to use from any host (TanStack, Next.js, plain Node, browsers).
 */

// CMS resolution & registry
export * from "./cms/index";

// Admin protocol handlers (request/response via Web APIs only)
export * as admin from "./admin/index";

// Matchers
export * as matchers from "./matchers/builtins";

// Types
export * from "./types/index";

// SDK utilities
export * from "./sdk/index";

// Runtime abstractions
export { noopRequestStore, type RequestStore } from "./runtime/index";
