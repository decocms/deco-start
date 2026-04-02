#!/usr/bin/env tsx
/**
 * Scans @decocms/apps vtex/invoke.ts and generates a site-local invoke file
 * with top-level createServerFn declarations.
 *
 * TanStack Start's compiler only transforms createServerFn().handler() when
 * the call is at module top-level (assigned to a const). The factory pattern
 * used in @decocms/apps/vtex/invoke.ts causes the "fast path" in the compiler
 * to skip the .handler() calls because they're inside a function body.
 *
 * This script generates an equivalent file where each server function is a
 * top-level const, which the compiler can correctly transform into RPC stubs.
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/start/scripts/generate-invoke.ts
 *
 * Env / CLI:
 *   --out-file   override output (default: src/server/invoke.gen.ts)
 *   --apps-dir   override @decocms/apps location (default: auto-resolve from node_modules)
 */
import fs from "node:fs";
import path from "node:path";
import { Project, type PropertyAssignment, SyntaxKind } from "ts-morph";

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const cwd = process.cwd();
const outFile = path.resolve(cwd, arg("out-file", "src/server/invoke.gen.ts"));

function resolveAppsDir(): string {
  const explicit = arg("apps-dir", "");
  if (explicit) return path.resolve(cwd, explicit);

  // Try common locations
  const candidates = [
    path.resolve(cwd, "node_modules/@decocms/apps"),
    path.resolve(cwd, "../apps-start"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "vtex/invoke.ts"))) return c;
  }
  throw new Error("Could not find @decocms/apps. Use --apps-dir to specify its location.");
}

const appsDir = resolveAppsDir();
const invokeFile = path.join(appsDir, "vtex/invoke.ts");

