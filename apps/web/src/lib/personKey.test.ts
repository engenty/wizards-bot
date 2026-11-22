import { describe, expect, it } from "vitest";
import { codeOf, keyFrom, seedOf, signText } from "./personKey";

const seed = Uint8Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256);

describe("the recovery code", () => {
  it("is the key in groups of four, and reads back to the same key", () => {
    const code = codeOf(seed);
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]$/);
    expect(seedOf(code)).toEqual(seed);
  });

  it("is read however it was typed: small letters, spaces, O for 0, I and L for 1", () => {
    const code = codeOf(seed);
    const typed = code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    expect(seedOf(typed)).toEqual(seed);
    expect(seedOf(`  ${code}  `)).toEqual(seed);
  });

  it("is refused when a character is wrong, two are swapped or some are missing", () => {
    const code = codeOf(seed);
    const other = code.startsWith("7") ? "8" : "7";
    expect(seedOf(other + code.slice(1))).toBeUndefined();
    expect(seedOf(code.charAt(1) + code.charAt(0) + code.slice(2))).toBeUndefined();
    expect(seedOf(code.slice(0, -3))).toBeUndefined();
    expect(seedOf(`${code}-7K2M`)).toBeUndefined();
    expect(seedOf("")).toBeUndefined();
    expect(seedOf("not a code")).toBeUndefined();
  });
});

describe("the key a code stands for", () => {
  it("is always the same key, and signs what a home can check", async () => {
    const first = await keyFrom(seed);
    const again = await keyFrom(seedOf(codeOf(seed)) as Uint8Array);
    expect(again.publicKey).toBe(first.publicKey);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The key itself cannot be read out of the browser again.
    expect(first.key.extractable).toBe(false);

    const payload = '{"v":1,"name":"Ada"}';
    const sig = await signText(first.key, payload);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: first.publicKey },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const bytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
      char.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify("Ed25519", publicKey, bytes, new TextEncoder().encode(payload)),
    ).toBe(true);
    expect(
      await crypto.subtle.verify("Ed25519", publicKey, bytes, new TextEncoder().encode("other")),
    ).toBe(false);
  });
});
