import { createElement } from "react";
import { loadBlocks, withBlocksOverride } from "../cms/loader";
import { getSection } from "../cms/registry";
import { resolveValue, WELL_KNOWN_TYPES } from "../cms/resolve";
import { buildHtmlShell } from "../sdk/htmlShell";
import { LIVE_CONTROLS_SCRIPT } from "./liveControls";

export { setRenderShell } from "./setup";

function wrapInHtmlShell(sectionHtml: string): string {
  return buildHtmlShell({ body: sectionHtml, script: LIVE_CONTROLS_SCRIPT });
}

/**
 * Render a single resolved section object to an HTML string.
 * Returns empty string for unknown or SEO-only sections.
 */
async function renderOneSection(section: Record<string, unknown>): Promise<string> {
  const resolveType = section.__resolveType as string | undefined;
  if (!resolveType) return "";

  const sectionLoader = getSection(resolveType);
  if (!sectionLoader) {
    return `<div style="padding:8px;color:orange;font-size:12px;border:1px dashed orange;margin:4px 0;">Unsupported: ${resolveType}</div>`;
  }

  try {
    const { __resolveType: _, ...sectionProps } = section;
    const { renderToString } = await import("react-dom/server");
    const mod = await sectionLoader();
    return renderToString(createElement(mod.default, sectionProps));
  } catch (error) {
    return `<div style="padding:8px;color:red;font-size:12px;">Error rendering ${resolveType}: ${(error as Error).message}</div>`;
  }
}

/**
 * Handles /live/previews/* -- renders sections to HTML for the admin preview.
 *
 * Supports:
 * - Page compositor (website/pages/Page.tsx): resolves + renders all child sections
 * - Single section render with full __resolveType resolution
 * - Per-request decofile override via AsyncLocalStorage
 */
export async function handleRender(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const resolveChain = url.searchParams.get("resolveChain");
  const propsParam = url.searchParams.get("props");

  const pathPrefix = "/live/previews/";
  const pathComponent = url.pathname.startsWith(pathPrefix)
    ? url.pathname.slice(pathPrefix.length)
    : "";
  let component = resolveChain || pathComponent || "";
  let props: Record<string, unknown> = {};
  let decofileOverride: Record<string, unknown> | null = null;

  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (body && typeof body === "object") {
        if (body.__decofile && typeof body.__decofile === "object") {
          decofileOverride = body.__decofile;
        }
        if (body.__props && typeof body.__props === "object") {
          props = body.__props;
          if (body.__props.__resolveType) {
            component = body.__props.__resolveType as string;
          }
        } else if (body.props && typeof body.props === "object") {
          props = body.props;
        } else if (body.__resolveType) {
          component = body.__resolveType as string;
          const { __decofile: _, __resolveType: __, ...rest } = body;
          props = rest;
        } else if (!body.__decofile) {
          props = body;
        }
      }
    } catch {
      // fall through to query-param handling
    }
  }

  if (!decofileOverride) {
    const decofileParam = url.searchParams.get("__decofile");
    if (decofileParam) {
      try {
        decofileOverride = JSON.parse(decodeURIComponent(decofileParam));
      } catch {
        // invalid __decofile param, ignore
      }
    }
  }

  if (propsParam && Object.keys(props).length === 0) {
    try {
      props = JSON.parse(decodeURIComponent(propsParam));
    } catch {
      // props parsing failed
    }
  }

  if (props.__resolveType && !component) {
    component = props.__resolveType as string;
  }

  const renderFn = async () => {
    const blocks = loadBlocks();

    // Resolve named block at the component level
    if (blocks[component]) {
      const block = blocks[component] as Record<string, unknown>;
      if (block.__resolveType) {
        component = block.__resolveType as string;
        props = { ...block, ...props };
      }
    }

    // Page compositor: resolve + render all child sections
    if (component === WELL_KNOWN_TYPES.PAGE) {
      const rawSections = props.sections;
      const resolvedSections = await resolveValue(rawSections);
      const sectionsList = Array.isArray(resolvedSections)
        ? resolvedSections
        : resolvedSections
          ? [resolvedSections]
          : [];

      const htmlParts: string[] = [];
      for (const section of sectionsList) {
        if (!section || typeof section !== "object" || Array.isArray(section)) {
          continue;
        }
        const sectionObj = section as Record<string, unknown>;
        if (!sectionObj.__resolveType) continue;
        const html = await renderOneSection(sectionObj);
        if (html) htmlParts.push(html);
      }

      return new Response(wrapInHtmlShell(htmlParts.join("\n")), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Single section render
    const sectionLoader = getSection(component);
    if (!sectionLoader) {
      const unknownHtml = wrapInHtmlShell(
        `<div style="padding:20px;color:red;">Unknown section: ${component}</div>`,
      );
      return new Response(unknownHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    try {
      const resolvedProps = (await resolveValue(props)) as Record<string, unknown>;
      const { __resolveType: _, ...cleanProps } = resolvedProps;
      const { renderToString } = await import("react-dom/server");
      const mod = await sectionLoader();
      const sectionHtml = renderToString(createElement(mod.default, cleanProps));
      return new Response(wrapInHtmlShell(sectionHtml), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      const errorHtml = wrapInHtmlShell(
        `<div style="padding:20px;color:red;">Render error: ${(error as Error).message}</div>`,
      );
      return new Response(errorHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
  };

  if (decofileOverride) {
    return withBlocksOverride(decofileOverride, renderFn);
  }
  return renderFn();
}
