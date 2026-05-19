/**
 * LazySection -- Intersection Observer-based deferred rendering.
 *
 * Wraps section content and defers rendering until the element scrolls
 * into view. Uses IntersectionObserver for zero-JS-cost detection and
 * renders a lightweight placeholder until the content is needed.
 *
 * For SSR: the placeholder is rendered server-side. On hydration,
 * the observer is set up and content loads when visible.
 *
 * @example
 * ```tsx
 * <LazySection fallback={<div style={{ height: 400 }} />}>
 *   <HeavyProductCarousel products={products} />
 * </LazySection>
 * ```
 */

import { type ReactNode, useEffect, useRef, useState } from "react";

export interface LazySectionProps {
  children: ReactNode;
  /**
   * Content shown before the section scrolls into view.
   * Should have a fixed height to prevent layout shifts.
   */
  fallback?: ReactNode;
  /**
   * IntersectionObserver rootMargin.
   * Positive values trigger loading before the element is visible.
   * @default "200px"
   */
  rootMargin?: string;
  /**
   * Minimum height for the wrapper div (prevents CLS).
   * Applied as CSS min-height.
   */
  minHeight?: string | number;
  /**
   * CSS class for the wrapper div.
   */
  className?: string;
  /**
   * If true, render the content immediately (bypass lazy loading).
   * Useful for sections above the fold.
   * @default false
   */
  eager?: boolean;
}

export function LazySection({
  children,
  fallback,
  rootMargin = "200px",
  minHeight,
  className,
  eager = false,
}: LazySectionProps) {
  const [isVisible, setVisible] = useState(eager);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (eager || isVisible) return;

    const element = ref.current;
    if (!element) return;

    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, isVisible, rootMargin]);

  const style: React.CSSProperties | undefined = minHeight
    ? { minHeight: typeof minHeight === "number" ? `${minHeight}px` : minHeight }
    : undefined;

  return (
    <div ref={ref} className={className} style={style}>
      {isVisible ? children : (fallback ?? null)}
    </div>
  );
}

/**
 * Determine if a section index is "below the fold" and should be lazy-loaded.
 *
 * Used by DecoPageRenderer to auto-wrap distant sections.
 *
 * @param index - Zero-based section index on the page
 * @param foldThreshold - Sections at or above this index render eagerly
 * @default foldThreshold = 3
 */
export function isBelowFold(index: number, foldThreshold = 3): boolean {
  return index >= foldThreshold;
}
