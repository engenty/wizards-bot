import { describe, expect, it } from "vitest";
import { runsHome, sidebarOffers } from "./member";

const device = (role?: "owner" | "admin" | "member" | "client") => ({
  person: role ? { id: "usr_1", name: "Ben", role } : undefined,
});

describe("who runs the home", () => {
  it("is the one person of a home that names nobody", () => {
    expect(runsHome(device())).toBe(true);
    expect(runsHome(undefined)).toBe(true);
  });

  it("is a team's owners and admins, not its members and clients", () => {
    expect(runsHome(device("owner"))).toBe(true);
    expect(runsHome(device("admin"))).toBe(true);
    expect(runsHome(device("member"))).toBe(false);
    expect(runsHome(device("client"))).toBe(false);
  });
});

describe("the sidebar of a member", () => {
  it("has the agents and nothing of the home's own", () => {
    expect(sidebarOffers(runsHome(device("member")))).toEqual({
      search: false,
      add: false,
      settings: false,
      avatar: false,
    });
  });

  it("has all of it for who runs the home", () => {
    expect(sidebarOffers(runsHome(device("admin")))).toEqual({
      search: true,
      add: true,
      settings: true,
      avatar: true,
    });
  });
});
