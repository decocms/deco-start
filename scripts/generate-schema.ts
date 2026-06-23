#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
/**
 * Schema Generator for deco admin compatibility.
 *
 * Scans src/sections/, src/loaders/, and src/apps/ for TypeScript files, parses
 * their Props interfaces, and generates JSON Schema 7 definitions in the format
 * expected by the deco admin (/deco/meta endpoint).
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/start/scripts/generate-schema.ts [options]
 *
 * Options:
 *   --namespace   Section namespace  (default: "site")
 *   --site        Site name          (default: "storefront")
 *   --version     Framework version  (default: "1.0.0")
 *   --sections    Sections directory (default: "src/sections")
 *   --loaders     Loaders directory  (default: "src/loaders")
 *   --apps        Apps directory     (default: "src/apps")
 *   --skip-apps   Skip app schema generation
 *   --out         Output file        (default: "src/server/admin/meta.gen.json")
 *   --platform    Platform name      (default: "cloudflare")
 */
import {
  type Symbol as MorphSymbol,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type Type,
} from "ts-morph";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const idx = argv.indexOf(`--${name}`);
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : fallback;
}

const SITE_NAMESPACE = arg("namespace", "site");
const SITE_NAME = arg("site", "storefront");
const FRAMEWORK_VERSION = arg("version", "1.0.0");
const SECTIONS_REL = arg("sections", "src/sections");
const LOADERS_REL = arg("loaders", "src/loaders");
const APPS_REL = arg("apps", "src/apps");
const SKIP_APPS = argv.includes("--skip-apps");
const OUT_REL = arg("out", "src/server/admin/meta.gen.json");
const PLATFORM = arg("platform", "cloudflare");

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------
interface MetaResponse {
  major: number;
  version: string;
  namespace: string;
  site: string;
  manifest: { blocks: Record<string, Record<string, any>> };
  schema: { definitions: Record<string, any>; root: Record<string, any> };
  platform: string;
  cloudProvider: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toBase64(str: string): string {
  return Buffer.from(str).toString("base64");
}

/**
 * Map JSDoc tags to JSON Schema 7 keywords.
 * Supports all 20+ tags from deco-cx/deco.
 */
/**
 * Tags that receive special type coercion (not just string passthrough).
 * Matches the original deco-cx/deco parseJSDocAttribute behaviour.
 */
const NUMERIC_TAGS = new Set([
  "maximum",
  "minimum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "multipleOf",
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "maxProperties",
  "minProperties",
]);
const BOOLEAN_TAGS = new Set(["readOnly", "writeOnly", "deprecated", "uniqueItems", "ignore"]);

function applyJsDocToSchema(schema: any, tags: Record<string, string>): void {
  for (const [tag, value] of Object.entries(tags)) {
    if (tag === "ignore") continue;

    // Tags with special coercion
    if (tag === "hide") {
      schema.hide = "true";
      continue;
    }

    if (tag === "default") {
      if (value === "true") schema.default = true;
      else if (value === "false") schema.default = false;
      else if (value === "null") schema.default = null;
      else if (!isNaN(Number(value)) && value.trim() !== "") schema.default = Number(value);
      else {
        try {
          schema.default = JSON.parse(value);
        } catch {
          schema.default = value;
        }
      }
      continue;
    }

    if (tag === "examples") {
      const lines = value
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      schema.examples =
        lines.length > 1
          ? lines
          : (() => {
              try {
                return JSON.parse(value);
              } catch {
                return [value];
              }
            })();
      continue;
    }

    if (NUMERIC_TAGS.has(tag)) {
      schema[tag] = Number(value);
      continue;
    }
    if (BOOLEAN_TAGS.has(tag)) {
      schema[tag] = value === "true";
      continue;
    }

    // Everything else: pass through as-is (matching original deco behaviour)
    // Covers: title, description, format, widget, icon, titleBy, mode,
    // hideOption, label, options, pattern, section, group, placeholder, etc.
    schema[tag] = value;
  }
}

const WIDGET_TYPE_FORMATS: Record<string, string> = {
  ImageWidget: "image-uri",
  VideoWidget: "video-uri",
  HTMLWidget: "html",
  RichText: "rich-text",
  Color: "color",
  Secret: "password",
  TextArea: "textarea",
  Code: "code",
  DateTimeWidget: "date-time",
};

/**
 * Detect known widget types and set the appropriate format.
 */
function applyWidgetDetection(schema: any, typeText: string): void {
  if (schema.format) return;

  for (const [widgetType, format] of Object.entries(WIDGET_TYPE_FORMATS)) {
    if (typeText === widgetType || typeText.includes(widgetType)) {
      schema.format = format;
      return;
    }
  }
}

/**
 * Smart widget format application that handles arrays, nullable types,
 * and union types by applying the format to the correct inner schema.
 */
function applyWidgetFormat(schema: any, typeHint: string): void {
  const matchedFormat = Object.entries(WIDGET_TYPE_FORMATS).find(
    ([wt]) => typeHint === wt || typeHint.includes(wt),
  )?.[1];

  if (!matchedFormat) {
    applyWidgetDetection(schema, typeHint);
    return;
  }

  if (schema.type === "string" && !schema.format) {
    schema.format = matchedFormat;
  } else if (schema.type === "array" && schema.items) {
    if (schema.items.type === "string" && !schema.items.format) {
      schema.items.format = matchedFormat;
    }
  } else if (schema.anyOf) {
    for (const variant of schema.anyOf) {
      if (variant.type === "string" && !variant.format) {
        variant.format = matchedFormat;
      }
    }
  }
}

// Well-known definition key for Section type references resolved by composeMeta
const SECTION_REF_DEF_KEY = "__SECTION_REF__";
// Well-known definition key for Resolvable (saved blocks picker)
const RESOLVABLE_KEY = "Resolvable";

// Only truly React-internal props that are never user-defined.
// Do NOT include "children", "type", "props", or "key" — those are commonly
// used as legitimate property names in data interfaces (e.g. SelectedFacet
// uses { key: string; value: string }).
// Note: React's JSX `key` is a special attribute, not a TypeScript interface
// property — it never appears in Props/data interfaces and must not be filtered.
const REACT_INTERNAL_PROPS = new Set([
  "ref",
  "then",
  "catch",
  "finally",
  "$$typeof",
  "_owner",
  "_store",
]);

interface GenerationContext {
  outputTypeToLoaderKeys: Map<string, string[]>;
}

/**
 * Extract the return type name of a loader's default export.
 * Unwraps Promise<T> and T | null wrappers.
 */
function extractLoaderOutputTypeName(sourceFile: SourceFile): string | null {
  const sym = sourceFile.getDefaultExportSymbol();
  if (!sym) return null;
  const callSigs = sym.getTypeAtLocation(sourceFile).getCallSignatures();
  if (!callSigs.length) return null;
  let ret = callSigs[0].getReturnType();
  if (ret.getSymbol()?.getName() === "Promise") {
    const args = ret.getTypeArguments();
    if (args.length) ret = args[0];
  }
  if (ret.isUnion()) {
    const nonNull = ret.getUnionTypes().filter((t) => !t.isNull() && !t.isUndefined());
    if (nonNull.length === 1) ret = nonNull[0];
  }
  // Unwrap array element type — Product[] → "Product[]" (keyed as array)
  if (ret.isArray()) {
    const elType = ret.getArrayElementType();
    if (elType) {
      const elName = elType.getSymbol()?.getName() ?? elType.getAliasSymbol()?.getName() ?? null;
      if (elName) return `${elName}[]`;
    }
  }
  return ret.getSymbol()?.getName() ?? ret.getAliasSymbol()?.getName() ?? null;
}

function typeToJsonSchema(type: Type, visited = new Set<string>(), ctx?: GenerationContext): any {
  const typeText = type.getText();
  if (visited.has(typeText)) return { type: "object" };
  visited.add(typeText);

  try {
    // any / unknown → accept anything
    if (type.isAny() || type.isUnknown()) return {};

    // ReactNode, JSX.Element, VNode → hide from form
    if (
      /\bReactNode\b|\bJSX\.Element\b|\bReactElement\b|\bVNode\b|\bComponentChildren\b/.test(
        typeText,
      )
    ) {
      return { type: "object", hide: "true" };
    }

    if (type.isString() || type.isStringLiteral()) {
      return type.isStringLiteral()
        ? { type: "string", const: type.getLiteralValue() }
        : { type: "string" };
    }
    if (type.isNumber() || type.isNumberLiteral()) return { type: "number" };
    if (type.isBoolean() || type.isBooleanLiteral()) return { type: "boolean" };
    if (type.isNull() || type.isUndefined()) return { type: "null" };

    if (type.isArray()) {
      const el = type.getArrayElementType();
      return el
        ? { type: "array", items: typeToJsonSchema(el, new Set(visited), ctx) }
        : { type: "array" };
    }

    if (type.isUnion()) {
      const parts = type.getUnionTypes();
      const nonNull = parts.filter((t) => !t.isNull() && !t.isUndefined());
      const isNullable = nonNull.length < parts.length;

      if (nonNull.length === 1) {
        const inner = typeToJsonSchema(nonNull[0], new Set(visited), ctx);
        return isNullable ? { ...inner, nullable: true } : inner;
      }

      // boolean? → true | false | undefined → collapse to { type: "boolean" }
      if (nonNull.every((t) => t.isBooleanLiteral())) {
        const result: any = { type: "boolean" };
        if (isNullable) result.nullable = true;
        return result;
      }

      if (nonNull.every((t) => t.isStringLiteral())) {
        const result: any = { type: "string", enum: nonNull.map((t) => t.getLiteralValue()) };
        if (isNullable) result.nullable = true;
        return result;
      }

      // 1 | 2 | 3 → { type: "number", enum: [1, 2, 3] }
      if (nonNull.every((t) => t.isNumberLiteral())) {
        const result: any = { type: "number", enum: nonNull.map((t) => t.getLiteralValue()) };
        if (isNullable) result.nullable = true;
        return result;
      }

      // General anyOf — try to add title to each variant for discriminated unions
      const anyOf = nonNull.map((t) => {
        const schema = typeToJsonSchema(t, new Set(visited), ctx);
        if (!schema.title && schema.type === "object") {
          const sym = t.getAliasSymbol() ?? t.getSymbol();
          const symName = sym?.getName();
          if (symName && symName !== "__type" && symName !== "default") {
            schema.title = symName;
          }
          // Fallback: use a const discriminator field value as title
          if (!schema.title && schema.properties) {
            for (const v of Object.values(schema.properties) as any[]) {
              if (v?.const !== undefined) {
                schema.title = String(v.const);
                break;
              }
            }
          }
        }
        return schema;
      });

      const result: any = { anyOf };
      if (isNullable) result.nullable = true;
      return result;
    }

    if (type.isObject() || type.isInterface()) {
      // Record<K,V> → { type: "object", additionalProperties: V-schema }
      const stringIdx = type.getStringIndexType();
      const numberIdx = type.getNumberIndexType();
      if ((stringIdx || numberIdx) && type.getProperties().length === 0) {
        const valType = (stringIdx || numberIdx)!;
        return {
          type: "object",
          additionalProperties: typeToJsonSchema(valType, new Set(visited)),
        };
      }

      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const prop of type.getProperties()) {
        const name = prop.getName();
        if (name.startsWith("_") || name.startsWith("$") || name === "@type") continue;
        if (REACT_INTERNAL_PROPS.has(name)) continue;

        // getValueDeclaration() returns undefined for computed/mapped-type
        // properties (e.g. `Omit<Props, "isMobile">`). Fall back to the first
        // available declaration, or skip if none exists at all.
        const decl = prop.getValueDeclaration() ?? prop.getDeclarations()[0];
        if (!decl) continue;
        const propType = prop.getTypeAtLocation(decl);

        const tags = getJsDocTags(prop);
        if (tags.ignore) continue;

        // Get AST type-annotation text before resolving
        let typeHint = propType.getText();
        const typeNode =
          decl.getChildrenOfKind?.(SyntaxKind.TypeReference)?.[0] ??
          decl.getChildAtIndex?.(decl.getChildCount?.() - 1);
        if (typeNode && Node.isTypeReference(typeNode)) {
          typeHint = typeNode.getText();
        } else if (Node.isPropertySignature(decl) || Node.isPropertyDeclaration(decl)) {
          const tn = (decl as any).getTypeNode?.();
          if (tn) typeHint = tn.getText();
        }

        // Section type → section picker reference (resolved by composeMeta)
        const baseHint = typeHint.replace(/\s*\|\s*(null|undefined)/g, "").trim();
        if (baseHint === "Section" || baseHint === "Section[]" || baseHint === "Section[] | null") {
          const isArray = baseHint.includes("[]");
          const sectionSchema: any = isArray
            ? {
                type: "array",
                items: { $ref: `#/definitions/${SECTION_REF_DEF_KEY}` },
                title: name.charAt(0).toUpperCase() + name.slice(1),
              }
            : {
                $ref: `#/definitions/${SECTION_REF_DEF_KEY}`,
                title: name.charAt(0).toUpperCase() + name.slice(1),
              };
          if (prop.isOptional() || typeHint.includes("null") || typeHint.includes("undefined")) {
            sectionSchema.nullable = true;
          }
          applyJsDocToSchema(sectionSchema, tags);
          properties[name] = sectionSchema;
          if (!prop.isOptional()) required.push(name);
          continue;
        }

        // Loader output type → block-ref: emit anyOf [Resolvable, ...matchingLoaders]
        // baseHint strips "| null | undefined" so "ProductListingPage | null" → "ProductListingPage"
        if (ctx?.outputTypeToLoaderKeys) {
          const typeSym = propType.getSymbol() ?? propType.getAliasSymbol();
          const outputTypeName = typeSym?.getName() ?? baseHint;
          let matchingLoaders =
            ctx.outputTypeToLoaderKeys.get(outputTypeName) ??
            (outputTypeName !== baseHint ? ctx.outputTypeToLoaderKeys.get(baseHint) : undefined);
          // If no match yet and the prop type is an array, try element type name + "[]"
          if (!matchingLoaders?.length) {
            let arrayElementType = propType.isArray() ? propType.getArrayElementType() : null;
            if (!arrayElementType && propType.isUnion()) {
              const nonNull = propType.getUnionTypes().filter((t) => !t.isNull() && !t.isUndefined());
              if (nonNull.length === 1 && nonNull[0].isArray()) {
                arrayElementType = nonNull[0].getArrayElementType();
              }
            }
            if (arrayElementType) {
              const elName = arrayElementType.getSymbol()?.getName() ?? arrayElementType.getAliasSymbol()?.getName();
              if (elName) {
                matchingLoaders = ctx.outputTypeToLoaderKeys.get(`${elName}[]`);
              }
            }
          }
          if (matchingLoaders?.length) {
            const blockRefSchema: any = {
              anyOf: [
                { $ref: `#/definitions/${RESOLVABLE_KEY}` },
                ...matchingLoaders.map((k) => ({ $ref: `#/definitions/${toBase64(k)}` })),
              ],
              title: name.charAt(0).toUpperCase() + name.slice(1),
            };
            if (prop.isOptional() || typeHint.includes("null") || typeHint.includes("undefined")) {
              blockRefSchema.nullable = true;
            }
            applyJsDocToSchema(blockRefSchema, tags);
            properties[name] = blockRefSchema;
            if (!prop.isOptional()) required.push(name);
            continue;
          }
        }

        const schema = typeToJsonSchema(propType, new Set(visited), ctx);

        applyJsDocToSchema(schema, tags);
        applyWidgetFormat(schema, typeHint);
        if (typeHint.includes("Secret")) {
          schema.type = schema.type ?? "string";
          schema.format = "password";
        }

        if (!schema.title) schema.title = name.charAt(0).toUpperCase() + name.slice(1);

        properties[name] = schema;
        if (!prop.isOptional()) required.push(name);
      }

      const result: any = { type: "object", properties };
      if (required.length > 0) result.required = required;

      const ifaceSym = type.getAliasSymbol() ?? type.getSymbol();
      if (ifaceSym) {
        const ifaceTags = getJsDocTags(ifaceSym);
        applyJsDocToSchema(result, ifaceTags);
      }

      return result;
    }

    return { type: "string" };
  } finally {
    visited.delete(typeText);
  }
}

