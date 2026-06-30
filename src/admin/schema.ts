/**
 * Framework-level schema definitions and runtime meta composition.
 *
 * The schema generator (scripts/generate-schema.ts) produces section and app
 * schemas from site TypeScript files. Framework-managed block types -- pages,
 * loaders, matchers, flags -- have their schemas defined here and injected
 * at runtime via composeMeta().
 *
 * This keeps the generator focused on site-specific concerns while the
 * framework owns the schemas for its own block types.
 */

export interface MetaResponse {
  major: number;
  version: string;
  namespace: string;
  site: string;
  manifest: {
    blocks: Record<string, Record<string, { $ref: string; namespace?: string }>>;
  };
  schema: {
    definitions: Record<string, any>;
    root: Record<string, any>;
  };
  platform?: string;
  cloudProvider?: string;
  framework?: string;
  etag?: string;
}

/**
 * Standard base64 encoding that matches the browser's btoa().
 * The admin uses btoa(resolveType) in some code paths to construct
 * definition refs, so our keys MUST include the = padding.
 */
function toBase64(str: string): string {
  if (typeof btoa === "function") return btoa(str);
  return Buffer.from(str).toString("base64");
}

// The admin's deRefUntil and ArrayFieldTemplate look for the LITERAL
// string "Resolvable" (not base64-encoded). Both keys are needed:
// - literal for admin detection
// - base64 for backward compat with any code that does btoa("Resolvable")
const RESOLVABLE_LITERAL_KEY = "Resolvable";
const RESOLVABLE_B64_KEY = toBase64("Resolvable");

function buildResolvableDefinition() {
  return {
    title: "Select from saved",
    type: "object",
    required: ["__resolveType"],
    additionalProperties: true,
    properties: { __resolveType: { type: "string" } },
  };
}

// ---------------------------------------------------------------------------
// Loader definitions — dynamic registry
// ---------------------------------------------------------------------------

export interface LoaderConfig {
  key: string;
  title: string;
  namespace: string;
  description?: string;
  icon?: string;
  propsSchema: Record<string, any>;
  /** Tags for property matching (e.g., "product-list" enables injection into Product[] props). */
  tags?: string[];
}

const loaderRegistry: LoaderConfig[] = [];

/** Register a single loader schema for the admin. */
export function registerLoaderSchema(config: LoaderConfig) {
  const idx = loaderRegistry.findIndex((l) => l.key === config.key);
  if (idx >= 0) {
    loaderRegistry[idx] = config;
  } else {
    loaderRegistry.push(config);
  }
}

/** Register multiple loader schemas at once. */
export function registerLoaderSchemas(configs: LoaderConfig[]) {
  for (const config of configs) registerLoaderSchema(config);
}

/** Get all registered loader schemas. */
export function getRegisteredLoaders(): LoaderConfig[] {
  return [...loaderRegistry];
}

function getProductListLoaderKeys(): string[] {
  return loaderRegistry.filter((l) => l.tags?.includes("product-list")).map((l) => l.key);
}

// ---------------------------------------------------------------------------
// Action definitions — dynamic registry
// ---------------------------------------------------------------------------

export interface ActionConfig {
  key: string;
  title: string;
  namespace: string;
  description?: string;
  icon?: string;
  propsSchema: Record<string, any>;
}

const actionRegistry: ActionConfig[] = [];

/** Register a single action schema for the admin. */
export function registerActionSchema(config: ActionConfig) {
  const idx = actionRegistry.findIndex((a) => a.key === config.key);
  if (idx >= 0) {
    actionRegistry[idx] = config;
  } else {
    actionRegistry.push(config);
  }
}

/** Register multiple action schemas at once. */
export function registerActionSchemas(configs: ActionConfig[]) {
  for (const config of configs) registerActionSchema(config);
}

