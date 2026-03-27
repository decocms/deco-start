import type { TransformResult } from "../types.ts";

/**
 * Transforms Preact JSX patterns to React JSX patterns.
 *
 * - class= → className= (in JSX context)
 * - onInput= → onChange= (React's onChange fires on every keystroke)
 * - ComponentChildren → React.ReactNode
 * - JSX.SVGAttributes → React.SVGAttributes
 * - JSX.GenericEventHandler → React.FormEventHandler / React.EventHandler
 * - type { JSX } from "preact" → (removed, use React types)
 */
export function transformJsx(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;
  let result = content;

  // class= → className= in JSX attributes
  // Match class= that's preceded by whitespace and inside a JSX tag
  const classAttrRegex = /(<[a-zA-Z][^>]*?\s)class(\s*=)/g;
  if (classAttrRegex.test(result)) {
    result = result.replace(
      /(<[a-zA-Z][^>]*?\s)class(\s*=)/g,
      "$1className$2",
    );
    changed = true;
    notes.push("Replaced class= with className=");
  }

  // Also handle class= at the start of a line in JSX (multi-line attributes)
  const standaloneClassRegex = /^(\s+)class(\s*=)/gm;
  if (standaloneClassRegex.test(result)) {
    result = result.replace(standaloneClassRegex, "$1className$2");
    changed = true;
  }

  // onInput= → onChange=
  if (result.includes("onInput=")) {
    result = result.replace(/onInput=/g, "onChange=");
    changed = true;
    notes.push("Replaced onInput= with onChange=");
  }

  // ComponentChildren → React.ReactNode
  if (result.includes("ComponentChildren")) {
    result = result.replace(/\bComponentChildren\b/g, "React.ReactNode");
    // Add React import if not present
    if (!result.includes('from "react"') && !result.includes("from 'react'")) {
      result = `import React from "react";\n${result}`;
    }
    changed = true;
    notes.push("Replaced ComponentChildren with React.ReactNode");
  }

  // JSX.SVGAttributes<SVGSVGElement> → React.SVGAttributes<SVGSVGElement>
  if (result.includes("JSX.SVGAttributes")) {
    result = result.replace(/\bJSX\.SVGAttributes/g, "React.SVGAttributes");
    changed = true;
    notes.push("Replaced JSX.SVGAttributes with React.SVGAttributes");
  }

  // JSX.GenericEventHandler<X> → React.FormEventHandler<X>
  if (result.includes("JSX.GenericEventHandler")) {
    result = result.replace(
      /\bJSX\.GenericEventHandler/g,
      "React.FormEventHandler",
    );
    changed = true;
    notes.push(
      "Replaced JSX.GenericEventHandler with React.FormEventHandler",
    );
  }

  // JSX.HTMLAttributes<X> → React.HTMLAttributes<X>
  if (result.includes("JSX.HTMLAttributes")) {
    result = result.replace(
      /\bJSX\.HTMLAttributes/g,
      "React.HTMLAttributes",
    );
    changed = true;
  }

  // JSX.IntrinsicElements → React.JSX.IntrinsicElements
  if (result.includes("JSX.IntrinsicElements")) {
    result = result.replace(
      /\bJSX\.IntrinsicElements/g,
      "React.JSX.IntrinsicElements",
    );
    changed = true;
  }

  // Remove standalone "import type { JSX } from 'preact'" if JSX no longer used
  // (it was already removed by imports transform, but double check)
  result = result.replace(
    /^import\s+type\s+\{\s*JSX\s*\}\s+from\s+["']preact["'];?\s*\n?/gm,
    "",
  );

  // Ensure React import exists if we introduced React.* references
  if (
    (result.includes("React.") || result.includes("React,")) &&
    !result.match(/^import\s.*React/m)
  ) {
    result = `import React from "react";\n${result}`;
    changed = true;
  }

  return { content: result, changed, notes };
}
