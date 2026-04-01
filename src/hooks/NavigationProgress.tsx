import { useRouterState } from "@tanstack/react-router";

const PROGRESS_CSS = `
@keyframes progressSlide { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.nav-progress-bar { animation: progressSlide 1s ease-in-out infinite; }
`;

/**
 * Top-of-page loading bar that appears during SPA navigation.
 * Uses the router's isLoading state — no extra dependencies.
 */
export function NavigationProgress() {
	const isLoading = useRouterState({ select: (s) => s.isLoading });
	if (!isLoading) return null;
	return (
		<div className="fixed top-0 left-0 right-0 z-[9999] h-1 bg-brand-primary-500/20 overflow-hidden">
			<style dangerouslySetInnerHTML={{ __html: PROGRESS_CSS }} />
			<div className="nav-progress-bar h-full w-1/3 bg-brand-primary-500 rounded-full" />
		</div>
	);
}
