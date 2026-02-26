import type { ComponentType } from "react";

export type SectionModule = {
  default: ComponentType<any>;
  loader?: (props: any) => Promise<any> | any;
  LoadingFallback?: ComponentType<any>;
};

type RegistryEntry = () => Promise<SectionModule>;

const registry: Record<string, RegistryEntry> = {
  // Images
  "site/sections/Images/Carousel.tsx": () =>
    import("../../sections/Images/Carousel"),
  "site/sections/Images/Banner.tsx": () =>
    import("../../sections/Images/Banner"),
  "site/sections/Images/ImageGallery.tsx": () =>
    import("../../sections/Images/Banner"), // stub: reuse Banner
  "site/sections/Images/ShoppableBanner.tsx": () =>
    import("../../sections/Images/Banner"), // stub: reuse Banner

  // Content
  "site/sections/Content/Hero.tsx": () =>
    import("../../sections/Content/Hero"),
  "site/sections/Content/Faq.tsx": () =>
    import("../../sections/Content/Faq"),
  "site/sections/Content/Intro.tsx": () =>
    import("../../sections/Content/Intro"),
  "site/sections/Content/Logos.tsx": () =>
    import("../../sections/Content/Logos"),

  // Product
  "site/sections/Product/ProductShelf.tsx": () =>
    import("../../sections/Product/ProductShelf"),
  "site/sections/Product/ProductShelfTabbed.tsx": () =>
    import("../../sections/Product/ProductShelfTabbed"),
  "site/sections/Product/ProductDetails.tsx": () =>
    import("../../sections/Product/ProductDetails"),
  "site/sections/Product/SearchResult.tsx": () =>
    import("../../sections/Product/SearchResult"),

  // Category
  "site/sections/Category/CategoryGrid.tsx": () =>
    import("../../sections/Category/CategoryGrid"),
  "site/sections/Category/CategoryBanner.tsx": () =>
    import("../../sections/Images/Banner"), // stub: reuse Banner

  // Layout
  "site/sections/Header/Header.tsx": () =>
    import("../../sections/Header/Header"),
  "site/sections/Footer/Footer.tsx": () =>
    import("../../sections/Footer/Footer"),

  // Theme & Session (no-ops in TanStack)
  "site/sections/Theme/Theme.tsx": () =>
    import("../../sections/Theme/Theme"),
  "site/sections/Session.tsx": () =>
    import("../../sections/Session"),

  // Misc
  "site/sections/Newsletter/Newsletter.tsx": () =>
    import("../../sections/Newsletter/Newsletter"),
  "site/sections/Social/WhatsApp.tsx": () =>
    import("../../sections/Social/WhatsApp"),
  "site/sections/Miscellaneous/CookieConsent.tsx": () =>
    import("../../sections/Miscellaneous/CookieConsent"),
  "site/sections/Miscellaneous/CampaignTimer.tsx": () =>
    import("../../sections/Miscellaneous/CookieConsent"), // stub

  // Animation
  "site/sections/Animation/Animation.tsx": () =>
    import("../../sections/Theme/Theme"), // stub: no-op

  // Links
  "site/sections/Links/LinkTree.tsx": () =>
    import("../../sections/Content/Intro"), // stub
};

export function getSection(resolveType: string): RegistryEntry | undefined {
  return registry[resolveType];
}

export function listRegisteredSections(): string[] {
  return Object.keys(registry);
}
