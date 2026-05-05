import { describe, expect, it } from "vitest";
import {
  blockHasPath,
  type Candidate,
  decodeBlockName,
  decodeBlockNameWithPasses,
  mergeCandidates,
  pickWinner,
} from "./blocks-dedupe";

const cand = (overrides: Partial<Candidate> & { file: string }): Candidate => ({
  passes: 0,
  mtimeMs: 0,
  hasPath: true,
  parsed: { path: "/" },
  ...overrides,
});

describe("decodeBlockNameWithPasses", () => {
  it("returns the literal key with a 0 pass count when filename has no encoding", () => {
    expect(decodeBlockNameWithPasses("Header.json")).toEqual({ name: "Header", passes: 0 });
  });

  it("decodes a single layer of URL encoding", () => {
    expect(decodeBlockNameWithPasses("pages-Home%20-%20LB-618509.json")).toEqual({
      name: "pages-Home - LB-618509",
      passes: 1,
    });
  });

  it("decodes the bot's double-encoded scheme through to the literal key", () => {
    // Bot encodes the raw prod URL-encoded key once: `encodeURIComponent("pages-Home%20-%20LB-618509")`.
    expect(decodeBlockNameWithPasses("pages-Home%2520-%2520LB-618509.json")).toEqual({
      name: "pages-Home - LB-618509",
      passes: 2,
    });
  });

  it("stops decoding when a literal % survives a round", () => {
    // `%` alone isn't valid encoding — the loop catches the throw and stops.
    expect(decodeBlockNameWithPasses("weird%percent.json")).toEqual({
      name: "weird%percent",
      passes: 0,
    });
  });
});

describe("decodeBlockName", () => {
  it("matches decodeBlockNameWithPasses on the name", () => {
    expect(decodeBlockName("pages-Home%2520-%2520LB-618509.json")).toBe("pages-Home - LB-618509");
  });
});

describe("blockHasPath", () => {
  it("returns true for live page blocks", () => {
    expect(blockHasPath({ path: "/", sections: [] })).toBe(true);
  });

  it("returns false when path is null (zombie entry)", () => {
    expect(blockHasPath({ path: null, sections: [] })).toBe(false);
  });

  it("returns false when path is missing", () => {
    expect(blockHasPath({ sections: [] })).toBe(false);
  });

  it("returns false for empty path strings", () => {
    expect(blockHasPath({ path: "" })).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(blockHasPath(null)).toBe(false);
    expect(blockHasPath("/")).toBe(false);
  });
});

describe("pickWinner", () => {
  it("prefers a candidate with a real path over a zombie", () => {
    const live = cand({ file: "live.json", hasPath: true });
    const zombie = cand({ file: "zombie.json", hasPath: false, parsed: { path: null } });
    expect(pickWinner(live, zombie)).toBe(live);
    expect(pickWinner(zombie, live)).toBe(live);
  });

  it("prefers higher decode-pass count when path-status matches", () => {
    // The lebiscuit reproduction case: a stale single-encoded leftover with a
    // newer mtime and larger size loses to the bot's double-encoded fresh file.
    const stale = cand({
      file: "pages-Home%20-%20LB-618509.json",
      passes: 1,
      mtimeMs: 2_000_000,
    });
    const fresh = cand({
      file: "pages-Home%2520-%2520LB-618509.json",
      passes: 2,
      mtimeMs: 1_000_000,
    });
    expect(pickWinner(stale, fresh)).toBe(fresh);
  });

  it("falls through to mtime when pass count ties", () => {
    const older = cand({ file: "a.json", passes: 1, mtimeMs: 1 });
    const newer = cand({ file: "b.json", passes: 1, mtimeMs: 2 });
    expect(pickWinner(older, newer)).toBe(newer);
  });

  it("falls through to lex filename when everything else ties", () => {
    const a = cand({ file: "a.json", passes: 0, mtimeMs: 5 });
    const b = cand({ file: "b.json", passes: 0, mtimeMs: 5 });
    expect(pickWinner(a, b)).toBe(a);
    expect(pickWinner(b, a)).toBe(a);
  });
});

describe("mergeCandidates", () => {
  it("returns each candidate unchanged when there are no collisions", () => {
    const a = cand({ file: "Header.json" });
    const b = cand({ file: "Footer.json" });
    const result = mergeCandidates([
      { candidate: a, key: "Header" },
      { candidate: b, key: "Footer" },
    ]);
    expect(result.collisions).toEqual([]);
    expect(result.winners).toEqual({ Header: a, Footer: b });
  });

  it("records a collision and picks the winner", () => {
    const stale = cand({ file: "pages-Home%20-%20LB-618509.json", passes: 1, mtimeMs: 5 });
    const fresh = cand({ file: "pages-Home%2520-%2520LB-618509.json", passes: 2, mtimeMs: 1 });
    const result = mergeCandidates([
      { candidate: stale, key: "pages-Home - LB-618509" },
      { candidate: fresh, key: "pages-Home - LB-618509" },
    ]);
    expect(result.winners["pages-Home - LB-618509"]).toBe(fresh);
    expect(result.collisions).toEqual([
      {
        key: "pages-Home - LB-618509",
        files: ["pages-Home%20-%20LB-618509.json", "pages-Home%2520-%2520LB-618509.json"],
        winner: "pages-Home%2520-%2520LB-618509.json",
      },
    ]);
  });

  it("collapses three-way collisions into one record without dropping the winner", () => {
    const a = cand({ file: "a.json", passes: 0, mtimeMs: 1 });
    const b = cand({ file: "b.json", passes: 1, mtimeMs: 2 });
    const c = cand({ file: "c.json", passes: 2, mtimeMs: 3 });
    const result = mergeCandidates([
      { candidate: a, key: "k" },
      { candidate: b, key: "k" },
      { candidate: c, key: "k" },
    ]);
    expect(result.winners.k).toBe(c);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].winner).toBe("c.json");
    // a, b, and c should all be tracked (a and b as ignored, c as winner).
    expect(new Set(result.collisions[0].files)).toEqual(new Set(["a.json", "b.json", "c.json"]));
  });

  it("prefers the live page over a zombie even when zombie has more passes", () => {
    const livePlain = cand({
      file: "Home.json",
      passes: 0,
      hasPath: true,
      parsed: { path: "/" },
    });
    const zombieEncoded = cand({
      file: "Home%2520.json",
      passes: 2,
      hasPath: false,
      parsed: { path: null },
    });
    const result = mergeCandidates([
      { candidate: zombieEncoded, key: "Home" },
      { candidate: livePlain, key: "Home" },
    ]);
    expect(result.winners.Home).toBe(livePlain);
  });
});
