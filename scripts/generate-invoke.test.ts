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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GENERATOR = path.resolve(__dirname, "generate-invoke.ts");

const FIXTURE_INVOKE_TS = `\
import { createInvokeFn } from "@decocms/start/sdk/createInvoke";
import { getOrCreateCart, simulateCart } from "./actions/checkout";
import { createSession } from "./actions/session";
import type { OrderForm } from "./types";

export const invoke = {
	vtex: {
		actions: {
			// Direct pass-through wrapper — most common shape.
			getOrCreateCart: createInvokeFn(
				(data: { orderFormId?: string }) => getOrCreateCart(data),
			) as unknown as (ctx: { data: { orderFormId?: string } }) => Promise<OrderForm>,

			simulateCart: createInvokeFn(
				(data: { postalCode: string }) => simulateCart(data),
			),

			// Adapting wrapper — payload gets wrapped into the action's
			// props shape. The generator MUST preserve this wrap or the
			// action call typechecks against the wrong props type.
			createSession: createInvokeFn(
				(data: Record<string, any>) => createSession({ data }),
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
const FIXTURE_ACTIONS_SESSION_TS = `\
export interface CreateSessionProps { data: Record<string, any>; }
export async function createSession(_props: CreateSessionProps): Promise<any> { return null; }
`;
const FIXTURE_TYPES_TS = `export type OrderForm = unknown;\n`;

describe("generate-invoke.ts — output shape", () => {
  // The fixture is read-only across tests: every assertion runs against
  // the same generated `invoke.gen.ts`. Running the generator once in
  // `beforeAll` keeps the test fast (each `npx tsx` spawn is ~3-5s) and
  // sidesteps the vitest 5s default per-test timeout that this suite was
  // tipping over once we grew the fixture.
  let appsDir: string;
  let siteDir: string;
  let outFile: string;
  let generatedOutput: string;
  let generatorStatus: number | null;

  beforeAll(() => {
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
    fs.writeFileSync(
      path.join(appsDir, "vtex", "actions", "session.ts"),
      FIXTURE_ACTIONS_SESSION_TS,
    );
    fs.writeFileSync(path.join(appsDir, "vtex", "types.ts"), FIXTURE_TYPES_TS);
    outFile = path.join(siteDir, "src", "server", "invoke.gen.ts");

    const result = spawnSync(
      "npx",
      ["tsx", GENERATOR, "--apps-dir", appsDir, "--out-file", outFile],
      { cwd: siteDir, encoding: "utf8" },
    );
    generatorStatus = result.status;
    generatedOutput = fs.readFileSync(outFile, "utf8");
  }, 30_000);

  afterAll(() => {
    // Best-effort cleanup; tmp dirs leak otherwise.
    try {
      fs.rmSync(path.dirname(appsDir), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("runs to completion against a minimal fixture", () => {
    // Sanity check — every subsequent assertion is wasted if the
    // generator process bombed.
    expect(generatorStatus).toBe(0);
  });

  it("imports the framework helpers needed for Set-Cookie propagation", () => {
    // Both imports must be present — without them, forwardResponseCookies
    // doesn't compile in the site, and the regression we're fixing
    // resurfaces silently when someone deletes one of them.
    expect(generatedOutput).toContain('from "@tanstack/react-start/server"');
    expect(generatedOutput).toMatch(/getResponseHeaders\s*,?\s*\n?\s*setResponseHeader/);
    expect(generatedOutput).toContain(
      'import { RequestContext } from "@decocms/start/sdk/requestContext"',
    );
  });

  it("emits the forwardResponseCookies helper exactly once", () => {
    const declMatches = generatedOutput.match(/function forwardResponseCookies\(\)/g);
    expect(declMatches).toHaveLength(1);

    // The helper must read from RequestContext.responseHeaders and call
    // setResponseHeader. Locking the bridge ends-to-ends.
    expect(generatedOutput).toContain("RequestContext.current");
    expect(generatedOutput).toContain("ctx.responseHeaders.getSetCookie");
    expect(generatedOutput).toContain('setResponseHeader("set-cookie"');
  });

  it("calls forwardResponseCookies() inside every generated handler", () => {
    // Each .handler(async ({ data }) ...) block produced by the
    // generator must contain a `forwardResponseCookies()` call. We
    // count handlers vs. call sites — excluding the declaration site
    // (`function forwardResponseCookies()`), which also matches the
    // bare `forwardResponseCookies()` token.
    const handlerCount = (generatedOutput.match(/\.handler\(async \(\{ data \}\)/g) ?? []).length;
    const allOccurrences = (generatedOutput.match(/\bforwardResponseCookies\(\)/g) ?? []).length;
    const declSites = (generatedOutput.match(/function\s+forwardResponseCookies\(\)/g) ?? [])
      .length;
    const callSites = allOccurrences - declSites;

    expect(handlerCount).toBe(3);
    expect(declSites).toBe(1);
    expect(callSites).toBe(3);
  });

  it("calls forwardResponseCookies AFTER the action awaits (so RequestContext is populated)", () => {
    // The action must complete (await result) before we read the
    // captured Set-Cookies — otherwise we'd forward an empty set
    // every time. The expression body after `await` can be any call
    // shape the wrapper produces (`fn(data)` or `fn({ data })`),
    // so we match across the whole expression up to the semicolon.
    const pattern =
      /const result = await [^;]+;\s+forwardResponseCookies\(\);\s+return (?:unwrapResult\(result\)|result);/g;
    const orderedCalls = generatedOutput.match(pattern) ?? [];
    expect(orderedCalls.length).toBe(3);
  });

  it("preserves adapting wrappers verbatim (does not collapse to actionFn(data))", () => {
    // Regression for the createSession-shape wrapper: the generator
    // previously hard-coded `${importedFn}(data)` in every handler,
    // silently dropping the wrap that wrappers like
    //   createSession: createInvokeFn((data) => createSession({ data }))
    // perform to bridge the external invoke shape to the internal
    // action shape. Sites that regenerated against this hit
    // `TS2345: Property 'data' is missing in type '{ [x: string]: any; }'`
    // at the regenerated call site of every adapting wrapper.
    expect(generatedOutput).toContain("const result = await createSession({ data });");
    // And the broken shortcut must NOT appear for this action.
    expect(generatedOutput).not.toMatch(/const result = await createSession\(data\);/);

    // Direct pass-through wrappers are unaffected: their body is
    // already `actionFn(data)`, so emitting verbatim produces the same
    // output that the previous shortcut produced. Lock that too — a
    // future refactor that breaks pass-throughs would be just as bad.
    expect(generatedOutput).toContain("const result = await getOrCreateCart(data);");
    expect(generatedOutput).toContain("const result = await simulateCart(data);");
  });
});
