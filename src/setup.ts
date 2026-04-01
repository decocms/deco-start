/**
 * One-call site bootstrap that composes framework registration functions.
 *
 * Sites pass their Vite-resolved globs, generated blocks, meta, CSS, fonts,
 * and optional platform hooks. createSiteSetup wires them into the CMS engine,
 * admin protocol, matchers, and rendering infrastructure.
 *
 * Everything site-specific (section loaders, cacheable sections, async rendering,
 * layout sections, commerce loaders, sync sections) remains in the site's own
 * setup file — createSiteSetup only handles the framework-generic wiring.
 */

import {
	loadBlocks,
	onBeforeResolve,
	registerSections,
	setBlocks,
	setDanglingReferenceHandler,
	setResolveErrorHandler,
} from "./cms/index";
import { registerBuiltinMatchers } from "./matchers/builtins";
import { registerProductionOrigins } from "./sdk/normalizeUrls";
import {
	setInvokeLoaders,
	setMetaData,
	setPreviewWrapper,
	setRenderShell,
} from "./admin/index";

export interface SiteSetupOptions {
	/**
	 * Section glob from Vite — pass `import.meta.glob("./sections/**\/*.tsx")`.
	 * Keys are transformed from `./sections/X.tsx` → `site/sections/X.tsx`.
	 */
	sections: Record<string, () => Promise<any>>;

	/**
	 * Generated blocks object — import and pass directly:
	 * `import { blocks } from "./server/cms/blocks.gen";`
	 */
	blocks: Record<string, unknown>;

	/**
	 * Lazy loader for admin meta schema — only fetched when admin requests it:
	 * `() => import("./server/admin/meta.gen.json").then(m => m.default)`
	 */
	meta: () => Promise<any>;

	/** CSS file URL from Vite `?url` import. */
	css: string;

	/** Font URLs to preload in admin preview shell. */
	fonts?: string[];

	/** Production origins for URL normalization. */
	productionOrigins?: string[];

	/**
	 * Custom matcher registrations to run alongside builtins.
	 * Each function is called once during setup.
	 */
	customMatchers?: Array<() => void>;

	/** Preview wrapper component for admin preview iframe. */
	previewWrapper?: React.ComponentType<any>;

	/** Error handler for CMS resolution errors. */
	onResolveError?: (
		error: unknown,
		resolveType: string,
		context: string,
	) => void;

	/** Handler for dangling CMS references (missing __resolveType targets). */
	onDanglingReference?: (resolveType: string) => any;

	/**
	 * Called after blocks are loaded — use for platform initialization.
	 * Also called on every onBeforeResolve (decofile hot-reload).
	 *
	 * @example
	 * ```ts
	 * import { initVtexFromBlocks } from "@decocms/apps/vtex";
	 * { initPlatform: (blocks) => initVtexFromBlocks(blocks) }
	 * ```
	 */
	initPlatform?: (blocks: any) => void;

	/**
	 * Commerce loaders getter — passed to `setInvokeLoaders`.
	 * Use a thunk so the full map (including site-specific loaders
	 * defined after createSiteSetup) is captured.
	 *
	 * @example
	 * ```ts
	 * { getCommerceLoaders: () => COMMERCE_LOADERS }
	 * ```
	 */
	getCommerceLoaders?: () => Record<string, (props: any) => Promise<any>>;
}

/**
 * Bootstrap a Deco site — registers sections, matchers, blocks, meta,
 * render shell, preview wrapper, error handlers, and platform hooks.
 *
 * Call once at the top of your `setup.ts`, before site-specific registrations.
 *
 * @example
 * ```ts
 * import "./cache-config";
 * import { createSiteSetup } from "@decocms/start/setup";
 * import { blocks } from "./server/cms/blocks.gen";
 * import PreviewProviders from "./components/PreviewProviders";
 * import appCss from "./styles/app.css?url";
 * import { initVtexFromBlocks } from "@decocms/apps/vtex";
 *
 * createSiteSetup({
 *   sections: import.meta.glob("./sections/**\/*.tsx"),
 *   blocks,
 *   meta: () => import("./server/admin/meta.gen.json").then(m => m.default),
 *   css: appCss,
 *   fonts: ["/fonts/Lato-Regular.woff2", "/fonts/Lato-Bold.woff2"],
 *   productionOrigins: ["https://www.example.com"],
 *   previewWrapper: PreviewProviders,
 *   initPlatform: (blocks) => initVtexFromBlocks(blocks),
 * });
 * ```
 */
export function createSiteSetup(options: SiteSetupOptions): void {
	// 1. Error handlers (set first so they catch issues during registration)
	if (options.onResolveError) {
		setResolveErrorHandler(options.onResolveError);
	}
	if (options.onDanglingReference) {
		setDanglingReferenceHandler(options.onDanglingReference);
	}

	// 2. Section glob registration — transform Vite paths to CMS keys
	const sections: Record<string, () => Promise<any>> = {};
	for (const [path, loader] of Object.entries(options.sections)) {
		sections[`site/${path.slice(2)}`] = loader;
	}
	registerSections(sections);

	// 3. Matchers
	registerBuiltinMatchers();
	if (options.customMatchers) {
		for (const register of options.customMatchers) {
			register();
		}
	}

	// 4. Production origins
	if (options.productionOrigins?.length) {
		registerProductionOrigins(options.productionOrigins);
	}

	// 5. Blocks + platform init (server-only)
	if (typeof document === "undefined") {
		setBlocks(options.blocks);
		if (options.initPlatform) {
			options.initPlatform(loadBlocks());
		}
	}

	// 6. onBeforeResolve — re-init platform on decofile hot-reload
	if (options.initPlatform) {
		const init = options.initPlatform;
		onBeforeResolve(() => {
			init(loadBlocks());
		});
	}

	// 7. Admin meta schema (lazy)
	options.meta().then((data) => setMetaData(data));

	// 8. Render shell
	setRenderShell({
		css: options.css,
		fonts: options.fonts,
	});

	// 9. Preview wrapper
	if (options.previewWrapper) {
		setPreviewWrapper(options.previewWrapper);
	}

	// 10. Commerce loaders → invoke
	if (options.getCommerceLoaders) {
		setInvokeLoaders(options.getCommerceLoaders);
	}
}
