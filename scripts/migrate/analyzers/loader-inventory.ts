import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationContext, LoaderInfo, Platform } from "../types.ts";
import { log } from "../types.ts";

/** Well-known loaders that map directly to @decocms/apps equivalents */
const APPS_EQUIVALENTS: Record<string, string> = {
  "loaders/availableIcons.ts": "", // deleted
  "loaders/icons.ts": "", // deleted
};

const VTEX_LOADERS: Record<string, string> = {
  "loaders/search/intelligenseSearch.ts": "vtex/autocomplete",
  "loaders/search/intelligentSearchEvents.ts": "",
};

const CACHE_RE = /^export\s+const\s+cache\s*=/m;
const CACHE_KEY_RE = /^export\s+const\s+cacheKey\s*=/m;

function detectPlatformRelevance(content: string, filePath: string): Platform | null {
  if (filePath.includes("vtex") || content.includes("vtex") || content.includes("VTEX")) return "vtex";
  if (filePath.includes("shopify") || content.includes("shopify")) return "shopify";
  if (filePath.includes("wake") || content.includes("wake")) return "wake";
  if (filePath.includes("vnda") || content.includes("vnda")) return "vnda";
  if (filePath.includes("linx") || content.includes("linx")) return "linx";
  if (filePath.includes("nuvemshop") || content.includes("nuvemshop")) return "nuvemshop";
  return null;
}

export function inventoryLoaders(ctx: MigrationContext): void {
  const loaderFiles = ctx.files.filter(
    (f) => f.category === "loader" && f.action !== "delete",
  );

  for (const file of loaderFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file.absPath, "utf-8");
    } catch {
      continue;
    }

    const appsEquiv = APPS_EQUIVALENTS[file.path] ?? VTEX_LOADERS[file.path] ?? null;
    const isDeleted = appsEquiv === "";

    if (isDeleted) continue;

    const info: LoaderInfo = {
      path: file.path,
      hasCache: CACHE_RE.test(content),
      hasCacheKey: CACHE_KEY_RE.test(content),
      appsEquivalent: appsEquiv,
      isCustom: appsEquiv === null,
      platformRelevance: detectPlatformRelevance(content, file.path),
    };

    ctx.loaderInventory.push(info);
  }

  const custom = ctx.loaderInventory.filter((l) => l.isCustom).length;
  const mapped = ctx.loaderInventory.filter((l) => l.appsEquivalent).length;
  log(ctx, `Loaders inventoried: ${ctx.loaderInventory.length} total, ${mapped} mapped, ${custom} custom`);
}
