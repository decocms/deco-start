import type { MigrationContext } from "../types.ts";

function hasLoaderByName(ctx: MigrationContext, name: string): boolean {
  return ctx.loaderInventory.some(
    (l) => l.path.toLowerCase().includes(name.toLowerCase()),
  );
}

export function generateCommerceLoaders(ctx: MigrationContext): string {
  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * Commerce Loaders — data fetchers registered for CMS block resolution.`);
  lines.push(` *`);
  lines.push(` * Standard VTEX loaders come from createVtexCommerceLoaders().`);
  lines.push(` * Custom loaders use dynamic imports to the migrated loader files.`);
  lines.push(` */`);

  if (ctx.platform === "vtex") {
    lines.push(`import { createVtexCommerceLoaders, createCachedPDPLoader } from "@decocms/apps/vtex/commerceLoaders";`);
    lines.push(`import { createCachedLoader } from "@decocms/start/sdk/cachedLoader";`);
    lines.push(`import { createAddressFromRequest, updateAddressFromRequest, deleteAddressFromRequest } from "@decocms/apps/vtex/actions/address";`);
    lines.push(`import { getAddressByPostalCode } from "@decocms/apps/vtex/loaders/address";`);
    lines.push(`import { updateProfileFromRequest, newsletterProfileFromRequest } from "@decocms/apps/vtex/actions/profile";`);
    lines.push(`import { deletePaymentFromRequest } from "@decocms/apps/vtex/actions/payments";`);
    lines.push(`import { getPasswordLastUpdate } from "@decocms/apps/vtex/loaders/profile";`);
    lines.push(``);
    lines.push(`export const vtexLoaders = createVtexCommerceLoaders();`);
    lines.push(`export const cachedPDP = createCachedPDPLoader();`);
    lines.push(``);
  }

  lines.push(`export const COMMERCE_LOADERS: Record<string, (props: any) => Promise<any>> = {`);

  if (ctx.platform === "vtex") {
    lines.push(`  ...vtexLoaders,`);
    lines.push(``);

    // Generic VTEX address actions
    lines.push(`  // VTEX Address CRUD`);
    lines.push(`  "vtex/actions/address/createAddress": createAddressFromRequest,`);
    lines.push(`  "vtex/actions/address/updateAddress": updateAddressFromRequest,`);
    lines.push(`  "vtex/actions/address/deleteAddress": deleteAddressFromRequest,`);
    lines.push(`  "vtex/loaders/address/getAddressByZIP": async (props: any) => {`);
    lines.push(`    return getAddressByPostalCode(props.countryCode ?? "BRA", props.postalCode);`);
    lines.push(`  },`);
    lines.push(``);

    // Generic VTEX profile actions
    lines.push(`  // VTEX Profile actions`);
    lines.push(`  "vtex/actions/profile/updateProfile": updateProfileFromRequest,`);
    lines.push(`  "vtex/actions/profile/updateProfile.ts": updateProfileFromRequest,`);
    lines.push(`  "vtex/actions/profile/newsletterProfile": newsletterProfileFromRequest,`);
    lines.push(`  "vtex/actions/profile/newsletterProfile.ts": newsletterProfileFromRequest,`);
    lines.push(``);

    // Generic VTEX payment actions
    lines.push(`  // VTEX Payment actions`);
    lines.push(`  "vtex/actions/payments/delete": deletePaymentFromRequest,`);
    lines.push(``);

    // Generic VTEX profile loaders
    lines.push(`  // VTEX Profile loaders`);
    lines.push(`  "vtex/loaders/profile/passwordLastUpdate": getPasswordLastUpdate,`);
    lines.push(``);

    // Auth cookie stripping wrapper
    if (hasLoaderByName(ctx, "vtex-auth-loader")) {
      lines.push(`  // Auth loader with cookie domain stripping for Workers`);
      lines.push(`  "site/loaders/vtex-auth-loader": async (props: any) => {`);
      lines.push(`    const mod = await import("../loaders/vtex-auth-loader");`);
      lines.push(`    const result = await mod.default(props);`);
      lines.push(`    if (result instanceof Response) {`);
      lines.push(`      const headers = new Headers(result.headers);`);
      lines.push(`      const cookies = headers.getSetCookie?.() ?? [];`);
      lines.push(`      const stripped = cookies.map((c: string) => c.replace(/Domain=[^;]*/i, ""));`);
      lines.push(`      headers.delete("Set-Cookie");`);
      lines.push(`      stripped.forEach((c: string) => headers.append("Set-Cookie", c));`);
      lines.push(`      return new Response(result.body, { status: result.status, headers });`);
      lines.push(`    }`);
      lines.push(`    return result;`);
      lines.push(`  },`);
      lines.push(``);
    }

    // Cached autocomplete alias
    if (hasLoaderByName(ctx, "intelligenseSearch") || hasLoaderByName(ctx, "intelligentSearch")) {
      lines.push(`  // Cached autocomplete search alias`);
      lines.push(`  "site/loaders/search/intelligenseSearch.ts": createCachedLoader(`);
      lines.push(`    "vtex/autocomplete",`);
      lines.push(`    vtexLoaders["vtex/loaders/intelligentSearch/autocomplete"] as any,`);
      lines.push(`    "search",`);
      lines.push(`  ),`);
      lines.push(``);
    }
  }

  // Add custom loaders from inventory
  for (const loader of ctx.loaderInventory) {
    if (!loader.isCustom) continue;

    const siteKey = `site/${loader.path}`;
    const importPath = `../${loader.path}`.replace(/\.tsx?$/, "");

    lines.push(`  // Custom: ${loader.path}`);
    lines.push(`  "${siteKey}": async (props: any) => {`);
    lines.push(`    const mod = await import("${importPath}");`);
    lines.push(`    return mod.default(props);`);
    lines.push(`  },`);

    // Also add without extension
    const siteKeyNoExt = siteKey.replace(/\.tsx?$/, "");
    if (siteKeyNoExt !== siteKey) {
      lines.push(`  "${siteKeyNoExt}": async (props: any) => {`);
      lines.push(`    const mod = await import("${importPath}");`);
      lines.push(`    return mod.default(props);`);
      lines.push(`  },`);
    }
  }

  lines.push(`};`);

  return lines.join("\n") + "\n";
}
