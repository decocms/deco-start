import type { MigrationContext, SectionMeta } from "../types.ts";

const ACCOUNT_LOADER_MAP: Record<string, string> = {
  personaldata: "personalData",
  myorders: "orders",
  orders: "orders",
  cards: "cards",
  payments: "cards",
  addresses: "addresses",
  auth: "authentication",
  authentication: "authentication",
  login: "authentication",
};

function getAccountLoaderName(sectionBasename: string): string {
  const key = sectionBasename.toLowerCase().replace(/[^a-z]/g, "");
  return ACCOUNT_LOADER_MAP[key] || "loggedIn";
}

export function generateSectionLoaders(ctx: MigrationContext): string {
  const lines: string[] = [];
  const isVtex = ctx.platform === "vtex";
  const hasAccountSections = isVtex && ctx.sectionMetas.some((m) => m.isAccountSection && m.hasLoader);

  lines.push(`/**`);
  lines.push(` * Section Loaders — server-side prop enrichment for CMS sections.`);
  lines.push(` *`);
  lines.push(` * Simple patterns (device, mobile) use framework mixins.`);
  lines.push(` * Complex loaders delegate to the section's own loader export.`);
  lines.push(` * Account sections use vtexAccountLoaders from @decocms/apps.`);
  lines.push(` */`);
  lines.push(`import {`);
  lines.push(`  registerSectionLoaders,`);
  lines.push(`  withDevice,`);
  lines.push(`  withMobile,`);
  lines.push(`  withSearchParam,`);
  lines.push(`  compose,`);
  lines.push(`} from "@decocms/start/cms";`);

  if (hasAccountSections) {
    lines.push(`import { vtexAccountLoaders } from "@decocms/apps/vtex/utils/accountLoaders";`);
  }

  lines.push(``);

  const entries: string[] = [];

  for (const meta of ctx.sectionMetas) {
    if (!meta.hasLoader) continue;

    const sectionKey = `site/${meta.path}`;
    const basename = meta.path.split("/").pop()?.replace(/\.\w+$/, "") || "";

    // Skip status-only loaders (they just set ctx.response.status — handled at route level)
    if (meta.isStatusOnly) {
      entries.push(`  // ${meta.path}: status-only loader — handled at route/worker level, no section loader needed`);
      continue;
    }

    // Account sections -> vtexAccountLoaders
    if (isVtex && meta.isAccountSection) {
      const loaderName = getAccountLoaderName(basename);
      entries.push(`  // Account: ${basename}`);
      entries.push(`  "${sectionKey}": vtexAccountLoaders.${loaderName}(),`);
      continue;
    }

    // Header: compose device + search param
    if (meta.isHeader) {
      entries.push(`  // Header: device + search param`);
      entries.push(`  "${sectionKey}": compose(withDevice(), withSearchParam()),`);
      continue;
    }

    // Simple mixins
    if (meta.loaderUsesDevice && meta.loaderUsesUrl) {
      const deviceMixin = meta.usesMobileBoolean ? "withMobile()" : "withDevice()";
      entries.push(`  // ${meta.path}: ${meta.usesMobileBoolean ? "mobile" : "device"} + URL`);
      entries.push(`  "${sectionKey}": compose(${deviceMixin}, withSearchParam()),`);
    } else if (meta.loaderUsesDevice) {
      if (meta.usesMobileBoolean) {
        entries.push(`  // ${meta.path}: mobile detection`);
        entries.push(`  "${sectionKey}": withMobile(),`);
      } else {
        entries.push(`  // ${meta.path}: device detection`);
        entries.push(`  "${sectionKey}": withDevice(),`);
      }
    } else if (meta.loaderUsesUrl) {
      entries.push(`  // ${meta.path}: URL/search params`);
      entries.push(`  "${sectionKey}": withSearchParam(),`);
    } else {
      // Complex loader — delegate to the section's own loader export
      const importPath = `~/` + meta.path.replace(/\.tsx?$/, "");
      entries.push(`  // ${meta.path}: complex loader — delegated to section's loader export`);
      entries.push(`  "${sectionKey}": async (props: any, req: Request) => {`);
      entries.push(`    const mod = await import("${importPath}");`);
      entries.push(`    if (typeof mod.loader === "function") return mod.loader(props, req);`);
      entries.push(`    return props;`);
      entries.push(`  },`);
    }
  }

  lines.push(`registerSectionLoaders({`);
  lines.push(entries.join("\n"));
  lines.push(`});`);

  return lines.join("\n") + "\n";
}
