# Gap Analysis: deco-cx/deco vs @decocms/start

Feature-by-feature comparison with implementation status and roadmap.

## Status Summary

| Status | Count | Meaning |
|--------|-------|---------|
| PORTED | 24 | Fully implemented and working |
| PARTIAL | 5 | Exists but incomplete |
| MISSING | 4 | Not yet ported |
| NOT NEEDED | 4 | Architectural difference |

## Feature Comparison Table

| # | Feature | Status |
|---|---------|--------|
| 1 | Resolution engine | PORTED (generic resolver with memoization, depth protection, DanglingReference handler, select support) |
| 2 | Sections | PORTED (registry + DecoPageRenderer) |
| 3 | Loaders | PORTED (registerCommerceLoader) |
| 4 | Actions | PORTED (via invoke handler) |
| 5 | Handlers | NOT NEEDED (TanStack Router) |
| 6 | Flags | PORTED (multivariate in resolve.ts) |
| 7 | Matchers | PORTED (12 matchers registered) |
| 8 | Apps | NOT NEEDED (npm packages) |
| 9 | Workflows | MISSING |
| 10 | /live/invoke | PORTED |
| 11 | /deco/render | NOT NEEDED (TanStack Query) |
| 12 | /live/_meta | PORTED |
| 13 | /live/release | MISSING |
| 14 | /.decofile | PORTED |
| 15 | /live/inspect | MISSING |
| 16 | /live/previews | PORTED |
| 17 | /styles.css | NOT NEEDED (Vite) |
| 18 | /deco/_liveness + /deco/_health | PORTED (liveness + detailed health with uptime, memory, request counts, cache stats) |
| 19 | CORS middleware | PORTED |
| 20 | Cache-control | PORTED |
| 21 | Segment | PORTED |
| 22 | Observability | PORTED (TracerAdapter + MeterAdapter, named metrics, context propagation, request/cache recording) |
| 23 | useSection | PARTIAL (stub) |
| 24 | usePartialSection | PARTIAL (stub) |
| 25 | useScript | PORTED (with lightweight minification + LRU cache) |
| 26 | useDevice | PORTED (server-side via User-Agent + RequestContext, detectDevice, checkMobile/Tablet/Desktop) |
| 27 | useSetEarlyHints | MISSING |
| 28 | LiveControls | PORTED |
| 29 | SectionContext | MISSING |
| 30 | ErrorBoundary | PORTED |
| 31 | LazySection | PORTED |
| 32 | Schema generation | PORTED (dynamic registries for loaders + matchers, runtime composition) |
| 33 | Client invoke | PARTIAL (no withManifest, no SSE) |
| 34 | DecofileProvider | PORTED (revision tracking, onChange callbacks, hot-reload with cache invalidation) |
| 35 | Caching | PARTIAL (no LRU/Redis/tiered) |
| 36 | Edge caching | PORTED (unique to deco-start) |
| 37 | Manifest generation | PARTIAL (generate-blocks.ts) |

## Implemented Roadmap

### Tier 0 -- Production Blocking: ALL DONE
1. VTEX proxy routes
2. VTEX middleware (segment + login-aware cache)
3. Redirect system
4. Sitemap generation
5. SEO JSON-LD components

### Tier 1 -- Quality: ALL DONE
6. Segment-aware cache keys
7. Priority matchers (cookie, pathname, cron, host, queryString)
8. Top searches + search validator
9. Product extension pipeline
10. LazySection component
11. UTM param stripping + canonical URLs
12. wrapCaughtErrors
13. CSP headers
14. Cache-Control merge

### Tier 2 -- DX and Completeness: ALL DONE
15. Schema gen improvements
16. Client-side hooks (useCart, useUser, useWishlist) in apps-start
17. Image/Picture components in apps-start
18. RequestContext (AsyncLocalStorage)
19. Commerce loader request context
20. Remaining VTEX loaders in apps-start
21. Admin schema composition (composeMeta)

### Tier 2.5 -- Framework Improvements (PR #3): ALL DONE
22. Dynamic schema registries (loaders + matchers) — no more hardcoded KNOWN_LOADERS
23. Generic recursive resolver with memoization, depth protection, DanglingReference
24. useDevice server-side (User-Agent + RequestContext)
25. Health probe `/deco/_health` with uptime, memory, cache stats, request metrics
26. Enhanced observability: MeterAdapter, MetricNames, context propagation
27. Enhanced invoke: FormData/URLEncoded parsing, `?select=`, actions, nested `__resolveType`
28. Decofile revision tracking + onChange listeners + meta auto-invalidation
29. useScript minification + LRU cache

### Tier 3 -- Future / Deferred
30. Admin live preview (WebSocket)
31. Hot reload authenticated endpoint
32. SSE streaming reader
33. sectionMiddleware / transformProps
34. Shopify draft order, proxy routes
35. Geo/location matchers

## Intentional Divergences

| deco-cx/deco | @decocms/start | Reason |
|-------------|----------------|--------|
| Section loader/action exports | Pure React components | Idiomatic React |
| HTMX partials | TanStack Query + Router | React reconciliation |
| Fresh islands | Full React SPA + SSR | TanStack Start model |
| Deno runtime | Node.js / CF Workers | Deployment target |
| Import maps | npm packages | Standard resolution |
| Global fetch monkey-patch | Explicit instrumented fetch | Predictable |
| Per-loader Vary | Segment cache keys | Simpler, CF Cache API |

## Unique to @decocms/start

| Feature | Description |
|---------|-------------|
| Cloudflare Workers | createDecoWorkerEntry with Cache API |
| Edge caching profiles | detectCacheProfile, URL-based TTL rules |
| invokeQueryOptions | TanStack Query integration |
| LazySection (IntersectionObserver) | Client-side lazy loading |
| PostHog matchers | Server-side feature flags |
| Sitemap/Redirects SDK | Built-in utilities |
| Dynamic schema registries | Runtime loader/matcher registration (no hardcoded lists) |
| Health metrics endpoint | `/deco/_health` with uptime, memory, cache stats |
| Pluggable MeterAdapter | Counter/gauge/histogram abstraction for any metrics backend |
| useScript minification | Lightweight JS minification with LRU cache |
| Decofile revision tracking | Content-hash based revisions with onChange callbacks |
