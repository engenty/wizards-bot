import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

// What no agent reaches in a connected folder, and which folders no home connects. The folder
// tools, the file browser and the picker all ask these, so the person sees what the agents see.

/** Names passed over everywhere: folders that hold no one's own work. */
const SKIPPED = new Set([
  "node_modules",
  "__pycache__",
  "$RECYCLE.BIN",
  "System Volume Information",
]);

/** Files that hold keys, passwords or sign-ins, by their name. They stay closed, also when named. */
const SECRET = [
  /\.(pem|key|p12|pfx|kdbx|keychain|keychain-db|ovpn|tfstate|gpg|asc|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[._-])env$/i,
  /^env\./i,
  /credentials?[^/]*\.(json|csv|txt|ya?ml)$/i,
  /^(secrets?|passwords?|tokens?)\.(json|txt|ya?ml|csv)$/i,
];

/** Files a computer runs when they are opened. An agent writes none of them. */
const EXECUTABLE =
  /\.(app|command|tool|sh|bash|zsh|fish|scpt|scptd|applescript|workflow|terminal|pkg|dmg|exe|bat|cmd|com|msi|ps1|vbs|lnk|scr|jar|desktop|appimage)$/i;

/** Shown to the agents and to the person: not hidden, no Office lock file, no secret. */
export const visible = (name: string): boolean =>
  !name.startsWith(".") && !name.startsWith("~$") && !SKIPPED.has(name) && !secret(name);

export const secret = (name: string): boolean => SECRET.some((pattern) => pattern.test(name));

export const executable = (name: string): boolean => EXECUTABLE.test(name);

/** What a path inside a folder is not allowed to be, or nothing when it is fine. */
export function badPart(parts: string[]): "outside" | "hidden" | "secret" | undefined {
  for (const part of parts) {
    if (part === "..") return "outside";
    if (secret(part)) return "secret";
    if (!visible(part)) return "hidden";
  }
  return undefined;
}

/** Places of the system, refused with everything inside them. */
const SYSTEM_TREES = [
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/var",
  "/private",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "/opt",
  "/Applications",
  "/root",
  "/run",
  "/snap",
  "/lib",
  "/lib64",
  "/srv",
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
];
/** Places refused as a whole, whose folders may be connected: the disk, the list of disks. */
const SYSTEM_ROOTS = ["/", "/Volumes", "/media", "/mnt", "/home", "/Users"];

export const inside = (parent: string, path: string): boolean => {
  const rest = relative(parent, path);
  return (
    rest === "" || (!rest.startsWith("..") && !rest.startsWith(sep) && !/^[A-Za-z]:/.test(rest))
  );
};

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Why a folder cannot be connected, or nothing when it can. `path` is a real path. The home's
 * own temporary folder is the person's (a program unpacked something there), not the system's.
 */
export function refusedFolder(
  path: string,
  dataDir: string,
): "system" | "whole" | "data" | "hidden" | undefined {
  const home = real(homedir());
  const data = real(dataDir);
  if (path === home || SYSTEM_ROOTS.map(real).includes(path) || SYSTEM_ROOTS.includes(path))
    return "whole";
  if (inside(data, path) || inside(path, data)) return "data";
  if (inside(join(home, "Library"), path)) return "system";
  const temp = real(tmpdir());
  if (
    !inside(temp, path) &&
    SYSTEM_TREES.some((tree) => inside(tree, path) || inside(real(tree), path))
  )
    return "system";
  if (path.split(sep).some((part) => part.startsWith("."))) return "hidden";
  return undefined;
}

/**
 * Whether a path inside `root` reaches only through folders and files of its own: no part on
 * the way, the last included, is a link. A link may lead anywhere, also to a place that is not
 * there yet, where a write would make a file outside.
 */
export function noLinks(root: string, full: string): boolean {
  const rest = relative(root, full);
  if (!rest) return true;
  let at = root;
  for (const part of rest.split(sep)) {
    at = join(at, part);
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (!stat) return true;
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

/** A file with more than one name: changing it changes a file elsewhere too. */
export function sharedFile(full: string): boolean {
  const stat = lstatSync(full, { throwIfNoEntry: false });
  return Boolean(stat?.isFile() && stat.nlink > 1);
}
