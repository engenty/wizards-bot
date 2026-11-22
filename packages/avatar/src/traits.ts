import type { Avatar } from "@wizards-bot/protocol";

/** The figure a person has before they made their own. */
export const DEFAULT_AVATAR: Avatar = {
  skin: "medium",
  hair: { style: "short", color: "brown" },
  glasses: "none",
  beard: "none",
  hat: { style: "none", color: "grey" },
  top: { style: "tee", color: "orange" },
  bottom: { style: "trousers", color: "navy" },
  shoes: { style: "sneakers", color: "white" },
  accessory: { style: "none", color: "red" },
};

/**
 * Traits as they were once kept or named, in today's shape: shoes were a colour only, and
 * there was nothing to wear besides a hat. Every value an avatar could have then still means
 * the same figure. What is no set of traits at all comes back as it is, for the caller's
 * own check.
 */
export function savedTraits(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const traits = { ...(value as Record<string, unknown>) };
  if (typeof traits.shoes === "string") {
    traits.shoes = { style: DEFAULT_AVATAR.shoes.style, color: traits.shoes };
  }
  traits.accessory ??= DEFAULT_AVATAR.accessory;
  return traits;
}