function buildActionDefinitions() {
  const definitions: Record<string, any> = {};
  const manifestBlocks: Record<string, any> = {};

  for (const action of actionRegistry) {
    const defKey = toBase64(action.key);

    definitions[defKey] = {
      title: action.key,
      ...(action.description ? { description: action.description } : {}),
      ...(action.icon ? { icon: action.icon } : {}),
      type: "object",
      required: ["__resolveType", ...(action.propsSchema?.required || [])],
      properties: {
        __resolveType: {
          type: "string",
          enum: [action.key],
          default: action.key,
        },
        ...(action.propsSchema?.properties || {}),
      },
    };

    manifestBlocks[action.key] = {
      $ref: `#/definitions/${defKey}`,
      namespace: action.namespace,
    };
  }

  return { definitions, manifestBlocks };
}

// ---------------------------------------------------------------------------
// Matcher definitions — dynamic registry
// ---------------------------------------------------------------------------

export interface MatcherConfig {
  key: string;
  title: string;
  namespace: string;
  description?: string;
  icon?: string;
  propsSchema?: Record<string, any>;
}

const matcherRegistry: MatcherConfig[] = [];

/** Register a single matcher schema for the admin. */
export function registerMatcherSchema(config: MatcherConfig) {
  const idx = matcherRegistry.findIndex((m) => m.key === config.key);
  if (idx >= 0) {
    matcherRegistry[idx] = config;
  } else {
    matcherRegistry.push(config);
  }
}

/** Register multiple matcher schemas at once. */
export function registerMatcherSchemas(configs: MatcherConfig[]) {
  for (const config of configs) registerMatcherSchema(config);
}

/** Get all registered matcher schemas. */
export function getRegisteredMatchers(): MatcherConfig[] {
  return matcherRegistry;
}

