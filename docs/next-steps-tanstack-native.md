# Proximos Passos — TanStack Native Patterns

> O que falta implementar no `@decocms/start` para usar o potencial completo do TanStack Router/Start.
> Ordenado por impacto e prioridade.

---

## Status Atual

| Pattern | Status | Onde |
|---------|--------|------|
| `<Await>` + deferred streaming | ✅ Feito | `DecoPageRenderer.tsx`, `cmsRoute.ts` |
| `createServerFn()` | ✅ Feito | `cmsRoute.ts` |
| `pendingComponent` | ✅ Feito | `cmsRouteConfig` |
| `ClientOnly` | ❌ Nao usado | — |
| `useHydrated` | ❌ Nao usado | — |
| `createIsomorphicFn` | ❌ Nao usado | — |
| `pendingMs` / `pendingMinMs` | ❌ Nao configurado | — |
| Preload/Prefetch strategies | ❌ Nao configurado | — |
| `ssr: 'data-only'` | ❌ Nao usado | — |
| `useScript(fn)` deprecation | ⚠️ Parcial | `sdk/useScript.ts` |
| `clientOnly` sections | ❌ Nao implementado | — |
| Dev warnings | ⚠️ Parcial | `DecoPageRenderer.tsx` |

---

## P0 — Alta Prioridade

### 1. `<ClientOnly>` para sections analytics/third-party

**Problema**: Scripts de analytics (GTM, Emarsys, Sourei) injetados no `<head>` quebram hydration (P4 do doc original). `useScript(fn)` gera hydration mismatch (P3).

**Solucao**: Usar `<ClientOnly>` do TanStack Router para wrapping automatico.

**Arquivos**:
- `src/cms/registry.ts` — adicionar opcao `clientOnly` em `registerSection()` e `registerSectionsSync()`
- `src/hooks/DecoPageRenderer.tsx` — wrapping automatico com `<ClientOnly>` quando section marcada

```tsx
// registry.ts
registerSection("site/sections/Sourei/Sourei.tsx", SoureiModule, {
  clientOnly: true,
  loadingFallback: () => null,
});

// DecoPageRenderer.tsx — render path
import { ClientOnly } from "@tanstack/react-router";

if (sectionOptions?.clientOnly) {
  return (
    <ClientOnly fallback={sectionOptions.loadingFallback?.() ?? null}>
      <LazyComponent {...section.props} />
    </ClientOnly>
  );
}
```

**Impacto**: Elimina P3 e P4 do doc de migracao sem mudanca no site.

---

### 2. `inlineScript(str)` helper — substituir `useScript(fn)`

**Problema**: `useScript(fn)` usa `fn.toString()` que gera output diferente no SSR vs client (Vite compila separado). Causa hydration mismatch no `dangerouslySetInnerHTML.__html`.

**Solucao**: Deprecar `useScript(fn)`, adicionar `inlineScript(str)` que aceita string constante.

**Arquivo**: `src/sdk/useScript.ts`

```tsx
/** @deprecated fn.toString() differs SSR vs client. Use inlineScript(str) instead. */
export function useScript(fn: Function, ...args: unknown[]): string {
  if (import.meta.env?.DEV) {
    console.warn(
      `[useScript] fn.toString() for "${fn.name || 'anonymous'}" may cause hydration mismatch. ` +
      `Use inlineScript() with a plain string constant instead.`
    );
  }
  // ... existing implementation
}

/** Safe inline script — returns props for <script> element. */
export function inlineScript(js: string) {
  return { dangerouslySetInnerHTML: { __html: js } } as const;
}
```

**Impacto**: Resolve P3 para novos usos. Warning guia migracao de usos existentes.

---

### 3. `useHydrated()` para substituir `typeof document === "undefined"`

**Problema**: Varios locais usam `typeof document === "undefined"` para detectar SSR. Isso e fragil e nao e reativo.

**Solucao**: Re-exportar `useHydrated` do TanStack Router como parte do SDK.

**Arquivo**: `src/sdk/useHydrated.ts` (novo)

