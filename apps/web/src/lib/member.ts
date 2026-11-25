import type { Device } from "@wizards-bot/protocol";

/**
 * Whether a device's person runs the home. In a home of one person nobody is named, and they do;
 * in a team's, its owners and admins do, and a member chats with its agents.
 */
export const runsHome = (device: Pick<Device, "person"> | undefined): boolean => {
  const role = device?.person?.role;
  return role === undefined || role === "owner" || role === "admin";
};

/** What the list of agents offers besides the agents and signing out. */
export interface SidebarOffers {
  /** The search over every conversation of the home. */
  search: boolean;
  /** A new agent, which the main agent sets up. */
  add: boolean;
  settings: boolean;
  /** The avatar, which is the home's one. */
  avatar: boolean;
}

/**
 * What the list offers a person. All of it is the home's own and for who runs it: a member of
 * the team has the agents, how the chat looks and the way out.
 */
export function sidebarOffers(runs: boolean): SidebarOffers {
  return { search: runs, add: runs, settings: runs, avatar: runs };
}
