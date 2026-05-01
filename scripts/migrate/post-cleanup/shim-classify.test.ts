import { describe, expect, it } from "vitest";
import { classifyShimExports, type ClassifiedExport } from "./shim-classify";

function classMap(content: string): Record<string, ClassifiedExport["class"]> {
  return Object.fromEntries(
    classifyShimExports(content).map((e) => [e.name, e.class]),
  );
}

describe("classifyShimExports — single statement function bodies", () => {
  it("returns null → stub", () => {
    const code = `
      export function getSegmentFromBag(_req?: any): Record<string, unknown> | null {
        return null;
      }
    `;
    expect(classMap(code)).toEqual({ getSegmentFromBag: "stub" });
  });

  it("returns {} → stub", () => {
    const code = `
      export function getISCookiesFromBag(_req?: any): Record<string, string> {
        return {};
      }
    `;
    expect(classMap(code)).toEqual({ getISCookiesFromBag: "stub" });
  });

  it("returns [] → stub", () => {
    const code = `export function emptyList(): string[] { return []; }`;
    expect(classMap(code)).toEqual({ emptyList: "stub" });
  });

  it("returns empty string → stub", () => {
    const code = `export function emptyStr(): string { return ""; }`;
    expect(classMap(code)).toEqual({ emptyStr: "stub" });
  });

  it("identity cast (return x as T) → stub", () => {
    const code = `
      import type { Product } from "@decocms/apps/commerce/types";
      export function toProduct(vtexProduct: any): Product {
        return vtexProduct as Product;
      }
    `;
    expect(classMap(code)).toEqual({ toProduct: "stub" });
  });

  it("identity cast on member (return x.foo as T) → stub", () => {
    const code = `export function toThing(o: any): X { return o.payload as X; }`;
    expect(classMap(code)).toEqual({ toThing: "stub" });
  });

  it("unconditional throw → stub", () => {
    const code = `
      export function notImplemented(): never {
        throw new Error("not implemented");
      }
    `;
    expect(classMap(code)).toEqual({ notImplemented: "stub" });
  });

  it("returns non-empty value → functional", () => {
    const code = `export function answer(): number { return 42; }`;
    expect(classMap(code)).toEqual({ answer: "functional" });
  });

  it("returns non-identity expression → functional", () => {
    const code = `
      export function isFilterParam(key: string): boolean {
        return key.startsWith("filter.");
      }
    `;
    expect(classMap(code)).toEqual({ isFilterParam: "functional" });
  });

  it("multi-statement body → functional (default safe)", () => {
    const code = `
      export async function fetchSafe(input: string): Promise<Response> {
        const response = await fetch(input);
        if (!response.ok) {
          console.error(response.status);
        }
        return response;
      }
    `;
    expect(classMap(code)).toEqual({ fetchSafe: "functional" });
  });

  it("body with nested blocks → functional", () => {
    const code = `
      export function withDefaultParams(params: any, defaults?: any): any {
        if (params instanceof URLSearchParams) {
          if (defaults) {
            for (const [key, value] of Object.entries(defaults)) {
              if (!params.has(key)) {
                params.set(key, value);
              }
            }
          }
          return params;
        }
        return { ...params, ...defaults };
      }
    `;
    expect(classMap(code)).toEqual({ withDefaultParams: "functional" });
  });

  it("comments before return → still classified by content", () => {
    const code = `
      export function stubWithComment(): null {
        // Intentionally a stub — see migration notes.
        return null;
      }
    `;
    expect(classMap(code)).toEqual({ stubWithComment: "stub" });
  });

  it("trailing semicolon optional", () => {
    const code = `export function noSemi(): null { return null }`;
    expect(classMap(code)).toEqual({ noSemi: "stub" });
  });
});

describe("classifyShimExports — async functions", () => {
  it("async returns null → stub", () => {
    const code = `export async function asyncStub(): Promise<null> { return null; }`;
    expect(classMap(code)).toEqual({ asyncStub: "stub" });
  });

  it("async with real work → functional", () => {
    const code = `
      export async function fetcher(): Promise<Response> {
        const r = await fetch("/x");
        return r;
      }
    `;
    expect(classMap(code)).toEqual({ fetcher: "functional" });
  });
});

describe("classifyShimExports — const arrow functions", () => {
  it("arrow returns null (block body) → stub", () => {
    const code = `export const noop = (): null => { return null; };`;
    expect(classMap(code)).toEqual({ noop: "stub" });
  });

  it("arrow returns null (expression body) → stub", () => {
    const code = `export const noop = (): null => null;`;
    expect(classMap(code)).toEqual({ noop: "stub" });
  });

  it("arrow returns empty object literal expression → stub", () => {
    const code = `export const noop = () => ({});`;
    expect(classMap(code)).toEqual({ noop: "stub" });
  });

  it("arrow with real expression → functional", () => {
    const code = `export const square = (n: number) => n * n;`;
    expect(classMap(code)).toEqual({ square: "functional" });
  });

  it("non-arrow const (object literal) → functional", () => {
    const code = `export const config = { account: "x" };`;
    expect(classMap(code)).toEqual({ config: "functional" });
  });
});

