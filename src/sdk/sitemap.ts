/**
 * Sitemap generation utilities.
 *
 * Provides XML sitemap generation from CMS page blocks and arbitrary
 * URL lists. Designed to be composed with commerce-specific sitemap
 * sources (VTEX, Shopify) in a TanStack Start API route.
 *
 * @example
 * ```ts
 * // src/routes/sitemap[.]xml.ts
 * import { createAPIFileRoute } from "@tanstack/react-start/api";
 * import { getCMSSitemapEntries, generateSitemapXml } from "@decocms/start/sdk/sitemap";
 * import { getVtexSitemapEntries } from "@decocms/apps/vtex/utils/sitemap";
 *
 * export const APIRoute = createAPIFileRoute("/sitemap.xml")({
 *   GET: async ({ request }) => {
 *     const origin = new URL(request.url).origin;
 *     const cmsEntries = getCMSSitemapEntries(origin);
 *     const vtexEntries = await getVtexSitemapEntries(origin);
 *     const xml = generateSitemapXml([...cmsEntries, ...vtexEntries]);
 *     return new Response(xml, {
 *       headers: {
 *         "Content-Type": "application/xml",
 *         "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
 *       },
 *     });
 *   },
 * });
 * ```
 */

import { getAllPages, loadBlocks } from "../cms/loader";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

export interface SitemapOptions {
  /** Maximum entries per sitemap (Google limit is 50,000). @default 50000 */
  maxEntries?: number;
}

// -------------------------------------------------------------------------
// CMS page entries
// -------------------------------------------------------------------------

/**
 * Extract sitemap entries from CMS page blocks.
 *
 * Reads all pages from the block store and generates URLs from their
 * path patterns (excluding wildcard-only patterns like `/*`).
 */
export function getCMSSitemapEntries(origin: string): SitemapEntry[] {
  const pages = getAllPages();
  const entries: SitemapEntry[] = [];
  const today = new Date().toISOString().split("T")[0];

  for (const { page } of pages) {
    if (!page.path) continue;

    if (page.path.includes("*") || page.path.includes(":")) continue;

    const loc = `${origin}${page.path === "/" ? "" : page.path}`;
    entries.push({
      loc: loc || origin,
      lastmod: today,
      changefreq: page.path === "/" ? "daily" : "weekly",
      priority: page.path === "/" ? 1.0 : 0.7,
    });
  }

  return entries;
}

// -------------------------------------------------------------------------
// XML generation
// -------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate a sitemap XML string from entries.
 */
export function generateSitemapXml(entries: SitemapEntry[], options?: SitemapOptions): string {
  const max = options?.maxEntries ?? 50000;
  const limited = entries.slice(0, max);

  const urls = limited.map((entry) => {
    let url = `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>`;
    if (entry.lastmod) url += `\n    <lastmod>${entry.lastmod}</lastmod>`;
    if (entry.changefreq) url += `\n    <changefreq>${entry.changefreq}</changefreq>`;
    if (entry.priority != null) url += `\n    <priority>${entry.priority.toFixed(1)}</priority>`;
    url += "\n  </url>";
    return url;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
  ].join("\n");
}

/**
 * Generate a sitemap index XML for splitting large sitemaps.
 *
 * @example
 * ```ts
 * const index = generateSitemapIndexXml([
 *   `${origin}/sitemap-pages.xml`,
 *   `${origin}/sitemap-products.xml`,
 * ]);
 * ```
 */
export function generateSitemapIndexXml(sitemapUrls: string[]): string {
  const today = new Date().toISOString().split("T")[0];
  const sitemaps = sitemapUrls.map(
    (url) =>
      `  <sitemap>\n    <loc>${escapeXml(url)}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`,
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemaps,
    "</sitemapindex>",
  ].join("\n");
}
