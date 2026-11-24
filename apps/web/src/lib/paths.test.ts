import type { FolderListing } from "@wizards-bot/protocol";
import { describe, expect, it } from "vitest";
import { completions, crumbs, nameOf, separatorOf, tilde, trimmedPath } from "./paths";

const listing: FolderListing = {
  path: "/Users/ada",
  parent: "/Users",
  home: "/Users/ada",
  root: "/Users/ada",
  disks: [],
  folders: [
    { name: "Desktop", path: "/Users/ada/Desktop" },
    { name: "Documents", path: "/Users/ada/Documents" },
    { name: "Downloads", path: "/Users/ada/Downloads" },
    { name: "Music", path: "/Users/ada/Music" },
  ],
};

describe("completions", () => {
  it("offers every folder after a separator", () => {
    expect(completions(listing, "/Users/ada/")).toHaveLength(4);
  });

  it("offers the folders that start as the half-typed name does, whatever the case", () => {
    expect(completions(listing, "/Users/ada/do").map((f) => f.name)).toEqual([
      "Documents",
      "Downloads",
    ]);
  });

  it("does not offer the folder that is typed in full", () => {
    expect(completions(listing, "/Users/ada/Music")).toEqual([]);
  });

  it("reads a Windows path by its own separator", () => {
    const windows: FolderListing = {
      path: "C:\\Users\\ada",
      parent: "C:\\Users",
      home: "C:\\Users\\ada",
      root: "C:\\Users\\ada",
      disks: [],
      folders: [{ name: "Documents", path: "C:\\Users\\ada\\Documents" }],
    };
    expect(completions(windows, "C:\\Users\\ada\\Doc")).toHaveLength(1);
  });
});

describe("separatorOf", () => {
  it("is the backslash only where the path has no slash", () => {
    expect(separatorOf("C:\\Users\\ada")).toBe("\\");
    expect(separatorOf("/Users/ada")).toBe("/");
    expect(separatorOf("/Users/ada/a\\b")).toBe("/");
  });
});

describe("trimmedPath", () => {
  it("drops the separator a typed path ends in, but keeps the root", () => {
    expect(trimmedPath(" /Users/ada/Trips/ ")).toBe("/Users/ada/Trips");
    expect(trimmedPath("/")).toBe("/");
    expect(trimmedPath("/Users/ada")).toBe("/Users/ada");
  });
});

describe("tilde", () => {
  it("writes the home folder as ~ and leaves other paths as they are", () => {
    expect(tilde("/Users/ada/Documents/Trips", "/Users/ada")).toBe("~/Documents/Trips");
    expect(tilde("/Users/ada", "/Users/ada")).toBe("~");
    expect(tilde("/Users/adam/x", "/Users/ada")).toBe("/Users/adam/x");
    expect(tilde("/Volumes/Disk", undefined)).toBe("/Volumes/Disk");
  });
});

describe("nameOf", () => {
  it("is the last part of a path", () => {
    expect(nameOf("/Users/ada/Trips/")).toBe("Trips");
    expect(nameOf("C:\\Users\\ada")).toBe("ada");
  });
});

describe("crumbs", () => {
  it("leads from the home folder down to the folder", () => {
    expect(crumbs("/Users/ada/Documents/Trips", "/Users/ada")).toEqual([
      { name: "ada", path: "/Users/ada" },
      { name: "Documents", path: "/Users/ada/Documents" },
      { name: "Trips", path: "/Users/ada/Documents/Trips" },
    ]);
    expect(crumbs("/Users/ada", "/Users/ada")).toEqual([{ name: "ada", path: "/Users/ada" }]);
  });
});