function getJsDocTags(symbol: MorphSymbol): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const decl of symbol.getDeclarations()) {
    const jsDocs = Node.isJSDocable(decl) ? decl.getJsDocs() : [];
    for (const doc of jsDocs) {
      const desc = doc.getDescription().trim();
      if (desc) tags.description = desc;
      for (const tag of doc.getTags()) {
        tags[tag.getTagName()] = tag.getCommentText()?.trim() || "true";
      }
    }
  }
  return tags;
}

/**
 * Extract the first parameter's type from a component's default export
 * using the type checker. Works regardless of whether the export is a
 * function declaration, arrow function, const assignment, or re-export.
 */
function extractDefaultExportPropsType(sourceFile: import("ts-morph").SourceFile): Type | null {
  const symbol = sourceFile.getDefaultExportSymbol();
  if (!symbol) return null;

  const exportType = symbol.getTypeAtLocation(sourceFile);
  const callSigs = exportType.getCallSignatures();
  if (callSigs.length === 0) return null;

  const params = callSigs[0].getParameters();
  if (params.length === 0) return null;

  const paramType = params[0].getTypeAtLocation(sourceFile);
  if (paramType.isAny() || paramType.getText() === "{}") return null;

  return paramType;
}

/**
 * Extract the first parameter type of an exported `loader` function.
 * When a section file co-exports a loader, the loader's input type defines
 * the CMS schema (what the user configures), NOT the component's Props.
 */
