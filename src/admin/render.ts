import { createElement } from "react";
import { loadBlocks, withBlocksOverride } from "../cms/loader";
import { getSection } from "../cms/registry";
import {
  type MatcherContext,
  type ResolvedSection,
  resolvePageSections,
  resolveValue,
  WELL_KNOWN_TYPES,
} from "../cms/resolve";
import { runSingleSectionLoader } from "../cms/sectionLoaders";
import { buildHtmlShell } from "../sdk/htmlShell";
import { LIVE_CONTROLS_SCRIPT } from "./liveControls";
import { getPreviewWrapper } from "./setup";

export { setRenderShell, setPreviewWrapper } from "./setup";

// Cache the dynamic import — avoids re-importing per section render
let _renderToString: ((element: any) => string) | null = null;
async function getRenderToString() {
  if (!_renderToString) {
    const mod = await import("react-dom/server");
    _renderToString = mod.renderToString;
  }
  return _renderToString;
}

function wrapInHtmlShell(sectionHtml: string): string {
  return buildHtmlShell({ body: sectionHtml, script: LIVE_CONTROLS_SCRIPT });
}

/**
 * Render a single ResolvedSection to an HTML string.
 * Uses the pre-cached renderToString and the preview wrapper.
 */
async function renderResolvedSection(section: ResolvedSection): Promise<string> {
  const sectionLoader = getSection(section.component);
  if (!sectionLoader) {
    return `<div style="padding:8px;color:orange;font-size:12px;border:1px dashed orange;margin:4px 0;">Unsupported: ${section.component}</div>`;
  }

  try {
    const renderToString = await getRenderToString();
    const mod = await sectionLoader();
    const element = createElement(mod.default, section.props);
    const Wrapper = getPreviewWrapper();
    const wrapped = Wrapper ? createElement(Wrapper, null, element) : element;
    return renderToString(wrapped);
  } catch (error) {
    return `<div style="padding:8px;color:red;font-size:12px;">Error rendering ${section.component}: ${(error as Error).message}</div>`;
  }
}

/**
 * Render a single raw section object (with __resolveType) to HTML.
 * Kept for the single-section preview path where we don't go through
 * resolvePageSections.
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
    const renderToString = await getRenderToString();
    const mod = await sectionLoader();
    const element = createElement(mod.default, sectionProps);
    const Wrapper = getPreviewWrapper();
    const wrapped = Wrapper ? createElement(Wrapper, null, element) : element;
    return renderToString(wrapped);
  } catch (error) {
    return `<div style="padding:8px;color:red;font-size:12px;">Error rendering ${resolveType}: ${(error as Error).message}</div>`;
  }
}

/**
 * Build a MatcherContext from the preview request.
 * Enables matchers (device, date, cookie, etc.) to evaluate correctly
 * during preview resolution.
 */
function buildPreviewMatcherCtx(request: Request): MatcherContext {
  const url = new URL(request.url);
  const deviceHint = url.searchParams.get("deviceHint");
  const path = url.searchParams.get("path") || "/";

  let userAgent = request.headers.get("user-agent") ?? "";
  if (deviceHint === "mobile" && !/mobile/i.test(userAgent)) {
    userAgent += " Mobile";
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k.trim()] = v.join("=").trim();
  }

  return {
    userAgent,
    url: url.toString(),
    path,
    cookies,
    request,
  };
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

    // Page compositor: resolve + render all child sections in parallel
    if (component === WELL_KNOWN_TYPES.PAGE) {
      const matcherCtx = buildPreviewMatcherCtx(request);

      // resolvePageSections uses the same strategy as resolveDecoPage:
      // parallel section resolution, layout caching, in-flight dedup, memoization
      const resolvedSections = await resolvePageSections(
        props.sections,
        matcherCtx,
      );

      // Run section loaders in parallel — benefits from layout and cacheable caches
      const enrichedSections = await Promise.all(
        resolvedSections.map((section) =>
          runSingleSectionLoader(section, request).catch(() => section),
        ),
      );

      // Render all sections in parallel
      const htmlParts = await Promise.all(
        enrichedSections.map((section) => renderResolvedSection(section)),
      );

      return new Response(wrapInHtmlShell(htmlParts.filter(Boolean).join("\n")), {
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
      const renderToString = await getRenderToString();
      const mod = await sectionLoader();
      const element = createElement(mod.default, cleanProps);
      const Wrapper = getPreviewWrapper();
      const wrapped = Wrapper ? createElement(Wrapper, null, element) : element;
      const sectionHtml = renderToString(wrapped);
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
