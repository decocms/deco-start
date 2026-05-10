import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

const rootRoute = createRootRoute();

const previewRouter = createRouter({
  // TanStack Router's RootRoute/Route generic inference rejects bare rootRoute
  // at the type level (works at runtime). `as any` avoids leaking the mismatch
  // into consumer sites that typecheck framework source via npm link.
  routeTree: rootRoute as any,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

/**
 * Default preview wrapper for admin iframe rendering.
 * Provides a TanStack Router context with memory history so components
 * that depend on router hooks (Link, useNavigate, etc.) work in previews.
 */
export default function PreviewProviders({ children }: { children: ReactNode }) {
  return <RouterContextProvider router={previewRouter as any}>{children}</RouterContextProvider>;
}