describe("classifyShimExports — type/interface declarations", () => {
  it("interface → type-only", () => {
    const code = `
      export interface VTEXCommerceStable {
        account: string;
        environment?: string;
      }
    `;
    expect(classMap(code)).toEqual({ VTEXCommerceStable: "type-only" });
  });

  it("type alias → type-only", () => {
    const code = `export type AccountId = string;`;
    expect(classMap(code)).toEqual({ AccountId: "type-only" });
  });
});

describe("classifyShimExports — real casaevideo-storefront fixtures", () => {
  it("vtex-segment.ts (mixed: stub + functional)", () => {
    const code = `
      export function getSegmentFromBag(_req?: any): Record<string, unknown> | null {
        return null;
      }

      export function withSegmentCookie(..._args: any[]): any {
        for (const arg of _args) {
          if (arg instanceof Headers) {
            return arg;
          }
        }
        return new Headers();
      }
    `;
    expect(classMap(code)).toEqual({
      getSegmentFromBag: "stub",
      // Multi-statement / nested block — defaults to functional. This is a
      // *known* false negative (see module docstring): the function looks
      // functional but actually drops the segment cookie. We accept this
      // trade-off rather than risk false positives on real implementations.
      withSegmentCookie: "functional",
    });
  });

  it("vtex-transform.ts (single identity-cast stub)", () => {
    const code = `
      import type { Product } from "@decocms/apps/commerce/types";
      export function toProduct(vtexProduct: any): Product {
        return vtexProduct as Product;
      }
    `;
    expect(classMap(code)).toEqual({ toProduct: "stub" });
  });

  it("vtex-client.ts (interface only)", () => {
    const code = `
      export interface VTEXCommerceStable {
        account: string;
        environment?: string;
      }
    `;
    expect(classMap(code)).toEqual({ VTEXCommerceStable: "type-only" });
  });

  it("vtex-fetch.ts (functional)", () => {
    const code = `
      export async function fetchSafe(
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> {
        const response = await fetch(input, init);
        if (!response.ok) {
          console.error(\`VTEX fetch failed: \${response.status}\`);
        }
        return response;
      }
    `;
    expect(classMap(code)).toEqual({ fetchSafe: "functional" });
  });

  it("vtex-id.ts (functional cookie parser)", () => {
    const code = `
      export function parseCookie(cookieStr?: string | null): Record<string, string> {
        if (!cookieStr) return {};
        return Object.fromEntries(
          cookieStr.split(";").map((c) => {
            const [key, ...rest] = c.trim().split("=");
            return [key, rest.join("=")];
          }),
        );
      }
    `;
    expect(classMap(code)).toEqual({ parseCookie: "functional" });
  });

  it("vtex-intelligent-search.ts (mixed: 1 stub + 4 functional)", () => {
    const code = `
      export function getISCookiesFromBag(_req?: any): Record<string, string> {
        return {};
      }

      export function isFilterParam(key: string): boolean {
        return key.startsWith("filter.");
      }

      export function toPath(facets: { key: string; value: string }[]): string {
        return facets.map((f) => \`\${f.key}/\${f.value}\`).join("/");
      }

      export function withDefaultFacets(
        facets: { key: string; value: string }[],
        defaults?: any,
      ): { key: string; value: string }[] {
        if (Array.isArray(defaults)) {
          return [...defaults, ...facets];
        }
        return [...facets];
      }

      export function withDefaultParams(
        params: any,
        defaults?: Record<string, string>,
      ): any {
        if (params instanceof URLSearchParams) {
          if (defaults) {
            for (const [key, value] of Object.entries(defaults)) {
              if (!params.has(key)) {
                params.set(key, value);
              }
            }
          }
          return params;
        }
        return { ...params, ...defaults };
      }
    `;
    expect(classMap(code)).toEqual({
      getISCookiesFromBag: "stub",
      isFilterParam: "functional",
      toPath: "functional",
      withDefaultFacets: "functional",
      withDefaultParams: "functional",
    });
  });
});

describe("classifyShimExports — defensive cases", () => {
  it("empty file → no exports", () => {
    expect(classifyShimExports("")).toEqual([]);
  });

  it("file with only imports → no exports", () => {
    const code = `import { x } from "y";`;
    expect(classifyShimExports(code)).toEqual([]);
  });

  it("non-export function ignored", () => {
    const code = `function private_(): null { return null; }`;
    expect(classifyShimExports(code)).toEqual([]);
  });

  it("export default skipped (intentional — only flag named exports)", () => {
    const code = `export default function() { return null; }`;
    expect(classifyShimExports(code)).toEqual([]);
  });

  it("strings containing braces don't break body extraction", () => {
    const code = `
      export function withBrace(): string {
        return "{not a real brace}";
      }
    `;
    expect(classMap(code)).toEqual({ withBrace: "functional" });
  });

  it("template literal with brace-like substitution", () => {
    const code = `
      export function withTemplate(): string {
        return \`hello \${1 + 1}\`;
      }
    `;
    // Single statement, but the value is non-empty/non-null → functional.
    expect(classMap(code)).toEqual({ withTemplate: "functional" });
  });
});
