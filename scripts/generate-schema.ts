/**
 * Schema Generator for deco admin compatibility.
 *
 * Scans src/sections/ for .tsx files, parses their Props interfaces,
 * and generates JSON Schema 7 definitions in the format expected by
 * the deco admin (/deco/meta endpoint).
 *
 * Usage: npx tsx scripts/generate-schema.ts
 */
import { Project, Type, Symbol as MorphSymbol, Node, SyntaxKind } from "ts-morph";
import fs from "node:fs";
import path from "node:path";

const SITE_NAMESPACE = "site";
const SITE_NAME = "storefront";
const FRAMEWORK_VERSION = "1.164.0";

interface SchemaDefinition {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  title?: string;
  description?: string;
  [key: string]: any;
}

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

function toBase64(str: string): string {
  return Buffer.from(str).toString("base64").replace(/=+$/, "");
}

function typeToJsonSchema(type: Type, visited = new Set<string>()): any {
  const typeText = type.getText();

  if (visited.has(typeText)) {
    return { type: "object" };
  }
  visited.add(typeText);

  try {
    if (type.isString() || type.isStringLiteral()) {
      if (type.isStringLiteral()) {
        return { type: "string", const: type.getLiteralValue() };
      }
      return { type: "string" };
    }

    if (type.isNumber() || type.isNumberLiteral()) {
      return { type: "number" };
    }

    if (type.isBoolean() || type.isBooleanLiteral()) {
      return { type: "boolean" };
    }

    if (type.isNull() || type.isUndefined()) {
      return { type: "null" };
    }

    if (type.isArray()) {
      const elementType = type.getArrayElementType();
      if (elementType) {
        return { type: "array", items: typeToJsonSchema(elementType, new Set(visited)) };
      }
      return { type: "array" };
    }

    if (type.isUnion()) {
      const unionTypes = type.getUnionTypes();
      const nonNull = unionTypes.filter((t) => !t.isNull() && !t.isUndefined());
      if (nonNull.length === 1 && nonNull.length < unionTypes.length) {
        const inner = typeToJsonSchema(nonNull[0], new Set(visited));
        return { ...inner, nullable: true };
      }
      if (nonNull.every((t) => t.isStringLiteral())) {
        return {
          type: "string",
          enum: nonNull.map((t) => t.getLiteralValue()),
        };
      }
      return {
        anyOf: nonNull.map((t) => typeToJsonSchema(t, new Set(visited))),
      };
    }

    if (type.isObject() || type.isInterface()) {
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const prop of type.getProperties()) {
        const name = prop.getName();
        if (name.startsWith("_") || name === "@type") continue;

        const propType = prop.getTypeAtLocation(prop.getValueDeclaration()!);
        const schema = typeToJsonSchema(propType, new Set(visited));

        const jsdocTags = getJsDocTags(prop);
        if (jsdocTags.title) schema.title = jsdocTags.title;
        if (jsdocTags.description) schema.description = jsdocTags.description;
        if (jsdocTags.format) schema.format = jsdocTags.format;
        if (jsdocTags.hide) schema.hide = "true";

        if (!schema.title) {
          schema.title = name.charAt(0).toUpperCase() + name.slice(1);
        }

        properties[name] = schema;

        if (!prop.isOptional()) {
          required.push(name);
        }
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
  const declarations = symbol.getDeclarations();

  for (const decl of declarations) {
    const jsDocs = Node.isJSDocable(decl) ? decl.getJsDocs() : [];
    for (const doc of jsDocs) {
      const desc = doc.getDescription().trim();
      if (desc) tags.description = desc;

      for (const tag of doc.getTags()) {
        const tagName = tag.getTagName();
        const text = tag.getCommentText()?.trim() || "true";
        tags[tagName] = text;
      }
    }
  }

  return tags;
}

function generateMeta(): MetaResponse {
  const projectRoot = process.cwd();
  const sectionsDir = path.join(projectRoot, "src/sections");

  const project = new Project({
    tsConfigFilePath: path.join(projectRoot, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });

  const definitions: Record<string, any> = {};
  const sectionBlocks: Record<string, any> = {};
  const sectionRootAnyOf: any[] = [];

  // Add the "Resolvable" (select from saved) entry
  const resolvableKey = toBase64("Resolvable");
  definitions[resolvableKey] = {
    title: "Select from saved",
    type: "object",
    required: ["__resolveType"],
    additionalProperties: false,
    properties: {
      __resolveType: { type: "string" },
    },
  };
  sectionRootAnyOf.push({ $ref: `#/definitions/${resolvableKey}` });

  // Scan sections directory
  if (!fs.existsSync(sectionsDir)) {
    console.error(`Sections directory not found: ${sectionsDir}`);
    process.exit(1);
  }

  const sectionFiles = findTsxFiles(sectionsDir);
  console.log(`Found ${sectionFiles.length} section files`);

  for (const filePath of sectionFiles) {
    const relativePath = path.relative(path.join(projectRoot, "src"), filePath);
    const blockKey = `${SITE_NAMESPACE}/${relativePath}`;

    try {
      const sourceFile = project.addSourceFileAtPath(filePath);

      // Find the Props interface or type alias
      let propsSchema: any = null;

      const propsInterface = sourceFile.getInterface("Props");
      if (propsInterface) {
        propsSchema = typeToJsonSchema(propsInterface.getType());
      }

      const propsTypeAlias = sourceFile.getTypeAlias("Props");
      if (!propsSchema && propsTypeAlias) {
        propsSchema = typeToJsonSchema(propsTypeAlias.getType());
      }

      // If no Props found, create an empty schema
      if (!propsSchema) {
        propsSchema = { type: "object", properties: {} };
      }

      // Create the Props definition key
      const propsDefKey = toBase64(`file:///${filePath}`) + "@Props";
      definitions[propsDefKey] = propsSchema;

      // Create the section definition (wraps Props with __resolveType)
      const sectionDefKey = toBase64(blockKey);
      definitions[sectionDefKey] = {
        title: blockKey,
        type: "object",
        allOf: [{ $ref: `#/definitions/${propsDefKey}` }],
        required: ["__resolveType"],
        properties: {
          __resolveType: {
            type: "string",
            enum: [blockKey],
            default: blockKey,
          },
        },
      };

      // Add to manifest
      sectionBlocks[blockKey] = {
        $ref: `#/definitions/${sectionDefKey}`,
        namespace: SITE_NAMESPACE,
      };

      // Add to root anyOf
      sectionRootAnyOf.push({
        $ref: `#/definitions/${sectionDefKey}`,
        inputSchema: `#/definitions/${propsDefKey}`,
      });

      console.log(`  ✓ ${blockKey}`);
    } catch (e) {
      console.warn(`  ✗ ${blockKey}: ${(e as Error).message}`);
    }
  }

  // Build the full meta response
  const meta: MetaResponse = {
    major: 1,
    version: FRAMEWORK_VERSION,
    namespace: SITE_NAMESPACE,
    site: SITE_NAME,
    manifest: {
      blocks: {
        sections: sectionBlocks,
      },
    },
    schema: {
      definitions,
      root: {
        sections: { anyOf: sectionRootAnyOf },
        loaders: { anyOf: [] },
        actions: { anyOf: [] },
        pages: { anyOf: [] },
        handlers: { anyOf: [] },
        matchers: { anyOf: [] },
        flags: { anyOf: [] },
        functions: { anyOf: [] },
        apps: { anyOf: [] },
      },
    },
    platform: "cloudflare",
    cloudProvider: "cloudflare",
  };

  return meta;
}

function findTsxFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTsxFiles(fullPath));
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

// Run
const meta = generateMeta();
const outPath = path.join(process.cwd(), "src/server/admin/meta.gen.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(meta, null, 2));

const defCount = Object.keys(meta.schema.definitions).length;
const sectionCount = Object.keys(meta.manifest.blocks.sections || {}).length;
console.log(
  `\nGenerated schema: ${defCount} definitions, ${sectionCount} sections → ${path.relative(process.cwd(), outPath)}`
);
