import { describe, expect, it } from "vitest";
import { opens } from "./link";

describe("opens", () => {
  it("is the address for the web and for email", () => {
    expect(opens("https://example.org/a?b=1")).toBe("https://example.org/a?b=1");
    expect(opens(" HTTP://example.org ")).toBe("HTTP://example.org");
    expect(opens("mailto:ada@example.org")).toBe("mailto:ada@example.org");
  });

  it("is nothing for a script, a file, or an address inside this app", () => {
    expect(opens("javascript:alert(1)")).toBeNull();
    expect(opens(" javascript:alert(1)")).toBeNull();
    expect(opens("data:text/html,<script>1</script>")).toBeNull();
    expect(opens("file:///etc/passwd")).toBeNull();
    expect(opens("/v1/device")).toBeNull();
    expect(opens("notes/plan")).toBeNull();
    expect(opens("//example.org")).toBeNull();
  });
});
