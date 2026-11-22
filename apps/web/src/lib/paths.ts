import type { FolderListing } from "@wizards-bot/protocol";

/** What parts a path of the home's computer: `\` on Windows, `/` everywhere else. */
export function separatorOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** A typed path as the home takes it: without the separator it may end in. */
export function trimmedPath(typed: string): string {
  const path = typed.trim();
  const sep = separatorOf(path);
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/**
 * The folders that complete what is typed. The home lists the folder the half-typed name is
 * in; the ones that start as the name does are offered, without regard to case.
 */
export function completions(listing: FolderListing, typed: string): FolderListing["folders"] {
  const sep = separatorOf(typed || listing.path);
  const stem = typed.slice(typed.lastIndexOf(sep) + 1).toLowerCase();
  return listing.folders.filter(
    (folder) => folder.name.toLowerCase().startsWith(stem) && folder.path !== typed,
  );
}