// Register built-in matchers that are always available
registerMatcherSchemas([
  { key: "website/matchers/always.ts", title: "Always", description: "Target all users", icon: "eye", namespace: "website" },
  { key: "website/matchers/never.ts", title: "Never", description: "Hide from all users", icon: "eye-off", namespace: "website" },
  {
    key: "website/matchers/device.ts",
    title: "Device",
    description: "Target users based on their device type, such as desktop, tablet, or mobile",
    icon: "device-mobile",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        mobile: { type: "boolean", title: "Mobile" },
        desktop: { type: "boolean", title: "Desktop" },
      },
    },
  },
  {
    key: "website/matchers/date.ts",
    title: "Date and Time",
    description: "Target users based on specific dates or date ranges, including specific times",
    icon: "calendar-event",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        start: { type: "string", title: "Start Date", format: "date-time" },
        end: { type: "string", title: "End Date", format: "date-time" },
      },
    },
  },
  {
    key: "website/matchers/cron.ts",
    title: "Cron",
    description: "Target users with precision using recurring schedules",
    icon: "refresh",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        start: { type: "string", title: "Start", format: "date-time" },
        end: { type: "string", title: "End", format: "date-time" },
      },
    },
  },
  {
    key: "website/matchers/cookie.ts",
    title: "Cookie",
    description: "Target users that have a specific cookie",
    icon: "cookie",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Cookie Name" },
        value: { type: "string", title: "Cookie Value" },
      },
    },
  },
  {
    key: "website/matchers/host.ts",
    title: "Host",
    description: "Target users based on the domain or subdomain they are accessing your site from",
    icon: "world-www",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        host: { type: "string", title: "Hostname" },
      },
    },
  },
  {
    key: "website/matchers/pathname.ts",
    title: "Pathname",
    description: "Target users based on the pathname",
    icon: "world-www",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", title: "Regex Pattern" },
        includes: {
          type: "array",
          title: "Includes",
          items: { type: "string" },
        },
        excludes: {
          type: "array",
          title: "Excludes",
          items: { type: "string" },
        },
      },
    },
  },
  {
    key: "website/matchers/queryString.ts",
    title: "Query String",
    description: "Match with a specific querystring",
    icon: "question-mark",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        key: { type: "string", title: "Parameter Name" },
        value: { type: "string", title: "Parameter Value" },
      },
    },
  },
  {
    key: "website/matchers/random.ts",
    title: "Random",
    description: "Target a percentage of the total traffic to do an A/B test",
    icon: "arrow-split",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        traffic: {
          type: "number",
          title: "Traffic Percentage (0\u20131)",
          minimum: 0,
          maximum: 1,
        },
      },
    },
  },
  {
    key: "website/matchers/location.ts",
    title: "Location",
    description: "Target users based on their geographical location, such as country, city, or region",
    icon: "map-2",
    namespace: "website",
    propsSchema: (() => {
      const locationOrMapItem = {
        type: "object" as const,
        properties: {
          city: {
            type: "string",
            title: "City",
            examples: ["São Paulo"],
            description: "Exact city name (case-insensitive) as returned by Cloudflare's cf-ipcity header.",
          },
          regionCode: {
            type: "string",
            title: "Region Code",
            examples: ["SP", "RJ", "MG", "47"],
            description:
              "Matches Cloudflare's cf-region-code header. Usually the ISO 3166-2 subdivision code (SP, RJ, MG, …); for some regions Cloudflare returns numeric codes (e.g. 47). Use the same value cf-region-code returns for your audience — full region names like \"São Paulo\" are NOT matched.",
          },
          country: {
            type: "string",
            title: "Country",
            examples: ["BR", "Brasil", "US"],
            description: "ISO 3166-1 alpha-2 code (BR, US, AR, …) or a full country name (Brasil, United States) — the matcher resolves common aliases.",
          },
          coordinates: {
            type: "string",
            title: "Area selection",
            examples: ["-23.5505,-46.6333,5000"],
            description: "\"latitude,longitude,radius_in_meters\" for haversine-radius matching. Set this for the Map mode.",
          },
        },
      };
      return {
        type: "object" as const,
        properties: {
          includeLocations: {
            type: "array",
            title: "Include Locations",
            items: locationOrMapItem,
          },
          excludeLocations: {
            type: "array",
            title: "Exclude Locations",
            items: locationOrMapItem,
          },
        },
      };
    })(),
  },
  {
    key: "website/matchers/userAgent.ts",
    title: "User Agent",
    description: "Target users based on their web browser or operational system",
    icon: "world",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        includes: { type: "string", title: "Includes (substring)" },
        match: { type: "string", title: "Match (regex)" },
      },
    },
  },
  {
    key: "website/matchers/environment.ts",
    title: "Environment",
    description: "Target users based from where they are accessing your site (development, testing, or production)",
    icon: "code",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        environment: {
          type: "string",
          title: "Environment",
          enum: ["production", "development"],
        },
      },
    },
  },
  {
    key: "website/matchers/multi.ts",
    title: "Multi",
    description: "Create more complex conditions by combining multiple matchers",
    icon: "plus",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          title: "Operator",
          enum: ["and", "or"],
          default: "and",
        },
        matchers: {
          type: "array",
          title: "Matchers",
          items: {
            type: "object",
            required: ["__resolveType"],
            properties: { __resolveType: { type: "string" } },
            additionalProperties: true,
          },
        },
      },
    },
  },
  {
    key: "website/matchers/negate.ts",
    title: "Negates",
    description: "Create conditions that target users who do not meet certain criteria",
    icon: "minus",
    namespace: "website",
    propsSchema: {
      type: "object",
      properties: {
        matcher: {
          type: "object",
          title: "Matcher",
          required: ["__resolveType"],
          properties: { __resolveType: { type: "string" } },
          additionalProperties: true,
        },
      },
    },
  },
]);

