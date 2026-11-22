import { QueryClient } from "@tanstack/react-query";
import type { Device } from "@wizards-bot/protocol";
import { describe, expect, it } from "vitest";
import { asking, onDevices } from "./devices";
import { applyEvent } from "./events";
import { keys } from "./keys";

const phone: Device = {
  id: "dev_1",
  name: "Ada's iPhone",
  kind: "phone",
  createdAt: "t",
  seenAt: "t",
  resources: [
    { id: "calendar", kind: "calendar", name: "Calendar", can: ["read", "change"] },
    { id: "pf_1", kind: "folder", name: "Receipts", can: ["read"] },
    { id: "pf_2", kind: "folder", name: "Trips", can: ["read"] },
    { id: "pc_1", kind: "connection", name: "Linear", can: ["read", "change"] },
  ],
};
const browser: Device = { id: "dev_2", name: "Web", kind: "browser", createdAt: "t", seenAt: "t" };

describe("who may ask a device", () => {
  it("is what the person said on the device; an agent not named there asks first", () => {
    const told: Device = { ...phone, agents: { allowed: ["agt_1"], refused: ["agt_2"] } };
    expect(asking([told, browser], "agt_1")).toEqual([{ device: "Ada's iPhone", may: "yes" }]);
    expect(asking([told], "agt_2")[0]?.may).toBe("no");
    expect(asking([told], "agt_3")[0]?.may).toBe("first");
    expect(asking([phone], "agt_1")[0]?.may).toBe("first");
  });
});

describe("folders and services on a device", () => {
  it("are listed with the device they are on, and nothing else a device offers", () => {
    expect(
      onDevices([browser, phone]).map(({ resource, device }) => [resource.name, device]),
    ).toEqual([
      ["Receipts", "Ada's iPhone"],
      ["Trips", "Ada's iPhone"],
      ["Linear", "Ada's iPhone"],
    ]);
    expect(onDevices([browser])).toEqual([]);
  });

  it("follow what the devices say they offer", () => {
    const client = new QueryClient();
    applyEvent(client, { type: "devices.updated", devices: [phone] });
    expect(onDevices(client.getQueryData<Device[]>(keys.devices()) ?? [])).toHaveLength(3);
    // A hand-off is the phone's own business: the web app keeps nothing of it.
    applyEvent(client, {
      type: "handoff.updated",
      handoff: {
        id: "hnd_1",
        deviceId: "dev_1",
        agentId: "agt_1",
        agentName: "Goose",
        conversationId: "cnv_1",
        text: "What is tomorrow?",
        state: "open",
        createdAt: "t",
      },
    });
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([keys.devices()]);
  });
});
