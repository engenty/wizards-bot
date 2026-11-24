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

/** A path with the person's home folder as `~`, e.g. `~/Documents/Trips`. */
export function tilde(path: string, home: string | undefined): string {
  if (!home) {
    return path;
  }
  const sep = separatorOf(home);
  if (path === home) {
    return "~";
  }
  return path.startsWith(home + sep) ? `~${sep}${path.slice(home.length + 1)}` : path;
}

/** The last part of a path: the folder's own name. */
export function nameOf(path: string): string {
  const parts = trimmedPath(path).split(separatorOf(path));
  return parts.at(-1) || path;
}

/**
 * The folders from the person's home folder down to `path`, each with its path: the breadcrumbs
 * of the folder picker. The home folder itself comes first.
 */
export function crumbs(path: string, home: string): { name: string; path: string }[] {
  const sep = separatorOf(home);
  const steps = [{ name: nameOf(home), path: home }];
  if (!path.startsWith(home + sep)) {
    return steps;
  }
  let at = home;
  for (const part of path
    .slice(home.length + 1)
    .split(sep)
    .filter(Boolean)) {
    at = `${at}${sep}${part}`;
    steps.push({ name: part, path: at });
  }
  return steps;
}
