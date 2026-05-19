import { useEffect, type ReactNode } from "react";
import { HeadContent, Scripts, ScriptOnce } from "@tanstack/react-router";
import { LiveControls } from "./LiveControls";
import { ANALYTICS_SCRIPT } from "../sdk/analytics";
import { NavigationProgress } from "./NavigationProgress";
import { StableOutlet } from "./StableOutlet";

declare global {
	interface Window {
		__deco_ready?: boolean;
	}
}

function buildDecoEventsBootstrap(account?: string): string {
	const accountJson = JSON.stringify(account ?? "");
	return `
window.__RUNTIME__ = window.__RUNTIME__ || { account: ${accountJson} };
window.DECO = window.DECO || {};
window.DECO.events = window.DECO.events || {
  _q: [],
  _subs: [],
  dispatch: function(e) {
    this._q.push(e);
    for (var i = 0; i < this._subs.length; i++) {
      try { this._subs[i](e); } catch(err) { console.error('[DECO.events]', err); }
    }
  },
  subscribe: function(fn) {
    this._subs.push(fn);
    for (var i = 0; i < this._q.length; i++) {
      try { fn(this._q[i]); } catch(err) {}
    }
  }
};
window.dataLayer = window.dataLayer || [];
`;
}

export interface DecoRootLayoutProps {
	/** Language attribute for the <html> tag. Default: "en" */
	lang?: string;
	/** DaisyUI data-theme attribute. Default: "light" */
	dataTheme?: string;
	/** Site name for LiveControls (admin iframe communication). Required. */
	siteName: string;
	/** Commerce platform account name for analytics bootstrap (e.g. VTEX account). */
	account?: string;
	/** CSS class for <body>. Default: "bg-base-200 text-base-content" */
	bodyClassName?: string;
	/** Delay in ms before firing deco:ready event. Default: 500 */
	decoReadyDelay?: number;
	/**
	 * Extra content rendered inside <body> after the main outlet
	 * (e.g. Toast, custom analytics components).
	 */
	children?: ReactNode;
}

/**
 * Standard Deco root layout component for use in __root.tsx.
 *
 * Provides:
 * - NavigationProgress (loading bar during SPA nav)
 * - StableOutlet (height-preserved content area)
 * - DECO.events bootstrap (via ScriptOnce — runs before hydration, once)
 * - LiveControls for admin
 * - Analytics script (via ScriptOnce)
 * - deco:ready hydration signal
 *
 * QueryClientProvider should be configured via createDecoRouter's `Wrap` option
 * (per TanStack docs — non-DOM providers go on the router, not in components).
 *
 * Sites that need full control should compose from the individual exported
 * pieces (NavigationProgress, StableOutlet, etc.) instead.
 */
export function DecoRootLayout({
	lang = "en",
	dataTheme = "light",
	siteName,
	account,
	bodyClassName = "bg-base-200 text-base-content",
	decoReadyDelay = 500,
	children,
}: DecoRootLayoutProps) {
	useEffect(() => {
		const id = setTimeout(() => {
			window.__deco_ready = true;
			document.dispatchEvent(new Event("deco:ready"));
		}, decoReadyDelay);
		return () => clearTimeout(id);
	}, [decoReadyDelay]);

	return (
		<html lang={lang} data-theme={dataTheme} suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body className={bodyClassName} suppressHydrationWarning>
				<ScriptOnce children={buildDecoEventsBootstrap(account)} />
				<NavigationProgress />
				<main>
					<StableOutlet />
				</main>
				{children}
				<LiveControls site={siteName} />
				<ScriptOnce children={ANALYTICS_SCRIPT} />
				<Scripts />
			</body>
		</html>
	);
}
