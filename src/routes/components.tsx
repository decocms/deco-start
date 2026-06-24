import { Link } from "@tanstack/react-router";
import type { DeferredSection, ResolvedSection } from "../cms/resolve";
import { DecoPageRenderer } from "../hooks/DecoPageRenderer";
import type { Device } from "../sdk/useDevice";

/**
 * Default CMS page component. Renders all resolved sections.
 * Sites can use this directly or build their own.
 */
export function CmsPage({
  sections,
  deferredSections,
  deferredPromises,
  pagePath,
  pageUrl,
  device,
}: {
  sections: ResolvedSection[];
  deferredSections?: DeferredSection[];
  deferredPromises?: Record<string, Promise<ResolvedSection | null>>;
  pagePath?: string;
  pageUrl?: string;
  /** Server-resolved device from the page loader — keeps useDevice() hydration-stable. */
  device?: Device;
}) {
  return (
    <div>
      <DecoPageRenderer
        sections={sections}
        deferredSections={deferredSections}
        deferredPromises={deferredPromises}
        pagePath={pagePath}
        pageUrl={pageUrl}
        device={device}
      />
    </div>
  );
}

/**
 * Default 404 page for CMS routes.
 * Sites can override with their own branded version.
 */
export function NotFoundPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-base-content/20 mb-4">404</h1>
        <h2 className="text-2xl font-bold mb-2">Page Not Found</h2>
        <p className="text-base-content/60 mb-6">No CMS page block matches this URL.</p>
        <Link to="/" className="btn btn-primary">
          Go Home
        </Link>
      </div>
    </div>
  );
}
