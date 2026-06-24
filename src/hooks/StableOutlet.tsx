import { useEffect, useRef, useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";

/**
 * Preserves the content area height during SPA navigation so the
 * footer doesn't jump up while the new page is loading.
 */
export function StableOutlet() {
	const isLoading = useRouterState({ select: (s) => s.isLoading });
	const ref = useRef<HTMLDivElement>(null);
	// State (not a ref) so clearing the height when navigation completes
	// triggers a re-render that removes the min-height. With a ref the reset
	// never re-rendered, so the previous (taller) page's height stayed pinned
	// — leaving a large gap below the footer on tall→short navigation (#279).
	const [savedHeight, setSavedHeight] = useState<number | undefined>(undefined);

	useEffect(() => {
		if (isLoading && ref.current) {
			setSavedHeight(ref.current.offsetHeight);
		} else if (!isLoading) {
			setSavedHeight(undefined);
		}
	}, [isLoading]);

	return (
		<div ref={ref} style={savedHeight ? { minHeight: savedHeight } : undefined}>
			<Outlet />
		</div>
	);
}