function extractLoaderInputType(sourceFile: import("ts-morph").SourceFile): Type | null {
  // Check for `export const loader = ...` or `export function loader(...)`
  for (const sym of sourceFile.getExportSymbols()) {
    if (sym.getName() !== "loader") continue;

    const decls = sym.getDeclarations();
    for (const decl of decls) {
      let loaderType: Type | null = null;

      if (Node.isVariableDeclaration(decl)) {
        loaderType = decl.getType();
      } else if (Node.isFunctionDeclaration(decl)) {
        loaderType = decl.getType();
      } else if (Node.isExportSpecifier(decl)) {
        // Re-exported: `export { loader } from "..."`
        loaderType = decl.getType();
      }

      if (!loaderType) continue;

      const callSigs = loaderType.getCallSignatures();
      if (callSigs.length === 0) continue;

      const params = callSigs[0].getParameters();
      if (params.length === 0) continue;

      const paramType = params[0].getTypeAtLocation(sourceFile);
      if (paramType.isAny() || paramType.getText() === "{}") continue;

      return paramType;
    }
  }
  return null;
}

/**
 * Resolve a module specifier to an absolute file path.
 */
function resolveModulePath(
  moduleSpec: string,
  fromFile: string,
  projectRoot: string,
): string | null {
  let target = moduleSpec;
  if (target.startsWith("~/")) {
    target = path.resolve(projectRoot, "src", target.slice(2));
  } else if (target.startsWith("./") || target.startsWith("../")) {
    target = path.resolve(path.dirname(fromFile), target);
  }
  if (!target.match(/\.(tsx?|jsx?)$/)) {
    for (const ext of [".tsx", ".ts", ".jsx", ".js"]) {
      if (fs.existsSync(target + ext)) return target + ext;
    }
    if (fs.existsSync(path.join(target, "index.tsx"))) return path.join(target, "index.tsx");
    if (fs.existsSync(path.join(target, "index.ts"))) return path.join(target, "index.ts");
  }
  return fs.existsSync(target) ? target : null;
}

