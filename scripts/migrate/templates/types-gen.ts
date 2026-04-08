import type { MigrationContext } from "../types.ts";

export function generateTypeFiles(ctx: MigrationContext): Record<string, string> {
  const files: Record<string, string> = {};

  files["src/types/widgets.ts"] = `export type ImageWidget = string;
export type HTMLWidget = string;
export type VideoWidget = string;
export type TextWidget = string;
export type RichText = string;
export type Secret = string;
export type Color = string;
export type ButtonWidget = string;
`;

  files["src/types/deco.ts"] = `export type SectionProps<T extends (...args: any[]) => any> = Awaited<
  ReturnType<T>
>;

export type Resolved<T = any> = T;

export type Section = any;

export type Block = any;

export type LoadingFallbackProps = {
  height?: number;
};

export function asResolved<T>(value: T): T {
  return value;
}

export function isDeferred(value: unknown): boolean {
  return false;
}

export const context = {
  isDeploy: false,
  platform: "tanstack-start" as const,
  site: "${ctx.siteName}",
  siteId: 0,
};

export function redirect(_url: string, _status?: number): never {
  throw new Error("redirect is not supported in TanStack Start -- use router navigation instead");
}
`;

  files["src/types/commerce-app.ts"] = `export type AppContext = {
  device: "mobile" | "desktop" | "tablet";
};
`;

  // Compat shim for apps/website/loaders/extension.ts
  files["src/types/website.ts"] = `export type ExtensionOf<T = any> = T;
`;

  if (ctx.platform === "vtex") {
    const vtexAccount = ctx.vtexAccount || ctx.siteName;
    files["src/types/vtex-app.ts"] = `export interface VtexConfig {
  account: string;
  publicUrl?: string;
}

export interface AppInvoke {
  vtex: {
    loaders: {
      user: (props: Record<string, unknown>) => Promise<any>;
      address: { list: (props: Record<string, unknown>) => Promise<any> };
      payments: { userPayments: (props: Record<string, unknown>) => Promise<any> };
      intelligentSearch: {
        productList: (props: any) => Promise<any>;
        productListingPage: (props: any) => Promise<any>;
      };
      [key: string]: any;
    };
    actions: {
      payments: { delete: (props: { id: string }) => Promise<any> };
      [key: string]: any;
    };
    [key: string]: any;
  };
  site: {
    loaders: {
      Wishlist: Record<string, (props: any) => Promise<any>>;
      [key: string]: any;
    };
    [key: string]: any;
  };
  [key: string]: any;
}

export type AppContext = {
  device: "mobile" | "desktop" | "tablet";
  platform: "vtex";
  account: string;
  invoke: AppInvoke;
  [key: string]: unknown;
};

export type LegacyAppContext = AppContext;
`;

    files["src/types/vtex-loaders.ts"] = `import type { Product, ProductListingPage } from "@decocms/apps/commerce/types";

export interface ProductListProps {
  page: ProductListingPage | null;
}

export interface ProductDetailsProps {
  page: {
    product: Product;
    seo?: { title?: string; description?: string; canonical?: string };
  } | null;
}

export interface SearchProps {
  query?: string;
  page?: number;
  sort?: string;
  filters?: Record<string, string>;
}

export type LabelledFuzzy = "disabled" | "automatic" | "always";

export function mapLabelledFuzzyToFuzzy(fuzzy: LabelledFuzzy): string {
  const mapping: Record<LabelledFuzzy, string> = { disabled: "0", automatic: "auto", always: "1" };
  return mapping[fuzzy] ?? "0";
}

/** Props type compatible with intelligentSearch/productListingPage loader */
export interface PLPProps {
  query?: string;
  page?: number;
  count?: number;
  sort?: string;
  selectedFacets?: Array<{ key: string; value: string }>;
  fuzzy?: LabelledFuzzy;
  hideUnavailableItems?: boolean;
  [key: string]: unknown;
}
`;

    files["src/types/vtex-actions.ts"] = `export interface UserMutation {
  firstName?: string;
  lastName?: string;
  email?: string;
  document?: string;
  phone?: string;
  gender?: string;
  birthDate?: string;
  corporateName?: string;
  corporateDocument?: string;
  stateRegistration?: string;
  isCorporate?: boolean;
}

export interface AddressMutation {
  addressName?: string;
  addressType?: string;
  postalCode?: string;
  street?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  country?: string;
  receiverName?: string;
  reference?: string;
}
`;
  }

  return files;
}