```tsx
export { useHydrated } from "@tanstack/react-router";
```

**Arquivos afetados**:
- `src/hooks/DecoPageRenderer.tsx:248` — `const isSSR = typeof document === "undefined"` → `const hydrated = useHydrated()`
- `src/hooks/DecoPageRenderer.tsx:242` — useState initializer

**Impacto**: Pattern mais robusto e alinhado com TanStack.

---

## P1 — Media Prioridade

### 4. `pendingMs` e `pendingMinMs` em `CmsRouteOptions`

**Problema**: Sem configuracao de delay, o `pendingComponent` (skeleton) aparece imediatamente em toda navegacao SPA, mesmo quando o cache hit e instantaneo. Causa flash desnecessario.

**Solucao**: Expor `pendingMs` e `pendingMinMs` no route config.

**Arquivo**: `src/routes/cmsRoute.ts`

```tsx
export interface CmsRouteOptions {
  // ... existing
  /** Delay (ms) before showing pendingComponent. Default: 200 */
  pendingMs?: number;
  /** Minimum display time (ms) for pendingComponent once shown. Default: 300 */
  pendingMinMs?: number;
}

// No return do cmsRouteConfig:
return {
  // ...
  pendingMs: options.pendingMs ?? 200,
  pendingMinMs: options.pendingMinMs ?? 300,
};
```

**Impacto**: UX mais suave — skeleton so aparece em loads lentos.

---

### 5. Preload/Prefetch strategy no route config

**Problema**: Nao ha prefetching configurado. Navegacao SPA sempre espera o loader rodar do zero.

**Solucao**: Documentar e configurar `defaultPreload: 'intent'` como recomendacao.

**Onde**: Documentacao + exemplo no site consumer.

```tsx
// No createRouter() do site:
const router = createRouter({
  defaultPreload: "intent",        // prefetch on hover
  defaultPreloadDelay: 50,         // 50ms antes de iniciar
  defaultPreloadStaleTime: 5 * 60 * 1000, // 5min = alinhado com staleTime do cmsRouteConfig
});
```

**Impacto**: Navegacao SPA fica instantanea quando usuario hovera links. Alinhado com staleTime do cache.

---

### 6. `createIsomorphicFn` para device detection

**Problema**: `useDevice()` e um hook React — nao pode ser usado em loaders. Device detection no loader usa header parsing manual.

**Solucao**: Criar versao isomorfica com `createIsomorphicFn`.

**Arquivo**: `src/sdk/useDevice.ts`

```tsx
import { createIsomorphicFn } from "@tanstack/react-start";

export const getDevice = createIsomorphicFn()
  .server(() => {
    const ua = getRequestHeader("user-agent") ?? "";
    return detectDevice(ua);
  })
  .client(() => {
    return window.innerWidth < 768 ? "mobile" : "desktop";
  });
```

**Impacto**: Device detection consistente em qualquer contexto (loader, component, middleware).

---

## P2 — Baixa Prioridade (mas valioso)

### 7. `ssr: 'data-only'` para rotas interativas

**Problema**: PDPs com zoom de imagem, seletor de variante, e muitos useEffects podem ter hydration lenta. O servidor renderiza HTML que sera descartado pelo client de qualquer forma.

**Solucao**: Permitir `ssr: 'data-only'` por rota no `cmsRouteConfig`.

**Arquivo**: `src/routes/cmsRoute.ts`

```tsx
export interface CmsRouteOptions {
  // ... existing
  /** SSR mode: true (default), 'data-only', or false */
  ssr?: boolean | 'data-only';
}

// No return:
return {
  ssr: options.ssr ?? true,
  // ...
};
```

**Caso de uso**: PDP carrega dados no server (precos, estoque), mas renderiza no client:
```tsx
export const Route = createFileRoute("/product/$slug")({
  ...cmsRouteConfig({ siteName: "Store", defaultTitle: "Product", ssr: "data-only" }),
  pendingComponent: PDPSkeleton,
});
```

