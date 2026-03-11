import { Link } from "@tanstack/react-router";
import type { ResolvedSection } from "../cms/resolve";
import { DecoPageRenderer } from "../hooks/DecoPageRenderer";

/**
 * Default CMS page component. Renders all resolved sections.
 * Sites can use this directly or build their own.
 */
export function CmsPage({ sections }: { sections: ResolvedSection[] }) {
  return (
    <div>
      <DecoPageRenderer sections={sections} />
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
