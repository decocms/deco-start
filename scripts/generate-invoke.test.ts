/**
 * Integration test for scripts/generate-invoke.ts.
 *
 * The generator scans a `vtex/invoke.ts` file from @decocms/apps and emits a
 * site-local `src/server/invoke.gen.ts` with top-level `createServerFn`
 * declarations. The piece we care most about locking is the Set-Cookie
 * bridge: every handler must call `forwardResponseCookies()` after the
 * action awaits, so VTEX-set cookies captured by `vtexFetchWithCookies`
 * reach the browser via TanStack Start's HTTP response. Without this,
 * `checkout.vtex.com` never reaches the browser, the storefront's
 * mini-cart and VTEX's server-side orderForm drift apart, and /checkout
 * loads with an empty cart.
 *
 * We exercise the generator end-to-end against a minimal fixture
 * `invoke.ts` rather than unit-test internal helpers — the failure
 * mode we want to prevent (a missing `forwardResponseCookies()` call
 * in the emit string) only shows up in the produced source text.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GENERATOR = path.resolve(__dirname, "generate-invoke.ts");

const FIXTURE_INVOKE_TS = `\
import { createInvokeFn } from "@decocms/start/sdk/createInvoke";
import { getOrCreateCart, simulateCart } from "./actions/checkout";
import type { OrderForm } from "./types";

export const invoke = {
	vtex: {
		actions: {
			getOrCreateCart: createInvokeFn(
				(data: { orderFormId?: string }) => getOrCreateCart(data),
			) as unknown as (ctx: { data: { orderFormId?: string } }) => Promise<OrderForm>,

			simulateCart: createInvokeFn(
				(data: { postalCode: string }) => simulateCart(data),
			),
		},
	},
} as const;
`;

// Minimal stubs the generator's import-resolution doesn't *execute* but
// ts-morph parses these to populate the importMap. We only need names to
// resolve.
const FIXTURE_ACTIONS_CHECKOUT_TS = `\
export async function getOrCreateCart(_data: any): Promise<any> { return null; }
export async function simulateCart(_data: any): Promise<any> { return null; }
`;
const FIXTURE_TYPES_TS = `export type OrderForm = unknown;\n`;

describe("generate-invoke.ts — output shape", () => {
  let appsDir: string;
  let siteDir: string;
  let outFile: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gen-invoke-"));
    appsDir = path.join(tmp, "apps");
    siteDir = path.join(tmp, "site");
    fs.mkdirSync(path.join(appsDir, "vtex", "actions"), { recursive: true });
    fs.mkdirSync(path.join(siteDir, "src", "server"), { recursive: true });
    fs.writeFileSync(path.join(appsDir, "vtex", "invoke.ts"), FIXTURE_INVOKE_TS);
    fs.writeFileSync(
      path.join(appsDir, "vtex", "actions", "checkout.ts"),
      FIXTURE_ACTIONS_CHECKOUT_TS,
    );
    fs.writeFileSync(path.join(appsDir, "vtex", "types.ts"), FIXTURE_TYPES_TS);
    outFile = path.join(siteDir, "src", "server", "invoke.gen.ts");
  });

  afterEach(() => {
    // Best-effort cleanup; tmp dirs leak otherwise.
    try {
      fs.rmSync(path.dirname(appsDir), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function runGenerator(): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(
      "npx",
      [
        "tsx",
        GENERATOR,
        "--apps-dir",
        appsDir,
        "--out-file",
        outFile,
      ],
      {
        cwd: siteDir,
        encoding: "utf8",
      },
    );
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  }

  it("imports the framework helpers needed for Set-Cookie propagation", () => {
    const { status } = runGenerator();
    expect(status).toBe(0);

    const out = fs.readFileSync(outFile, "utf8");
    // Both imports must be present — without them, forwardResponseCookies
    // doesn't compile in the site, and the regression we're fixing
    // resurfaces silently when someone deletes one of them.
    expect(out).toContain('from "@tanstack/react-start/server"');
    expect(out).toMatch(/getResponseHeaders\s*,?\s*\n?\s*setResponseHeader/);
    expect(out).toContain('import { RequestContext } from "@decocms/start/sdk/requestContext"');
  });

  it("emits the forwardResponseCookies helper exactly once", () => {
    runGenerator();
    const out = fs.readFileSync(outFile, "utf8");
    // Match the declaration, not call sites. There's only one helper.
    const declMatches = out.match(/function forwardResponseCookies\(\)/g);
    expect(declMatches).toHaveLength(1);

    // The helper must read from RequestContext.responseHeaders and call
    // setResponseHeader. Locking the bridge ends-to-ends.
    expect(out).toContain("RequestContext.current");
    expect(out).toContain("ctx.responseHeaders.getSetCookie");
    expect(out).toContain('setResponseHeader("set-cookie"');
  });

  it("calls forwardResponseCookies() inside every generated handler", () => {
    runGenerator();
    const out = fs.readFileSync(outFile, "utf8");

    // Each .handler(async ({ data }) ...) block produced by the
    // generator must contain a `forwardResponseCookies()` call. We
    // count handlers vs. call sites — excluding the declaration site
    // (`function forwardResponseCookies()`), which also matches the
    // bare `forwardResponseCookies()` token.
    const handlerCount = (out.match(/\.handler\(async \(\{ data \}\)/g) ?? []).length;
    const allOccurrences = (out.match(/\bforwardResponseCookies\(\)/g) ?? []).length;
    const declSites = (out.match(/function\s+forwardResponseCookies\(\)/g) ?? []).length;
    const callSites = allOccurrences - declSites;

    expect(handlerCount).toBe(2);
    expect(declSites).toBe(1);
    expect(callSites).toBe(2);
  });

  it("calls forwardResponseCookies AFTER the action awaits (so RequestContext is populated)", () => {
    runGenerator();
    const out = fs.readFileSync(outFile, "utf8");

    // The action must complete (await result) before we read the
    // captured Set-Cookies — otherwise we'd forward an empty set
    // every time. Verifying ordering via regex is brittle but the
    // surface is small enough.
    const pattern =
      /const result = await \w+\(data\);\s+forwardResponseCookies\(\);\s+return (?:unwrapResult\(result\)|result);/g;
    const orderedCalls = out.match(pattern) ?? [];
    expect(orderedCalls.length).toBe(2);
  });
});
