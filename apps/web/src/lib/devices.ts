import type { Device, DeviceResource } from "@wizards-bot/protocol";

/** Whether an agent may hand questions to a device, as the person said on that device. */
export type MayAsk = "yes" | "first" | "no";

/** The devices that take questions, each with whether this agent may ask it. */
export function asking(devices: Device[], agentId: string): { device: string; may: MayAsk }[] {
  return devices
    .filter((device) => device.resources !== undefined)
    .map((device) => ({
      device: device.name,
      may: device.agents?.refused.includes(agentId)
        ? "no"
        : device.agents?.allowed.includes(agentId)
          ? "yes"
          : "first",
    }));
}

/** A folder connected or a service signed in on one of the person's devices, with that device's name. */
export interface OnDevice {
  resource: DeviceResource;
  device: string;
}

/**
 * The folders connected and the services signed in on the person's devices, device by device in
 * the order the home lists them. Calendars, reminders and contacts are every phone's own and are
 * not listed.
 */
export function onDevices(devices: Device[]): OnDevice[] {
  return devices.flatMap((device) =>
    (device.resources ?? [])
      .filter((resource) => resource.kind === "folder" || resource.kind === "connection")
      .map((resource) => ({ resource, device: device.name })),
  );
}
