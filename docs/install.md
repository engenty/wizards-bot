# Installing a Bot Server from a release

Every release of `engenty/wizards-bot` carries `wizards-bot-<version>.tgz`: the Bot Server, its web
app built, and the packages of this repository it needs. It runs on macOS and Linux with Node
24.11 or newer and needs no pnpm and no build.

`wizards bot install` of the `wizards` command does all of this for you. By hand:

```bash
mkdir -p ~/wizards-bot/0.2.0 && cd ~/wizards-bot/0.2.0
```

```bash
curl -fsSL https://github.com/engenty/wizards-bot/releases/download/v0.2.0/wizards-bot-0.2.0.tgz | tar -xz --strip-components=1
```

```bash
npm install --omit=dev
```

```bash
node apps/home/src/cli.ts start
```

- Unpack it into a folder of its own, not into `node_modules`: Node runs the Bot Server's TypeScript
  only outside `node_modules`. `npm install -g` of the tarball does not work for that reason.
- `npm install` takes the versions of `package-lock.json` in the tarball. The packages of this
  repository are folders in it (`packages/`), linked from `node_modules`.
- The command is `bin.wizards-bot` of its `package.json`, `apps/home/src/cli.ts`. Make it a
  command with a small script that runs it with your Node:

  ```bash
  printf '#!/bin/sh\nexec node "%s/apps/home/src/cli.ts" "$@"\n' "$PWD" > ~/.local/bin/wizards-bot && chmod +x ~/.local/bin/wizards-bot
  ```

- The data stays in `~/.engenty/wizards-bot` (`WIZARDS_BOT_DATA`), apart from the version: a new
  version is a new folder, and the old one can go once the new one runs. Earlier Bot Servers
  kept it in `~/.wizards-bot`; the first start of a newer one moves it over, in one rename, and
  says so. When both folders are there it uses the new one and says the old one is still there.
- It listens on port 4747 (`WIZARDS_BOT_PORT`). `GET /health` answers `{ "ok": true, "home": true,
  "version": "…" }` once it runs.

## A tarball from this repository

```bash
pnpm install
```

```bash
pnpm pack:home
```

It builds the web app and writes `dist/wizards-bot-<version>.tgz`, the same file a release
carries (`--no-build` takes the web app as it is built). The release workflow builds it the
same way, installs it into an empty folder and starts it before it attaches it.
