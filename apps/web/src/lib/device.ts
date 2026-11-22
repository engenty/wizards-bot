// From engenty wizards, packages/runner/src/device.ts.

/** A finger as the main pointer: a phone or a tablet. */
export const isTouch =
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

/** The camera only exists on https and on localhost; a home reached by its plain address has none. */
export const canUseCamera =
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