type SourceFileCache = Map<string, SourceFile>;
type ModuleResolutionCache = Map<string, string | null>;
type PropsSchemaCache = Map<string, any>;

function getSourceFile(
  project: import("ts-morph").Project,
  filePath: string,
  cache: SourceFileCache,
): SourceFile {
  const normalizedPath = path.resolve(filePath);
  const cached = cache.get(normalizedPath);
  if (cached) return cached;

  const sourceFile =
    project.getSourceFile(normalizedPath) ?? project.addSourceFileAtPath(normalizedPath);
  cache.set(normalizedPath, sourceFile);
  return sourceFile;
}

function resolveModulePathCached(
  moduleSpec: string,
  fromFile: string,
  projectRoot: string,
  cache: ModuleResolutionCache,
): string | null {
  const key = `${fromFile}\0${moduleSpec}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const resolved = resolveModulePath(moduleSpec, fromFile, projectRoot);
  cache.set(key, resolved);
  return resolved;
}

/**
 * Recursively follow `export { default } from "..."` chains (up to maxDepth hops)
 * and try to extract Props from each target file.
 */
function resolvePropsViaReExport(
  project: import("ts-morph").Project,
  sourceFile: import("ts-morph").SourceFile,
  filePath: string,
  projectRoot: string,
  maxDepth: number,
  sourceFileCache: SourceFileCache,
  moduleResolutionCache: ModuleResolutionCache,
  propsSchemaCache: PropsSchemaCache,
  ctx?: GenerationContext,
): any | null {
  if (maxDepth <= 0) return null;

  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const moduleSpec = exportDecl.getModuleSpecifierValue();
    if (!moduleSpec) continue;
    const hasDefault = exportDecl.getNamedExports().some((n) => {
      const name = n.getName();
      const alias = n.getAliasNode()?.getText();
      return name === "default" || alias === "default";
    });
    if (!hasDefault) continue;

    const targetPath = resolveModulePathCached(
      moduleSpec,
      filePath,
      projectRoot,
      moduleResolutionCache,
    );
    if (!targetPath) continue;

    const cachedProps = propsSchemaCache.get(targetPath);
    if (cachedProps) return cachedProps;

    try {
      const targetFile = getSourceFile(project, targetPath, sourceFileCache);

      // When the target file exports a loader, the loader's first parameter
      // type defines the CMS input schema. This takes priority over a named
      // Props interface, which may be a sub-type used internally.
      const loaderInputType = extractLoaderInputType(targetFile);
      if (loaderInputType) {
        const schema = typeToJsonSchema(loaderInputType, undefined, ctx);
        propsSchemaCache.set(targetPath, schema);
        return schema;
      }

      const targetProps = targetFile.getInterface("Props");
      if (targetProps) {
        const schema = typeToJsonSchema(targetProps.getType(), undefined, ctx);
        propsSchemaCache.set(targetPath, schema);
        return schema;
      }

      const targetAlias = targetFile.getTypeAlias("Props");
      if (targetAlias) {
        const schema = typeToJsonSchema(targetAlias.getType(), undefined, ctx);
        propsSchemaCache.set(targetPath, schema);
        return schema;
      }

      // Type-checker approach: extract from default export call signature
      const propsType = extractDefaultExportPropsType(targetFile);
      if (propsType) {
        const schema = typeToJsonSchema(propsType, undefined, ctx);
        propsSchemaCache.set(targetPath, schema);
        return schema;
      }

      // Recurse: target might also re-export from another file
      const deeper = resolvePropsViaReExport(
        project,
        targetFile,
        targetPath,
        projectRoot,
        maxDepth - 1,
        sourceFileCache,
        moduleResolutionCache,
        propsSchemaCache,
        ctx,
      );
      if (deeper) {
        propsSchemaCache.set(targetPath, deeper);
        return deeper;
      }
    } catch {
      // Target file couldn't be parsed
    }
  }
  return null;
}

function findTsxFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findTsxFiles(full));
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) results.push(full);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function generateMeta(): MetaResponse {
  const root = process.cwd();
  const sectionsDir = path.resolve(root, SECTIONS_REL);
  const loadersDir = path.resolve(root, LOADERS_REL);
  const srcDir = path.join(root, "src");

  const project = new Project({
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });

  const definitions: Record<string, any> = {};
  const sectionBlocks: Record<string, any> = {};
  const loaderBlocks: Record<string, any> = {};
  const sectionRootAnyOf: any[] = [];
  const loaderRootAnyOf: any[] = [{ $ref: `#/definitions/${RESOLVABLE_KEY}` }];
  const outputTypeToLoaderKeys = new Map<string, string[]>();
  const sourceFileCache: SourceFileCache = new Map();
  const moduleResolutionCache: ModuleResolutionCache = new Map();
  const propsSchemaCache: PropsSchemaCache = new Map();

  // Resolvable: the admin's deRefUntil expects the LITERAL key "Resolvable",
  // not a base64-encoded version. We store both for compatibility.
  const resolvableB64Key = toBase64("Resolvable");
  const resolvableDef = {
    title: "Select from saved",
    type: "object",
    required: ["__resolveType"],
    additionalProperties: true,
    properties: { __resolveType: { type: "string" } },
  };
  definitions[RESOLVABLE_KEY] = resolvableDef;
  definitions[resolvableB64Key] = resolvableDef;
  sectionRootAnyOf.push({ $ref: `#/definitions/${RESOLVABLE_KEY}` });

  // ---------------------------------------------------------------------------
  // First pass: scan loaders — build input schemas + outputTypeToLoaderKeys map
  // ---------------------------------------------------------------------------
  const loaderFiles = fs.existsSync(loadersDir) ? findTsxFiles(loadersDir) : [];
  console.log(`Found ${loaderFiles.length} loader files`);
  for (const filePath of loaderFiles) {
    getSourceFile(project, filePath, sourceFileCache);
  }

  for (const filePath of loaderFiles) {
    const relativePath = path.relative(srcDir, filePath).replaceAll("\\", "/");
    const loaderKey = `${SITE_NAMESPACE}/${relativePath}`;

    try {
      const sourceFile = getSourceFile(project, filePath, sourceFileCache);

      // Extract Props (input schema)
      let propsSchema: any = null;
      const propsInterface = sourceFile.getInterface("Props");
      if (propsInterface) propsSchema = typeToJsonSchema(propsInterface.getType());

      const propsTypeAlias = sourceFile.getTypeAlias("Props");
      if (!propsSchema && propsTypeAlias) propsSchema = typeToJsonSchema(propsTypeAlias.getType());

      if (!propsSchema) {
        const localPropsType = extractDefaultExportPropsType(sourceFile);
        if (localPropsType) propsSchema = typeToJsonSchema(localPropsType);
      }

      if (!propsSchema) propsSchema = { type: "object", properties: {} };

      // Register flat loader definition (Bug #2: spread props, not nested under "props:")
      const loaderDefKey = toBase64(loaderKey);
      definitions[loaderDefKey] = {
        title: loaderKey,
        type: "object",
        required: ["__resolveType", ...(propsSchema?.required || [])],
        properties: {
          __resolveType: { type: "string", enum: [loaderKey], default: loaderKey },
          ...(propsSchema?.properties || {}),
        },
      };

      loaderBlocks[loaderKey] = {
        $ref: `#/definitions/${loaderDefKey}`,
        namespace: SITE_NAMESPACE,
      };
      loaderRootAnyOf.push({ $ref: `#/definitions/${loaderDefKey}` });

      // Extract return type name for block-ref detection in sections (Bug #3)
      const outputTypeName = extractLoaderOutputTypeName(sourceFile);
      if (outputTypeName) {
        const existing = outputTypeToLoaderKeys.get(outputTypeName) ?? [];
        existing.push(loaderKey);
        outputTypeToLoaderKeys.set(outputTypeName, existing);
      }

      const propCount = Object.keys(propsSchema.properties || {}).length;
      console.log(
        `  ✓ loader ${loaderKey} (${propCount} props${outputTypeName ? ` → ${outputTypeName}` : ""})`,
      );
    } catch (e) {
      console.warn(`  ✗ loader ${loaderKey}: ${(e as Error).message}`);
    }
  }

  const ctx: GenerationContext = { outputTypeToLoaderKeys };

  // ---------------------------------------------------------------------------
  // Commerce "extension wrapper" loaders (deco-cx parity).
  //
  // deco-cx/apps ships `commerce/loaders/product/extensions/{listingPage,detailsPage}.ts`
  // which wrap a base loader: `{ data: <PLP/PDP loader>, extensions: ExtensionOf<T>[] }`.
  // These wrappers live in @decocms/apps (node_modules), so they are never scanned
  // from `src/loaders/` — without emitting their schema the admin renders an empty
  // config for any page whose `page` prop uses the wrapper. We emit them here using
  // the output-type → loader map so `data` becomes a picker of the site's matching
  // loaders (e.g. DeliveryPromiseProductListingPage), exactly like the old admin
  // ("Extend your product" → "Data" → "The data Extensions").
  const COMMERCE_EXTENSION_WRAPPERS = [
    {
      key: "commerce/loaders/product/extensions/listingPage.ts",
      outputType: "ProductListingPage",
    },
    {
      key: "commerce/loaders/product/extensions/detailsPage.ts",
      outputType: "ProductDetailsPage",
    },
  ];
  for (const wrapper of COMMERCE_EXTENSION_WRAPPERS) {
    const matchingLoaders = outputTypeToLoaderKeys.get(wrapper.outputType) ?? [];
    const wrapperDefKey = toBase64(wrapper.key);
    definitions[wrapperDefKey] = {
      title: wrapper.key,
      type: "object",
      required: ["__resolveType"],
      properties: {
        __resolveType: { type: "string", enum: [wrapper.key], default: wrapper.key },
        data: {
          title: "Data",
          description: "Here comes your products or anything that can be extensible.",
          anyOf: [
            { $ref: `#/definitions/${RESOLVABLE_KEY}` },
            ...matchingLoaders.map((k) => ({ $ref: `#/definitions/${toBase64(k)}` })),
          ],
        },
        extensions: {
          type: "array",
          title: "The data Extensions",
          items: { anyOf: [{ $ref: `#/definitions/${RESOLVABLE_KEY}` }] },
        },
      },
    };
    loaderBlocks[wrapper.key] = {
      $ref: `#/definitions/${wrapperDefKey}`,
      namespace: "commerce",
    };
    loaderRootAnyOf.push({ $ref: `#/definitions/${wrapperDefKey}` });
    console.log(
      `  ✓ commerce extension wrapper ${wrapper.key} (data → ${matchingLoaders.length} loader(s))`,
    );
  }

  // ---------------------------------------------------------------------------
  // Second pass: scan sections
  // ---------------------------------------------------------------------------

  if (!fs.existsSync(sectionsDir)) {
    console.error(`Sections directory not found: ${sectionsDir}`);
    process.exit(1);
  }

  const sectionFiles = findTsxFiles(sectionsDir);
  console.log(`Found ${sectionFiles.length} section files`);
  for (const filePath of sectionFiles) {
    getSourceFile(project, filePath, sourceFileCache);
  }

  for (const filePath of sectionFiles) {
    const relativePath = path.relative(srcDir, filePath).replaceAll("\\", "/");
    const blockKey = `${SITE_NAMESPACE}/${relativePath}`;

    try {
      const sourceFile = getSourceFile(project, filePath, sourceFileCache);

      let propsSchema: any = null;

      // Strategy 0: If the section file exports a loader (directly or via
      // re-export), the loader's first parameter type defines the CMS input.
      // This takes priority over a named Props interface which may be a
      // sub-type used internally by the component.
      const loaderInputType = extractLoaderInputType(sourceFile);
      if (loaderInputType) {
        propsSchema = typeToJsonSchema(loaderInputType, undefined, ctx);
      }

      // Strategy 1: Local Props interface/type alias in the section file
      const propsInterface = sourceFile.getInterface("Props");
      if (!propsSchema && propsInterface) propsSchema = typeToJsonSchema(propsInterface.getType(), undefined, ctx);

      const propsTypeAlias = sourceFile.getTypeAlias("Props");
      if (!propsSchema && propsTypeAlias)
        propsSchema = typeToJsonSchema(propsTypeAlias.getType(), undefined, ctx);

      // Strategy 2: Follow re-exports recursively (up to 3 hops)
      // Handles: section → island → component chains
      if (!propsSchema) {
        propsSchema = resolvePropsViaReExport(
          project,
          sourceFile,
          filePath,
          root,
          3,
          sourceFileCache,
          moduleResolutionCache,
          propsSchemaCache,
          ctx,
        );
      }

      // Strategy 4: Default export call signature in the section file via type checker
      if (!propsSchema) {
        const localPropsType = extractDefaultExportPropsType(sourceFile);
        if (localPropsType) {
          propsSchema = typeToJsonSchema(localPropsType, undefined, ctx);
        }
      }

      if (!propsSchema) propsSchema = { type: "object", properties: {} };

      const propCount = Object.keys(propsSchema.properties || {}).length;

      const propsDefKey = toBase64(`file:///${filePath.replaceAll("\\", "/")}`) + "@Props";
      definitions[propsDefKey] = propsSchema;

      const sectionDefKey = toBase64(blockKey);
      definitions[sectionDefKey] = {
        title: blockKey,
        type: "object",
        allOf: [{ $ref: `#/definitions/${propsDefKey}` }],
        required: ["__resolveType"],
        properties: {
          __resolveType: { type: "string", enum: [blockKey], default: blockKey },
        },
      };

      sectionBlocks[blockKey] = {
        $ref: `#/definitions/${sectionDefKey}`,
        namespace: SITE_NAMESPACE,
      };
      sectionRootAnyOf.push({
        $ref: `#/definitions/${sectionDefKey}`,
        inputSchema: `#/definitions/${propsDefKey}`,
      });

      console.log(`  ${propCount > 0 ? "✓" : "○"} ${blockKey} (${propCount} props)`);
    } catch (e) {
      console.warn(`  ✗ ${blockKey}: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Third pass: scan installed app bridges (src/apps/)
  // ---------------------------------------------------------------------------
  const appBlocks: Record<string, any> = {};
  const appRootAnyOf: any[] = [];
  if (!SKIP_APPS) {
    const appsDir = path.resolve(root, APPS_REL);
    const appFiles = fs.existsSync(appsDir) ? findTsxFiles(appsDir) : [];
    console.log(`Found ${appFiles.length} app files`);
    for (const filePath of appFiles) {
      getSourceFile(project, filePath, sourceFileCache);
    }

    for (const filePath of appFiles) {
      const relativePath = path.relative(srcDir, filePath).replaceAll("\\", "/");
      const blockKey = `${SITE_NAMESPACE}/${relativePath}`;

      if (
        !blockKey.startsWith(`${SITE_NAMESPACE}/apps/`) ||
        !blockKey.endsWith(".ts") ||
        blockKey.includes("/_")
      ) {
        continue;
      }

      try {
        const sourceFile = getSourceFile(project, filePath, sourceFileCache);

        let propsSchema: any = null;

        const propsInterface = sourceFile.getInterface("Props");
        if (propsInterface) propsSchema = typeToJsonSchema(propsInterface.getType(), undefined, ctx);

        const propsTypeAlias = sourceFile.getTypeAlias("Props");
        if (!propsSchema && propsTypeAlias)
          propsSchema = typeToJsonSchema(propsTypeAlias.getType(), undefined, ctx);

        if (!propsSchema) {
          propsSchema = resolvePropsViaReExport(
            project,
            sourceFile,
            filePath,
            root,
            3,
            sourceFileCache,
            moduleResolutionCache,
            propsSchemaCache,
            ctx,
          );
        }

        if (!propsSchema) {
          const localPropsType = extractDefaultExportPropsType(sourceFile);
          if (localPropsType) {
            propsSchema = typeToJsonSchema(localPropsType, undefined, ctx);
          }
        }

        if (!propsSchema) propsSchema = { type: "object", properties: {} };

        const propCount = Object.keys(propsSchema.properties || {}).length;

        const propsDefKey = toBase64(`file:///${filePath.replaceAll("\\", "/")}`) + "@Props";
        definitions[propsDefKey] = propsSchema;

        const appDefKey = toBase64(blockKey);
        definitions[appDefKey] = {
          title: blockKey,
          type: "object",
          allOf: [{ $ref: `#/definitions/${propsDefKey}` }],
          required: ["__resolveType"],
          properties: {
            __resolveType: { type: "string", enum: [blockKey], default: blockKey },
          },
        };

        appBlocks[blockKey] = {
          $ref: `#/definitions/${appDefKey}`,
          namespace: SITE_NAMESPACE,
        };
        appRootAnyOf.push({
          $ref: `#/definitions/${appDefKey}`,
          inputSchema: `#/definitions/${propsDefKey}`,
        });

        console.log(`  ${propCount > 0 ? "✓" : "○"} ${blockKey} (${propCount} props)`);
      } catch (e) {
        console.warn(`  ✗ ${blockKey}: ${(e as Error).message}`);
      }
    }
  }

  // Pages, matchers, etc. are injected at runtime by composeMeta() in src/admin/schema.ts.
  // Site-level loaders are generated here (first pass above).
  const emptyAnyOf = { anyOf: [] as any[] };
  return {
    major: 1,
    version: FRAMEWORK_VERSION,
    namespace: SITE_NAMESPACE,
    site: SITE_NAME,
    manifest: { blocks: { sections: sectionBlocks, loaders: loaderBlocks, apps: appBlocks } },
    schema: {
      definitions,
      root: {
        sections: { anyOf: sectionRootAnyOf },
        loaders: { anyOf: loaderRootAnyOf },
        actions: emptyAnyOf,
        pages: emptyAnyOf,
        handlers: emptyAnyOf,
        matchers: emptyAnyOf,
        flags: emptyAnyOf,
        functions: emptyAnyOf,
        apps: { anyOf: appRootAnyOf },
      },
    },
    platform: PLATFORM,
    cloudProvider: PLATFORM,
  };
}

const meta = generateMeta();
const outPath = path.resolve(process.cwd(), OUT_REL);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(meta, null, 2));

const defCount = Object.keys(meta.schema.definitions).length;
const secCount = Object.keys(meta.manifest.blocks.sections || {}).length;
const ldrCount = Object.keys(meta.manifest.blocks.loaders || {}).length;
const appCount = Object.keys(meta.manifest.blocks.apps || {}).length;
console.log(
  `\nGenerated schema: ${defCount} definitions, ${secCount} sections, ${ldrCount} loaders, ${appCount} apps → ${path.relative(process.cwd(), outPath)}`,
);
