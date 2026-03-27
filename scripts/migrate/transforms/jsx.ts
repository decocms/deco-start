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
  if (/(<[a-zA-Z][^>]*?\s)class(\s*=)/.test(result)) {
    result = result.replace(
      /(<[a-zA-Z][^>]*?\s)class(\s*=)/g,
      "$1className$2",
    );
    changed = true;
    notes.push("Replaced class= with className=");
  }

  // Also handle class= at the start of a line in JSX (multi-line attributes)
  if (/^(\s+)class(\s*=)/m.test(result)) {
    result = result.replace(/^(\s+)class(\s*=)/gm, "$1className$2");
    changed = true;
  }

  // onInput= → onChange=
  if (result.includes("onInput=")) {
    result = result.replace(/onInput=/g, "onChange=");
    changed = true;
    notes.push("Replaced onInput= with onChange=");
  }

  // for= → htmlFor= in JSX (label elements)
  if (/(<(?:label|Label)[^>]*?\s)for(\s*=)/.test(result)) {
    result = result.replace(
      /(<(?:label|Label)[^>]*?\s)for(\s*=)/g,
      "$1htmlFor$2",
    );
    changed = true;
    notes.push("Replaced for= with htmlFor= on label elements");
  }
  // Also handle for= at the start of a line in multi-line JSX attributes
  if (/^\s+for\s*=\s*\{/m.test(result)) {
    result = result.replace(/^(\s+)for(\s*=\s*\{)/gm, "$1htmlFor$2");
    changed = true;
  }

  // ComponentChildren → ReactNode (named import, not React.ReactNode)
  if (result.includes("ComponentChildren")) {
    result = result.replace(/\bComponentChildren\b/g, "ReactNode");
    // Add ReactNode import if not already imported
    if (
      !result.match(/\bReactNode\b.*from\s+["']react["']/) &&
      !result.match(/from\s+["']react["'].*\bReactNode\b/)
    ) {
      // Check if there's already a react import we can extend
      const reactImportMatch = result.match(
        /^(import\s+(?:type\s+)?\{)([^}]*?)(\}\s+from\s+["']react["'];?)$/m,
      );
      if (reactImportMatch) {
        const [fullMatch, prefix, existing, suffix] = reactImportMatch;
        const items = existing.trim();
        result = result.replace(
          fullMatch,
          `${prefix}${items ? `${items}, ` : ""}type ReactNode${suffix}`,
        );
      } else {
        result = `import type { ReactNode } from "react";\n${result}`;
      }
    }
    changed = true;
    notes.push("Replaced ComponentChildren with ReactNode");
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

  // tabindex → tabIndex in JSX
  if (/\btabindex\s*=/.test(result)) {
    result = result.replace(/\btabindex(\s*=)/g, "tabIndex$1");
    changed = true;
    notes.push("Replaced tabindex with tabIndex");
  }

  // frameBorder → frameBorder (already camelCase, but just in case)
  // referrerpolicy → referrerPolicy
  if (result.includes("referrerpolicy=")) {
    result = result.replace(/referrerpolicy=/g, "referrerPolicy=");
    changed = true;
    notes.push("Replaced referrerpolicy with referrerPolicy");
  }

  // allowFullScreen={true} is fine in React, but allowfullscreen is not
  if (result.includes("allowfullscreen")) {
    result = result.replace(/\ballowfullscreen\b/g, "allowFullScreen");
    changed = true;
  }

  // `class` as a prop name in destructuring patterns → `className`
  // Matches: { class: someVar } or { class, } or { ..., class: x } in function params
  if (/[{,]\s*class\s*[,}:]/.test(result)) {
    // class: varName → className: varName (anywhere in destructuring)
    result = result.replace(
      /([{,]\s*)class(\s*:\s*\w+)/g,
      "$1className$2",
    );
    // class, → className, (shorthand, anywhere in destructuring)
    result = result.replace(
      /([{,]\s*)class(\s*[,}])/g,
      "$1className$2",
    );
    changed = true;
    notes.push("Replaced 'class' prop in destructuring with 'className'");
  }

  // `class` in interface/type definitions → className
  // Matches: class?: string; or class: string;
  if (/^\s+class\??\s*:/m.test(result)) {
    result = result.replace(/^(\s+)class(\??\s*:)/gm, "$1className$2");
    changed = true;
    notes.push("Replaced 'class' in interface definitions with 'className'");
  }

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
