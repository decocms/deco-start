import { useEffect, useRef } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";

/**
 * Preserves the content area height during SPA navigation so the
 * footer doesn't jump up while the new page is loading.
 */
export function StableOutlet() {
	const isLoading = useRouterState({ select: (s) => s.isLoading });
	const ref = useRef<HTMLDivElement>(null);
	const savedHeight = useRef<number | undefined>(undefined);

	useEffect(() => {
		if (isLoading && ref.current) {
			savedHeight.current = ref.current.offsetHeight;
		}
		if (!isLoading) {
			savedHeight.current = undefined;
		}
	}, [isLoading]);

	return (
		<div
			ref={ref}
			style={savedHeight.current ? { minHeight: savedHeight.current } : undefined}
		>
			<Outlet />
		</div>
	);
}