function buildLoaderDefinitions() {
  const definitions: Record<string, any> = {};
  const manifestBlocks: Record<string, any> = {};
  const loaderAnyOf: any[] = [{ $ref: `#/definitions/${RESOLVABLE_LITERAL_KEY}` }];

  for (const loader of loaderRegistry) {
    const defKey = toBase64(loader.key);

    definitions[defKey] = {
      title: loader.key,
      ...(loader.description ? { description: loader.description } : {}),
      ...(loader.icon ? { icon: loader.icon } : {}),
      type: "object",
      required: ["__resolveType", ...(loader.propsSchema?.required || [])],
      properties: {
        __resolveType: {
          type: "string",
          enum: [loader.key],
          default: loader.key,
        },
        ...(loader.propsSchema?.properties || {}),
      },
    };

    manifestBlocks[loader.key] = {
      $ref: `#/definitions/${defKey}`,
      namespace: loader.namespace,
    };

    loaderAnyOf.push({ $ref: `#/definitions/${defKey}` });
  }

  return { definitions, manifestBlocks, loaderAnyOf };
}

// ---------------------------------------------------------------------------
// Matcher definitions
// ---------------------------------------------------------------------------

function buildMatcherDefinitions() {
  const definitions: Record<string, any> = {};
  const manifestBlocks: Record<string, any> = {};
  const matcherAnyOf: any[] = [{ $ref: `#/definitions/${RESOLVABLE_LITERAL_KEY}` }];

  for (const matcher of matcherRegistry) {
    const defKey = toBase64(matcher.key);
    definitions[defKey] = {
      title: matcher.title,
      ...(matcher.description ? { description: matcher.description } : {}),
      ...(matcher.icon ? { icon: matcher.icon } : {}),
      type: "object",
      required: ["__resolveType"],
      properties: {
        __resolveType: {
          type: "string",
          enum: [matcher.key],
          default: matcher.key,
        },
        ...(matcher.propsSchema?.properties || {}),
      },
    };
    manifestBlocks[matcher.key] = {
      $ref: `#/definitions/${defKey}`,
      namespace: matcher.namespace,
    };
    matcherAnyOf.push({ $ref: `#/definitions/${defKey}` });
  }

  return { definitions, manifestBlocks, matcherAnyOf };
}

// ---------------------------------------------------------------------------
// Multivariate flag schema
// ---------------------------------------------------------------------------

