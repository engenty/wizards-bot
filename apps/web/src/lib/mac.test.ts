import { afterEach, describe, expect, it, vi } from "vitest";
import { inMacApp, macName, pickFolderOnMac, toMac } from "./mac";

const posted: unknown[] = [];

function inTheApp(local: boolean, answer: unknown = null) {
  vi.stubGlobal("window", {
    wizardsMac: { local, name: "Ada's MacBook" },
    webkit: {
      messageHandlers: {
        wizardsMac: {
          postMessage: (message: unknown) => {
            posted.push(message);
            return Promise.resolve(answer);
          },
        },
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  posted.length = 0;
});

describe("the Mac app", () => {
  it("is not there in a browser", async () => {
    vi.stubGlobal("window", {});
    expect(inMacApp()).toBe(false);
    expect(macName()).toBeUndefined();
    expect(await toMac({ type: "waiting", count: 2 })).toBeUndefined();
    expect(await pickFolderOnMac()).toBeUndefined();
  });

  it("gets what the page hands it", async () => {
    inTheApp(false, true);
    expect(inMacApp()).toBe(true);
    expect(macName()).toBe("Ada's MacBook");
    await toMac({ type: "waiting", count: 2 });
    expect(posted).toEqual([{ type: "waiting", count: 2 }]);
  });

  it("opens its folder dialog only for a Bot Server on the same Mac", async () => {
    inTheApp(false, "/Users/ada/Notes");
    expect(await pickFolderOnMac()).toBeUndefined();
    inTheApp(true, "/Users/ada/Notes");
    expect(await pickFolderOnMac()).toBe("/Users/ada/Notes");
    inTheApp(true, null);
    expect(await pickFolderOnMac()).toBeNull();
  });
});
