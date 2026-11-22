import { existsSync, readFileSync } from "node:fs";

// The libraries an artifact may use. They are the home's own npm dependencies. A page names
// them by fixed addresses and names; the home puts their text into the page it serves, so the
// page asks no one for anything: no CDN, and not the home either.

/** Where every library address starts, as an agent writes it. */
export const LIB_PREFIX = "/artifact-lib/";

const D3 = new URL("./d3.min.js", import.meta.resolve("d3"));
const THREE = new URL("./", import.meta.resolve("three"));
const ADDONS = new URL("../examples/jsm/", THREE);

const FIXED: Record<string, URL> = {
  "d3.js": D3,
  "three.js": new URL("three.module.js", THREE),
  // three.js imports its core by this name, relative to its own address.
  "three.core.js": new URL("three.core.js", THREE),
};
/** A file of three's addons: folders and a file name, with no way up or out. */
const ADDON = /^three\/addons\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js)$/;

const versionOf = (file: URL, up: string): string =>
  (JSON.parse(readFileSync(new URL(`${up}package.json`, file), "utf8")) as { version: string })
    .version;

export const D3_VERSION = versionOf(D3, "../");
export const THREE_VERSION = versionOf(THREE, "../");

function fileOf(name: string): { file: URL; version: string } | undefined {
  const fixed = FIXED[name];
  if (fixed) return { file: fixed, version: name === "d3.js" ? D3_VERSION : THREE_VERSION };
  const addon = ADDON.exec(name)?.[1];
  return addon ? { file: new URL(addon, ADDONS), version: THREE_VERSION } : undefined;
}

/** Whether `name` (the address after the prefix) is a library the home serves. */
export function hasLibrary(name: string): boolean {
  const found = fileOf(name);
  return found !== undefined && existsSync(found.file);
}

const texts = new Map<string, string>();

/** A library's text by the address after the prefix, e.g. `d3.js`. */
function textOf(name: string): string | undefined {
  const known = texts.get(name);
  if (known !== undefined) return known;
  const found = fileOf(name);
  if (!found || !existsSync(found.file)) return undefined;
  const text = readFileSync(found.file, "utf8");
  texts.set(name, text);
  return text;
}

/** D3, to stand in a classic script: it gives the page the global `d3`. */
export function d3Source(): string {
  return textOf("d3.js") as string;
}

// ── Modules ─────────────────────────────────────────────────────────────────

/** three.js imports its core by a path beside itself. In a page it has this name. */
const CORE = "three/core";
const ADDONS_NAME = "three/addons/";
const RELATIVE = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\2/g;
const NAMED = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](three(?:\/[^"']+)?)["']/g;

/** The file a module name stands for, as an address after the prefix. */
function fileNameOf(name: string): string | undefined {
  if (name === "three") return "three.js";
  if (name === CORE) return "three.core.js";
  return name.startsWith(ADDONS_NAME) && hasLibrary(name) ? name : undefined;
}

interface Module {
  /** The module's text as a `data:` address: an import map entry that asks no one. */
  address: string;
  /** The names this module imports itself. */
  imports: string[];
}

const modules = new Map<string, Module | undefined>();

/**
 * A module by the name a page imports. A file imports its neighbours by path (`./x.js`),
 * which leads nowhere once the text is the address; those imports are written as names, and
 * the import map resolves them like the page's own.
 */
function moduleOf(name: string): Module | undefined {
  if (modules.has(name)) return modules.get(name);
  const file = fileNameOf(name);
  const text = file === undefined ? undefined : textOf(file);
  let made: Module | undefined;
  if (file !== undefined && text !== undefined) {
    const named = text.replace(RELATIVE, (_all, lead: string, quote: string, path: string) => {
      const target = new URL(path, `file:///${file}`).pathname.slice(1);
      const as = target === "three.core.js" ? CORE : target === "three.js" ? "three" : target;
      return `${lead}${quote}${as}${quote}`;
    });
    made = {
      address: `data:text/javascript;charset=utf-8,${encodeURIComponent(named)}`,
      imports: [...new Set([...named.matchAll(NAMED)].map(([, imported = ""]) => imported))],
    };
  }
  modules.set(name, made);
  return made;
}

/**
 * The import map for a page that imports `names`: each name, and every module those import
 * in turn, stands for the module's own text. A name a page gave as an address
 * (`/artifact-lib/three.js`) is mapped as it was written.
 */
export function importMap(names: Iterable<string>): { imports: Record<string, string> } {
  const imports: Record<string, string> = {};
  const add = (written: string): void => {
    if (written in imports) return;
    const address = written.startsWith(LIB_PREFIX) ? written.slice(LIB_PREFIX.length) : written;
    const name = address === "three.js" ? "three" : address === "three.core.js" ? CORE : address;
    const found = moduleOf(name);
    if (!found) return;
    imports[written] = found.address;
    for (const next of found.imports) add(next);
  };
  for (const name of names) add(name);
  return { imports };
}