**Impacto**: TTFB mais rapido para rotas complexas. Skeleton aparece imediatamente, dados ja carregados.

---

### 8. Dev warnings para misconfiguracao

**Problema**: Erros silenciosos — section eager sem `registerSectionsSync` renderiza em branco, section deferred sem LoadingFallback mostra skeleton generico.

**O que ja existe**: `DevMissingFallbackWarning` em `DecoPageRenderer.tsx`.

**O que falta**:

```tsx
// Em DecoPageRenderer.tsx — warn eager section sem sync registration
if (import.meta.env.DEV && section.type === "eager" && !getSyncComponent(section.component)) {
  console.warn(
    `[DecoPageRenderer] Section "${section.component}" is eager but not in registerSectionsSync(). ` +
    `This may cause blank content during hydration. Add it to registerSectionsSync() in setup.ts.`
  );
}

// Em useScript.ts — warn fn.toString() risk (ja descrito acima)
```

**Impacto**: DX melhor — erros aparecem cedo no dev ao inves de bugs sutis em prod.

---

### 9. Server function middleware para validacao

**Problema**: `loadDeferredSection` aceita `rawProps` sem validacao. Requests malformados podem causar erros inesperados nos section loaders.

**Solucao**: Usar `createMiddleware({ type: 'function' })` do TanStack Start para validar input.

```tsx
import { createMiddleware } from "@tanstack/react-start";

const validateSectionInput = createMiddleware({ type: "function" })
  .server(async ({ next, data }) => {
    if (!data?.component || typeof data.component !== "string") {
      throw new Error("Invalid section component");
    }
    return next();
  });

export const loadDeferredSection = createServerFn({ method: "POST" })
  .middleware([validateSectionInput])
  .handler(async (ctx) => { ... });
```

**Impacto**: Seguranca e robustez — previne erros obscuros de runtime.

---

### 10. Hydration context via middleware

**Problema**: Locale, timezone, e feature flags precisam ser consistentes entre SSR e client. Atualmente nao ha pattern padrao.

**Solucao**: Middleware que injeta contexto de hydration.

```tsx
// Site-level middleware
const hydrationContext = createMiddleware().server(async ({ request, next }) => {
  const locale = getCookie("locale") || request.headers.get("accept-language")?.split(",")[0] || "en-US";
  const tz = getCookie("tz") || "UTC";
  return next({ context: { locale, timeZone: tz } });
});
```

**Impacto**: Previne hydration mismatches de locale/timezone sem workarounds manuais.

---

## Ordem de Implementacao Recomendada

```
P0 (resolver problemas existentes):
  1. ClientOnly para sections analytics       → elimina P3/P4
  2. inlineScript(str) helper                 → substitui useScript(fn)
  3. Re-export useHydrated                    → pattern moderno

P1 (melhorar UX):
  4. pendingMs/pendingMinMs                   → sem flash em loads rapidos
  5. Documentar preload: 'intent'             → navegacao instantanea
  6. createIsomorphicFn para device           → device detection universal

P2 (refinamento):
  7. ssr: 'data-only' para PDPs              → TTFB rapido para rotas pesadas
  8. Dev warnings expandidos                  → DX melhor
  9. Middleware de validacao                   → seguranca
  10. Hydration context middleware            → locale/timezone consistente
```

---

## Referencia — Comandos TanStack CLI

```bash
# Pesquisar patterns
tanstack search-docs "ClientOnly" --library router --json
tanstack search-docs "useHydrated" --library router --json
tanstack search-docs "createIsomorphicFn" --library start --json
tanstack search-docs "pendingMs pendingMinMs" --library router --json
tanstack search-docs "preload intent viewport" --library router --json
tanstack search-docs "ssr data-only selective" --library start --json

# Ler docs especificos
tanstack doc router api/router/clientOnlyComponent --json
tanstack doc start framework/react/guide/selective-ssr --json
tanstack doc start framework/react/guide/execution-model --json
tanstack doc start framework/react/guide/middleware --json
tanstack doc router guide/preloading --json
```