function buildMultivariateFlagSchema(innerSchema: any) {
  return {
    type: "object",
    required: ["__resolveType"],
    properties: {
      __resolveType: {
        type: "string",
        enum: ["website/flags/multivariate.ts", "website/flags/multivariate/section.ts"],
      },
      variants: {
        type: "array",
        title: "Variants",
        items: {
          type: "object",
          properties: {
            rule: {
              title: "Rule",
              type: "object",
              required: ["__resolveType"],
              properties: {
                __resolveType: { type: "string" },
              },
              additionalProperties: true,
            },
            value: innerSchema,
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Page schema
// ---------------------------------------------------------------------------

function buildPageSchema(sectionAnyOf: any[]) {
  const PAGE_TYPE = "website/pages/Page.tsx";
  const defKey = toBase64(PAGE_TYPE);

  const sectionsArraySchema = {
    type: "array",
    title: "Sections",
    items: { anyOf: sectionAnyOf },
  };

  const sectionsMultivariateSchema = buildMultivariateFlagSchema(sectionsArraySchema);

  const definition = {
    title: PAGE_TYPE,
    type: "object",
    required: ["__resolveType"],
    properties: {
      __resolveType: {
        type: "string",
        enum: [PAGE_TYPE],
        default: PAGE_TYPE,
      },
      name: { type: "string", title: "Name" },
      path: { type: "string", title: "Path" },
      seo: { title: "SEO", anyOf: sectionAnyOf },
      sections: {
        title: "Sections",
        anyOf: [sectionsArraySchema, sectionsMultivariateSchema],
      },
    },
  };

  return {
    definitions: { [defKey]: definition },
    manifestBlocks: {
      [PAGE_TYPE]: {
        $ref: `#/definitions/${defKey}`,
        namespace: "website",
      },
    },
    rootAnyOf: [
      { $ref: `#/definitions/${RESOLVABLE_LITERAL_KEY}` },
      { $ref: `#/definitions/${defKey}` },
    ],
  };
}

// ---------------------------------------------------------------------------
// Framework sections
// ---------------------------------------------------------------------------

function buildFrameworkSections(sectionAnyOf: any[]) {
  const definitions: Record<string, any> = {};
  const manifestBlocks: Record<string, any> = {};
  const extraAnyOf: any[] = [];

  // --- website/sections/Rendering/Lazy.tsx ---
  const LAZY_TYPE = "website/sections/Rendering/Lazy.tsx";
  const lazyKey = toBase64(LAZY_TYPE);
  definitions[lazyKey] = {
    title: LAZY_TYPE,
    type: "object",
    required: ["__resolveType"],
    properties: {
      __resolveType: {
        type: "string",
        enum: [LAZY_TYPE],
        default: LAZY_TYPE,
      },
      section: {
        title: "Section",
        anyOf: sectionAnyOf,
      },
    },
  };
  manifestBlocks[LAZY_TYPE] = {
    $ref: `#/definitions/${lazyKey}`,
    namespace: "website",
  };
  extraAnyOf.push({ $ref: `#/definitions/${lazyKey}` });

  // --- website/sections/Seo/Seo.tsx ---
  const SEO_TYPE = "website/sections/Seo/Seo.tsx";
  const seoKey = toBase64(SEO_TYPE);
  definitions[seoKey] = {
    title: SEO_TYPE,
    type: "object",
    required: ["__resolveType"],
    properties: {
      __resolveType: {
        type: "string",
        enum: [SEO_TYPE],
        default: SEO_TYPE,
      },
      title: { type: "string", title: "Title" },
      description: { type: "string", title: "Description" },
      canonical: { type: "string", title: "Canonical URL" },
      favicon: { type: "string", title: "Favicon", format: "image-uri" },
      noIndexing: { type: "boolean", title: "No Indexing" },
      titleTemplate: { type: "string", title: "Title Template" },
      descriptionTemplate: { type: "string", title: "Description Template" },
      type: { type: "string", title: "Page Type" },
      image: { type: "string", title: "OG Image", format: "image-uri" },
      themeColor: { type: "string", title: "Theme Color", format: "color" },
      jsonLDs: {
        type: "array",
        title: "JSON-LD Structured Data",
        items: { type: "object", additionalProperties: true },
      },
    },
  };
  manifestBlocks[SEO_TYPE] = {
    $ref: `#/definitions/${seoKey}`,
    namespace: "website",
  };
  extraAnyOf.push({ $ref: `#/definitions/${seoKey}` });

  // --- website/sections/Seo/SeoV2.tsx ---
  const SEOV2_TYPE = "website/sections/Seo/SeoV2.tsx";
  const seoV2Key = toBase64(SEOV2_TYPE);
  definitions[seoV2Key] = {
    title: SEOV2_TYPE,
    type: "object",
    required: ["__resolveType"],
    properties: {
      __resolveType: {
        type: "string",
        enum: [SEOV2_TYPE],
        default: SEOV2_TYPE,
      },
      title: { type: "string", title: "Title" },
      description: { type: "string", title: "Description" },
      canonical: { type: "string", title: "Canonical URL" },
      favicon: { type: "string", title: "Favicon", format: "image-uri" },
      noIndexing: { type: "boolean", title: "No Indexing" },
      titleTemplate: { type: "string", title: "Title Template" },
      descriptionTemplate: { type: "string", title: "Description Template" },
      type: { type: "string", title: "Page Type" },
      image: { type: "string", title: "OG Image", format: "image-uri" },
      themeColor: { type: "string", title: "Theme Color", format: "color" },
      jsonLDs: {
        type: "array",
        title: "JSON-LD Structured Data",
        items: { type: "object", additionalProperties: true },
      },
    },
  };
  manifestBlocks[SEOV2_TYPE] = {
    $ref: `#/definitions/${seoV2Key}`,
    namespace: "website",
  };
  extraAnyOf.push({ $ref: `#/definitions/${seoV2Key}` });

  // --- website/flags/multivariate/section.ts ---
  const MV_SECTION_TYPE = "website/flags/multivariate/section.ts";
  const mvSectionKey = toBase64(MV_SECTION_TYPE);
  definitions[mvSectionKey] = {
    title: MV_SECTION_TYPE,
    type: "object",
    required: ["__resolveType"],
    properties: {
      __resolveType: {
        type: "string",
        enum: [MV_SECTION_TYPE],
        default: MV_SECTION_TYPE,
      },
      variants: {
        type: "array",
        title: "Variants",
        items: {
          type: "object",
          properties: {
            rule: {
              title: "Rule",
              type: "object",
              required: ["__resolveType"],
              properties: { __resolveType: { type: "string" } },
              additionalProperties: true,
            },
            value: {
              title: "Section",
              anyOf: sectionAnyOf,
            },
          },
        },
      },
    },
  };
  manifestBlocks[MV_SECTION_TYPE] = {
    $ref: `#/definitions/${mvSectionKey}`,
    namespace: "website",
  };
  extraAnyOf.push({ $ref: `#/definitions/${mvSectionKey}` });

  return { definitions, manifestBlocks, extraAnyOf };
}

// ---------------------------------------------------------------------------
// Post-processing: wrap complex properties with Resolvable anyOf
// ---------------------------------------------------------------------------

/**
 * Walk all @Props definitions and wrap complex array/object properties
 * with anyOf [Resolvable, original, ...matchingLoaders].
 *
 * In the deco CMS, ANY complex property can be replaced by a loader
 * reference ({ __resolveType: "some/loader.ts", props: {...} }).
 * This function ensures the schema accepts both inline data and
 * loader references for all such properties.
 */
function wrapResolvableProperties(
  definitions: Record<string, any>,
  _loaderDefinitions: Record<string, any>,
) {
  const resolvableRef = { $ref: `#/definitions/${RESOLVABLE_LITERAL_KEY}` };

  const productLoaderRefs = getProductListLoaderKeys().map((key) => ({
    $ref: `#/definitions/${toBase64(key)}`,
  }));

  for (const [defKey, def] of Object.entries(definitions)) {
    if (!defKey.endsWith("@Props")) continue;
    if (!def || !def.properties) continue;

    for (const [propName, propSchema] of Object.entries(def.properties as Record<string, any>)) {
      if (!propSchema || typeof propSchema !== "object") continue;
      if (propSchema.anyOf || propSchema.$ref) continue;

      const shouldWrap = isLoaderCompatibleProperty(propSchema);
      if (!shouldWrap) continue;

      const { nullable, title, hide, ...rest } = propSchema;

      // Determine which loader refs to include based on property type
      const loaderRefs = isProductArrayProperty(propSchema) ? productLoaderRefs : [];

      const wrapped: any = {
        anyOf: [resolvableRef, { ...rest, title: title || "Inline data" }, ...loaderRefs],
      };
      if (nullable) wrapped.nullable = true;
      if (title) wrapped.title = title;
      if (hide) wrapped.hide = hide;

      def.properties[propName] = wrapped;
    }

    // Also walk nested object properties (e.g., Tab.products inside tabs array items)
    wrapNestedProperties(def, resolvableRef, productLoaderRefs);
  }
}

function isLoaderCompatibleProperty(schema: any): boolean {
  if (schema.type === "array" && schema.items?.type === "object") {
    const propCount = Object.keys(schema.items.properties || {}).length;
    return propCount > 3;
  }
  return false;
}

function isProductArrayProperty(schema: any): boolean {
  if (schema.type !== "array" || !schema.items?.properties) return false;
  const itemProps = schema.items.properties;
  return !!(itemProps.productID || itemProps.name || itemProps.offers || itemProps.brand);
}

/**
 * Recursively walk nested object/array schemas to wrap deeply nested
 * loader-compatible properties. Handles cases like Tab.products where
 * the products field is inside an array item's object schema.
 */
function wrapNestedProperties(
  schema: any,
  resolvableRef: any,
  productLoaderRefs: any[],
  depth = 0,
) {
  if (depth > 5 || !schema || typeof schema !== "object") return;

  if (schema.type === "array" && schema.items?.type === "object" && schema.items.properties) {
    for (const [propName, propSchema] of Object.entries(
      schema.items.properties as Record<string, any>,
    )) {
      if (!propSchema || typeof propSchema !== "object") continue;
      if (propSchema.anyOf || propSchema.$ref) continue;

      if (isLoaderCompatibleProperty(propSchema)) {
        const { nullable, title, hide, ...rest } = propSchema;
        const loaderRefs = isProductArrayProperty(propSchema) ? productLoaderRefs : [];
        const wrapped: any = {
          anyOf: [resolvableRef, { ...rest, title: title || "Inline data" }, ...loaderRefs],
        };
        if (nullable) wrapped.nullable = true;
        if (title) wrapped.title = title;
        if (hide) wrapped.hide = hide;
        schema.items.properties[propName] = wrapped;
      }

      wrapNestedProperties(propSchema, resolvableRef, productLoaderRefs, depth + 1);
    }
  }

  if (schema.properties) {
    for (const propSchema of Object.values(schema.properties)) {
      wrapNestedProperties(propSchema as any, resolvableRef, productLoaderRefs, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// composeMeta
// ---------------------------------------------------------------------------

const SECTION_REF_DEF_KEY = "__SECTION_REF__";

export function composeMeta(siteMeta: MetaResponse): MetaResponse {
  const siteAnyOf = siteMeta.schema?.root?.sections?.anyOf || [];

  // Build all framework components
  const fwSections = buildFrameworkSections(siteAnyOf);
  const fullSectionAnyOf = [...siteAnyOf, ...fwSections.extraAnyOf];
  const page = buildPageSchema(fullSectionAnyOf);
  const loaders = buildLoaderDefinitions();
  const actions = buildActionDefinitions();
  const matchers = buildMatcherDefinitions();

  const sectionRefDef = { title: "Section", anyOf: fullSectionAnyOf };

  const resolvableDef = buildResolvableDefinition();

  // Merge all definitions.
  // Priority (last wins): auto-registered empty schemas → framework sections/pages →
  // site-generated schemas (meta.gen.json, with full loader props) → framework-critical keys.
  // This ensures detailed site-generated schemas always win over auto-registered stubs.
  const allDefinitions: Record<string, any> = {
    ...loaders.definitions,
    ...actions.definitions,
    ...matchers.definitions,
    ...fwSections.definitions,
    ...page.definitions,
    ...(siteMeta.schema?.definitions || {}),
    [SECTION_REF_DEF_KEY]: sectionRefDef,
    [RESOLVABLE_LITERAL_KEY]: resolvableDef,
    [RESOLVABLE_B64_KEY]: resolvableDef,
  };

  // Post-process: wrap complex section properties with Resolvable anyOf
  wrapResolvableProperties(allDefinitions, loaders.definitions);

  return {
    ...siteMeta,
    framework: "tanstack-start",
    manifest: {
      blocks: {
        ...(siteMeta.manifest?.blocks || {}),
        sections: {
          ...(siteMeta.manifest?.blocks?.sections || {}),
          ...fwSections.manifestBlocks,
        },
        pages: {
          ...(siteMeta.manifest?.blocks?.pages || {}),
          ...page.manifestBlocks,
        },
        loaders: {
          ...(siteMeta.manifest?.blocks?.loaders || {}),
          ...loaders.manifestBlocks,
        },
        actions: {
          ...(siteMeta.manifest?.blocks?.actions || {}),
          ...actions.manifestBlocks,
        },
        matchers: {
          ...(siteMeta.manifest?.blocks?.matchers || {}),
          ...matchers.manifestBlocks,
        },
      },
    },
    schema: {
      definitions: allDefinitions,
      root: {
        ...(siteMeta.schema?.root || {}),
        sections: { anyOf: fullSectionAnyOf },
        pages: { anyOf: page.rootAnyOf },
        loaders: { anyOf: loaders.loaderAnyOf },
        matchers: { anyOf: matchers.matcherAnyOf },
      },
    },
  };
}