if (!fs.existsSync(invokeFile)) {
  console.error(`invoke.ts not found at: ${invokeFile}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse the source invoke.ts to extract action definitions
// ---------------------------------------------------------------------------

interface ActionDef {
  name: string;
  /** The import source for the action function (e.g., "@decocms/apps/vtex/actions/checkout") */
  importSource: string;
  /** The imported function name (e.g., "addItemsToCart") */
  importedFn: string;
  /** The input type as a string (e.g., "{ orderFormId: string; ... }") */
  inputType: string;
  /** The return type as a string (e.g., "OrderForm") */
  returnType: string;
  /** Whether to unwrap VtexFetchResult */
  unwrap: boolean;
  /** The body of the action call (e.g., "addItemsToCart(input.orderFormId, input.orderItems)") */
  callBody: string;
}

const project = new Project({ compilerOptions: { strict: true } });
const sourceFile = project.addSourceFileAtPath(invokeFile);

// Collect all imports to know which functions come from where
const importMap = new Map<string, { source: string; importedName: string }>();
for (const imp of sourceFile.getImportDeclarations()) {
  const source = imp.getModuleSpecifierValue();
  for (const named of imp.getNamedImports()) {
    const localName = named.getName();
    const importedName = named.getAliasNode()?.getText() || localName;
    importMap.set(localName, {
      source: source.startsWith("./") ? `@decocms/apps/vtex/${source.slice(2)}` : source,
      importedName: localName,
    });
  }
}

// Collect type imports
const typeImportMap = new Map<string, { source: string; importedName: string }>();
for (const imp of sourceFile.getImportDeclarations()) {
  if (!imp.isTypeOnly()) {
    for (const named of imp.getNamedImports()) {
      if (named.isTypeOnly()) {
        const localName = named.getName();
        const source = imp.getModuleSpecifierValue();
        typeImportMap.set(localName, {
          source: source.startsWith("./") ? `@decocms/apps/vtex/${source.slice(2)}` : source,
          importedName: localName,
        });
      }
    }
  }
  if (imp.isTypeOnly()) {
    const source = imp.getModuleSpecifierValue();
    for (const named of imp.getNamedImports()) {
      const localName = named.getName();
      typeImportMap.set(localName, {
        source: source.startsWith("./") ? `@decocms/apps/vtex/${source.slice(2)}` : source,
        importedName: localName,
      });
    }
  }
}

// Find the invoke const and extract actions
const invokeVar = sourceFile.getVariableDeclaration("invoke");
if (!invokeVar) {
  console.error("Could not find 'export const invoke' in invoke.ts");
  process.exit(1);
}

const actions: ActionDef[] = [];
const invokeInit = invokeVar.getInitializer();
if (!invokeInit) {
  console.error("invoke variable has no initializer");
  process.exit(1);
}

// Navigate: invoke → .vtex → .actions → each property
const vtexProp = invokeInit
  .asKindOrThrow(SyntaxKind.AsExpression)
  .getExpression()
  .asKindOrThrow(SyntaxKind.ObjectLiteralExpression)
  .getProperty("vtex");

if (!vtexProp) {
  console.error("Could not find 'vtex' property in invoke object");
  process.exit(1);
}

const vtexObj = (vtexProp as PropertyAssignment)
  .getInitializer()!
  .asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

const actionsProp = vtexObj.getProperty("actions");
if (!actionsProp) {
  console.error("Could not find 'actions' property in vtex object");
  process.exit(1);
}

const actionsObj = (actionsProp as PropertyAssignment)
  .getInitializer()!
  .asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

for (const prop of actionsObj.getProperties()) {
  if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
  const pa = prop as PropertyAssignment;
  const name = pa.getName();
  const initText = pa.getInitializer()!.getText();

  // Check if it uses createInvokeFn with unwrap
  const unwrap = initText.includes("unwrap: true");

  // Extract the arrow function body from createInvokeFn((input: ...) => ...)
  // We'll parse the call expression to get the action call
  const callExpr = pa.getInitializer()!;
  let inputType = "any";
  let callBody = "";

  // Recursively unwrap AsExpression chains (e.g. `expr as unknown as Type`)
  let createInvokeFnCall = callExpr;
  while (createInvokeFnCall.getKind() === SyntaxKind.AsExpression) {
    createInvokeFnCall = createInvokeFnCall.asKindOrThrow(SyntaxKind.AsExpression).getExpression();
  }

  // Now we have createInvokeFn(...) call
  if (createInvokeFnCall.getKind() === SyntaxKind.CallExpression) {
    const callArgs = createInvokeFnCall.asKindOrThrow(SyntaxKind.CallExpression).getArguments();
    if (callArgs.length >= 1) {
      const arrowFn = callArgs[0];
      if (arrowFn.getKind() === SyntaxKind.ArrowFunction) {
        const arrow = arrowFn.asKindOrThrow(SyntaxKind.ArrowFunction);
        const params = arrow.getParameters();
        if (params.length >= 1) {
          const paramType = params[0].getTypeNode()?.getText() || "any";
          inputType = paramType;
        }
        // Get the body (the actual action call)
        const body = arrow.getBody();
        callBody = body.getText();

        // If body is a block, extract the expression
        if (callBody.startsWith("{")) {
          // It's a block body — skip for now, use simplified version
          callBody = "";
        }
      }
    }
  }

  // Determine which function is being called
  let importedFn = "";
  let importSource = "";
  for (const [fnName, info] of importMap.entries()) {
    if (callBody.includes(`${fnName}(`)) {
      importedFn = fnName;
      importSource = info.source;
      break;
    }
  }

  // Extract the return type from the outermost "as" assertion.
  // For `expr as unknown as (ctx: ...) => Promise<T>`, the outermost
  // AsExpression has the function type with Promise<T>.
  let returnType = "any";
  if (callExpr.getKind() === SyntaxKind.AsExpression) {
    const asExpr = callExpr.asKindOrThrow(SyntaxKind.AsExpression);
    const typeText = asExpr.getTypeNode()?.getText() || "";
    if (typeText !== "unknown") {
      const promiseMatch = typeText.match(/Promise<(.+)>$/s);
      if (promiseMatch) {
        returnType = promiseMatch[1].trim();
      }
    }
  }

  actions.push({
    name,
    importSource,
    importedFn,
    inputType,
    returnType,
    unwrap,
    callBody,
  });
}

// ---------------------------------------------------------------------------
// Generate the output file
// ---------------------------------------------------------------------------

// Collect unique imports needed
const fnImports = new Map<string, Set<string>>();
const typeImports = new Map<string, Set<string>>();

for (const action of actions) {
  if (action.importSource && action.importedFn) {
    if (!fnImports.has(action.importSource)) {
      fnImports.set(action.importSource, new Set());
    }
    fnImports.get(action.importSource)!.add(action.importedFn);
  }
}

// Add type imports referenced in inputType or returnType
for (const action of actions) {
  const allText = action.inputType + action.returnType + action.callBody;
  for (const [typeName, info] of typeImportMap.entries()) {
    if (allText.includes(typeName)) {
      if (!typeImports.has(info.source)) {
        typeImports.set(info.source, new Set());
      }
      typeImports.get(info.source)!.add(typeName);
    }
  }
  // Also check value imports that appear in the types (like SimulationItem)
  for (const [fnName, info] of importMap.entries()) {
    if (action.inputType.includes(fnName) && !fnImports.get(info.source)?.has(fnName)) {
      if (!typeImports.has(info.source)) {
        typeImports.set(info.source, new Set());
      }
      typeImports.get(info.source)!.add(fnName);
    }
  }
}

// Count how many actually parsed vs. stubbed
const parsed = actions.filter((a) => a.callBody && a.importedFn).length;
const stubbed = actions.length - parsed;
if (stubbed > 0) {
  console.warn(`⚠ ${stubbed} action(s) could not be parsed — generated as stubs:`);
  for (const a of actions) {
    if (!a.callBody || !a.importedFn) console.warn(`  - ${a.name}`);
  }
}

// Build output
let out = `// Auto-generated by @decocms/start/scripts/generate-invoke.ts
// Do not edit manually. Re-run the generator to update.
//
// Each server function is a top-level const so TanStack Start's compiler
// can transform createServerFn().handler() into RPC stubs on the client.
//
// Site-specific extensions: import { vtexActions } from this file and merge
// with your own actions in a separate invoke.ts.
import { createServerFn } from "@tanstack/react-start";
`;

// Add function imports
for (const [source, fns] of fnImports) {
  out += `import { ${[...fns].join(", ")} } from "${source}";\n`;
}

// Add type imports
for (const [source, types] of typeImports) {
  // Don't duplicate if already imported as value
  const valueImports = fnImports.get(source);
  const onlyTypes = [...types].filter((t) => !valueImports?.has(t));
  if (onlyTypes.length > 0) {
    out += `import type { ${onlyTypes.join(", ")} } from "${source}";\n`;
  }
}

out += `
function unwrapResult<T>(result: unknown): T {
  if (result && typeof result === "object" && "data" in result) {
    return (result as { data: T }).data;
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Top-level server function declarations
// ---------------------------------------------------------------------------
`;

for (const action of actions) {
  const varName = `$${action.name}`;

  if (action.callBody && action.importedFn) {
    // Replace "input" references with "data" in the call body.
    // The handler receives `{ data }` destructured from the validated input.
    let body = action.callBody;
    body = body.replace(/\binput\./g, "data.");
    body = body.replace(/\binput\b(?!\.)/g, "data");

    if (action.unwrap) {
      out += `\nconst ${varName} = createServerFn({ method: "POST" })
  .inputValidator((data: ${action.inputType}) => data)
  .handler(async ({ data }): Promise<any> => {
    const result = await ${body};
    return unwrapResult(result);
  });\n`;
    } else {
      out += `\nconst ${varName} = createServerFn({ method: "POST" })
  .inputValidator((data: ${action.inputType}) => data)
  .handler(async ({ data }): Promise<any> => {
    return ${body};
  });\n`;
    }
  } else {
    // Fallback: couldn't parse — generate a stub
    out += `\n// TODO: could not auto-generate ${action.name} — add manually\nconst ${varName} = createServerFn({ method: "POST" })
  .handler(async () => {
    throw new Error("${action.name}: not implemented — regenerate invoke");
  });\n`;
  }
}

// Generate the vtexActions object (for composability with site-specific actions)
out += `
// ---------------------------------------------------------------------------
// Typed VTEX actions map — merge with site-specific actions in your invoke.ts
// ---------------------------------------------------------------------------

export const vtexActions = {
`;

for (const action of actions) {
  const varName = `$${action.name}`;
  if (action.returnType !== "any") {
    out += `  ${action.name}: ${varName} as unknown as (ctx: { data: ${action.inputType} }) => Promise<${action.returnType}>,\n`;
  } else {
    out += `  ${action.name}: ${varName},\n`;
  }
}

out += `} as const;

// Re-export OrderForm type (commonly imported from invoke by site components)
export type { OrderForm } from "@decocms/apps/vtex/types";

// ---------------------------------------------------------------------------
// Default invoke object — import this if you don't need site extensions
// ---------------------------------------------------------------------------

export const invoke = {
  vtex: {
    actions: vtexActions,
  },
} as const;
`;

// Write output
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out);
console.log(`Generated ${actions.length} server functions → ${path.relative(cwd, outFile)}`);
