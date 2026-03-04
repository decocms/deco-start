#!/usr/bin/env tsx
/**
 * Schema Generator for deco admin compatibility.
 *
 * Scans src/sections/ for .tsx files, parses their Props interfaces,
 * and generates JSON Schema 7 definitions in the format expected by
 * the deco admin (/deco/meta endpoint).
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/start/scripts/generate-schema.ts [options]
 *
 * Options:
 *   --namespace   Section namespace  (default: "site")
 *   --site        Site name          (default: "storefront")
 *   --version     Framework version  (default: "1.0.0")
 *   --sections    Sections directory (default: "src/sections")
 *   --out         Output file        (default: "src/server/admin/meta.gen.json")
 *   --platform    Platform name      (default: "cloudflare")
 */
import { Project, Type, Symbol as MorphSymbol, Node } from "ts-morph";
import fs from "node:fs";
import path from "node:path";

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
  return Buffer.from(str).toString("base64").replace(/=+$/, "");
}

function typeToJsonSchema(type: Type, visited = new Set<string>()): any {
  const typeText = type.getText();
  if (visited.has(typeText)) return { type: "object" };
  visited.add(typeText);

  try {
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
        ? { type: "array", items: typeToJsonSchema(el, new Set(visited)) }
        : { type: "array" };
    }

    if (type.isUnion()) {
      const parts = type.getUnionTypes();
      const nonNull = parts.filter((t) => !t.isNull() && !t.isUndefined());
      if (nonNull.length === 1 && nonNull.length < parts.length) {
        return { ...typeToJsonSchema(nonNull[0], new Set(visited)), nullable: true };
      }
      if (nonNull.every((t) => t.isStringLiteral())) {
        return { type: "string", enum: nonNull.map((t) => t.getLiteralValue()) };
      }
      return { anyOf: nonNull.map((t) => typeToJsonSchema(t, new Set(visited))) };
    }

    if (type.isObject() || type.isInterface()) {
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const prop of type.getProperties()) {
        const name = prop.getName();
        if (name.startsWith("_") || name === "@type") continue;

        const decl = prop.getValueDeclaration();
        if (!decl) continue;
        const propType = prop.getTypeAtLocation(decl);
        const schema = typeToJsonSchema(propType, new Set(visited));

        const tags = getJsDocTags(prop);
        if (tags.title) schema.title = tags.title;
        if (tags.description) schema.description = tags.description;
        if (tags.format) schema.format = tags.format;
        if (tags.hide) schema.hide = "true";
        if (!schema.title) schema.title = name.charAt(0).toUpperCase() + name.slice(1);

        properties[name] = schema;
        if (!prop.isOptional()) required.push(name);
      }

      const result: any = { type: "object", properties };
      if (required.length > 0) result.required = required;
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
  const srcDir = path.join(root, "src");

  const project = new Project({
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });

  const definitions: Record<string, any> = {};
  const sectionBlocks: Record<string, any> = {};
  const sectionRootAnyOf: any[] = [];

  const resolvableKey = toBase64("Resolvable");
  definitions[resolvableKey] = {
    title: "Select from saved",
    type: "object",
    required: ["__resolveType"],
    additionalProperties: false,
    properties: { __resolveType: { type: "string" } },
  };
  sectionRootAnyOf.push({ $ref: `#/definitions/${resolvableKey}` });

  if (!fs.existsSync(sectionsDir)) {
    console.error(`Sections directory not found: ${sectionsDir}`);
    process.exit(1);
  }

  const sectionFiles = findTsxFiles(sectionsDir);
  console.log(`Found ${sectionFiles.length} section files`);

  for (const filePath of sectionFiles) {
    const relativePath = path.relative(srcDir, filePath);
    const blockKey = `${SITE_NAMESPACE}/${relativePath}`;

    try {
      const sourceFile = project.addSourceFileAtPath(filePath);

      let propsSchema: any = null;
      const propsInterface = sourceFile.getInterface("Props");
      if (propsInterface) propsSchema = typeToJsonSchema(propsInterface.getType());

      const propsTypeAlias = sourceFile.getTypeAlias("Props");
      if (!propsSchema && propsTypeAlias) propsSchema = typeToJsonSchema(propsTypeAlias.getType());

      if (!propsSchema) propsSchema = { type: "object", properties: {} };

      const propsDefKey = toBase64(`file:///${filePath}`) + "@Props";
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

      sectionBlocks[blockKey] = { $ref: `#/definitions/${sectionDefKey}`, namespace: SITE_NAMESPACE };
      sectionRootAnyOf.push({ $ref: `#/definitions/${sectionDefKey}`, inputSchema: `#/definitions/${propsDefKey}` });

      console.log(`  ✓ ${blockKey}`);
    } catch (e) {
      console.warn(`  ✗ ${blockKey}: ${(e as Error).message}`);
    }
  }

  const emptyAnyOf = { anyOf: [] as any[] };
  return {
    major: 1,
    version: FRAMEWORK_VERSION,
    namespace: SITE_NAMESPACE,
    site: SITE_NAME,
    manifest: { blocks: { sections: sectionBlocks } },
    schema: {
      definitions,
      root: {
        sections: { anyOf: sectionRootAnyOf },
        loaders: emptyAnyOf,
        actions: emptyAnyOf,
        pages: emptyAnyOf,
        handlers: emptyAnyOf,
        matchers: emptyAnyOf,
        flags: emptyAnyOf,
        functions: emptyAnyOf,
        apps: emptyAnyOf,
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
console.log(`\nGenerated schema: ${defCount} definitions, ${secCount} sections → ${path.relative(process.cwd(), outPath)}`);
