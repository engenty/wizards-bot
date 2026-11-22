import { afterEach, describe, expect, it } from "vitest";
import { uuid } from "./uuid";

describe("uuid", () => {
  const own = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  afterEach(() => {
    if (own) {
      Object.defineProperty(crypto, "randomUUID", own);
    } else {
      Reflect.deleteProperty(crypto, "randomUUID");
    }
  });

  it("makes a version 4 id also where randomUUID is missing, as on plain http", () => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid()).not.toBe(id);
  });
});
