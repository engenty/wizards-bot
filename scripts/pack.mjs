#!/usr/bin/env node
// Builds the tarball a computer installs the home from (docs/hosted.md, Contract 2):
// dist/wizards-bot-<version>.tgz with the home, the built web app and the workspace packages,
// and a package.json whose dependencies `npm install --omit=dev` installs. The release attaches
// it to the GitHub release; `wizards bot install` takes it from there (docs/install.md).
//
//   node scripts/pack.mjs              build the web app, then the tarball
//   node scripts/pack.mjs --no-build   use the web app as built already
//
// Node runs the home's TypeScript only outside node_modules, so the tarball is unpacked into a
// folder of its own and the workspace packages stay in it as folders. npm links them from
// node_modules (`file:`); Node follows the link to where they are and strips their types.
// The direct dependencies are pinned to what pnpm-lock.yaml resolved, and a package-lock.json
// made from them goes with the tarball, so every install gets the same packages.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });

const { version, engines, license } = read("package.json");
const home = read("apps/home/package.json");
const WORKSPACE = { "@wizards-bot/protocol": "protocol", "@wizards-bot/avatar": "avatar" };

if (!process.argv.includes("--no-build")) {
  console.log("Building the web app …");
  run("pnpm", ["build"]);
}
if (!existsSync(join(root, "apps/web/dist/index.html"))) {
  console.error("apps/web/dist has no index.html. Run pnpm build first.");
  process.exit(1);
}

// What pnpm installed for the home: its direct dependencies at the versions it resolved.
const [listed] = JSON.parse(
  run("pnpm", ["list", "--filter", "@wizards-bot/home", "--prod", "--depth", "0", "--json"]),
);
const resolved = (name) => {
  const found = listed?.dependencies?.[name]?.version;
  if (!found) throw new Error(`pnpm did not resolve ${name}. Run pnpm install first.`);
  return found;
};
const pin = (dependencies, from) =>
  Object.fromEntries(
    Object.entries(dependencies ?? {}).map(([name, range]) => [
      name,
      range.startsWith("workspace:") ? `file:${from}${WORKSPACE[name]}` : resolved(name),
    ]),
  );

const stage = mkdtempSync(join(tmpdir(), "wizards-bot-pack-"));
const dir = join(stage, "package");
mkdirSync(dir);

// The home's code, without its tests.
cpSync(join(root, "apps/home/src"), join(dir, "apps/home/src"), {
  recursive: true,
  filter: (path) => !path.endsWith(".test.ts") && !path.includes("/src/test"),
});
cpSync(join(root, "apps/web/dist"), join(dir, "apps/web/dist"), { recursive: true });
for (const name of Object.values(WORKSPACE)) {
  const source = join(root, "packages", name);
  cpSync(join(source, "src"), join(dir, "packages", name, "src"), {
    recursive: true,
    filter: (path) => !path.endsWith(".test.ts"),
  });
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  delete pkg.scripts;
  delete pkg.devDependencies;
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies ?? {}).map(([dep, range]) =>
      range.startsWith("workspace:") ? [dep, `file:../${WORKSPACE[dep]}`] : [dep, range],
    ),
  );
  writeFileSync(join(dir, "packages", name, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}
for (const file of ["README.md", "LICENSE", "CHANGELOG.md", "docs/install.md"]) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(dir, file));
}

const manifest = {
  name: "wizards-bot",
  version,
  description: "wizards.bot: your own agent, in your own home.",
  license,
  type: "module",
  private: true,
  engines,
  bin: { "wizards-bot": "apps/home/src/cli.ts" },
  scripts: { start: "node apps/home/src/cli.ts start" },
  dependencies: pin(home.dependencies, "packages/"),
};
writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// npm runs no package's own install script: the home needs none, and @openuidev/lang-core
// (the parser of the views agents show) would report the install to its maker with one.
writeFileSync(join(dir, ".npmrc"), "ignore-scripts=true\n");

console.log("Resolving the packages for package-lock.json …");
run(
  "npm",
  ["install", "--package-lock-only", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  dir,
);

mkdirSync(join(root, "dist"), { recursive: true });
const file = join(root, "dist", `wizards-bot-${version}.tgz`);
rmSync(file, { force: true });
run("tar", ["-czf", file, "-C", stage, "package"]);
rmSync(stage, { recursive: true, force: true });
console.log(file);
