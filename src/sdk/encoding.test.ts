import { describe, expect, it } from "vitest";
import {
  decodeBase64,
  decodeBase64Url,
  encodeBase64,
  encodeBase64Url,
} from "./encoding";

describe("encodeBase64 / decodeBase64", () => {
  it("round-trips ASCII strings", () => {
    const data = "hello, world";
    const b64 = encodeBase64(data);
    expect(b64).toBe("aGVsbG8sIHdvcmxk");
    const decoded = new TextDecoder().decode(decodeBase64(b64));
    expect(decoded).toBe(data);
  });

  it("round-trips multi-byte UTF-8", () => {
    const data = "São Paulo — café ☕";
    const b64 = encodeBase64(data);
    const decoded = new TextDecoder().decode(decodeBase64(b64));
    expect(decoded).toBe(data);
  });

  it("accepts Uint8Array input", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const b64 = encodeBase64(bytes);
    expect(decodeBase64(b64)).toEqual(bytes);
  });

  it("accepts ArrayBuffer input", () => {
    const buf = new Uint8Array([255, 254, 253]).buffer;
    const b64 = encodeBase64(buf);
    expect(Array.from(decodeBase64(b64))).toEqual([255, 254, 253]);
  });

  it("handles inputs larger than the chunking window", () => {
    // 0x8000 + 7 bytes — forces the chunking branch.
    const bytes = new Uint8Array(0x8000 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const b64 = encodeBase64(bytes);
    expect(decodeBase64(b64)).toEqual(bytes);
  });
});

describe("encodeBase64Url / decodeBase64Url", () => {
  it("uses URL-safe alphabet and strips padding", () => {
    // Inputs that produce '+', '/', and padding under standard base64.
    const bytes = new Uint8Array([251, 255, 191, 251, 239, 254]);
    const standard = encodeBase64(bytes);
    const url = encodeBase64Url(bytes);
    // Every '+' becomes '-', '/' becomes '_', trailing '=' is stripped.
    expect(url).toBe(
      standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    );
    expect(url).not.toContain("+");
    expect(url).not.toContain("/");
    expect(url).not.toContain("=");
  });

  it("round-trips through the URL-safe pair", () => {
    const data = new Uint8Array(64);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
    expect(decodeBase64Url(encodeBase64Url(data))).toEqual(data);
  });

  it("decodes inputs missing their padding", () => {
    // 'a' = 0x61. encodeBase64('a') = 'YQ==', URL form drops to 'YQ'.
    expect(new TextDecoder().decode(decodeBase64Url("YQ"))).toBe("a");
  });
});
