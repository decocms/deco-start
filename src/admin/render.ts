import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { getSection } from "../cms/registry";
import { loadBlocks } from "../cms/loader";

/**
 * Handles /deco/render -- renders a single section to HTML.
 * The admin calls this to preview individual sections during editing.
 */
export async function handleRender(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const resolveChain = url.searchParams.get("resolveChain");
  const propsParam = url.searchParams.get("props");

  let component = resolveChain || "";
  let props: Record<string, unknown> = {};

  if (propsParam) {
    try {
      props = JSON.parse(decodeURIComponent(propsParam));
    } catch {
      // props parsing failed
    }
  }

  // Extract the section resolve type
  if (props.__resolveType) {
    component = props.__resolveType as string;
  }

  // If the component is a named block, resolve it
  const blocks = loadBlocks();
  if (blocks[component]) {
    const block = blocks[component] as Record<string, unknown>;
    if (block.__resolveType) {
      component = block.__resolveType as string;
      props = { ...block, ...props };
    }
  }

  const sectionLoader = getSection(component);
  if (!sectionLoader) {
    return new Response(
      `<div style="padding:20px;color:red;">Unknown section: ${component}</div>`,
      {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }
    );
  }

  try {
    const mod = await sectionLoader();
    const html = renderToString(createElement(mod.default, props));

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    return new Response(
      `<div style="padding:20px;color:red;">Render error: ${(error as Error).message}</div>`,
      {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }
    );
  }
}
