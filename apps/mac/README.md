# wizards.bot for the Mac

The Mac app is a window on a Bot Server, and the way to run one on a Mac without a terminal. Its
window shows the Bot Server's web app (`apps/web`) in a web view; the app around it is Swift. What
it does and why is in `docs/mac-app.md`.

- **Connect to a Bot Server**: its address and the code it shows, or a `wizardsbot://pair` link.
  The web app pairs itself with the code; the device is called after the Mac.
- **Start on this Mac**: the app registers the LaunchAgent `bot.wizards.home`
  (`LaunchAgents/bot.wizards.home.plist`) with `SMAppService`. launchd starts the app's own
  program with `--home` (`App/HomeLauncher.swift`), which sends its output to
  `~/.wizards-bot/logs/home.log` and becomes the Node in `Contents/Resources/node` running the
  home in `Contents/Resources/bot`. The Bot Server keeps running when the app quits.
- A Bot Server that already answers on port 4747 (one of `wizards bot install`, or one started by
  hand) is used as it is; the app starts no second one.
- The web app knows it runs in the app (`apps/web/src/lib/mac.ts`) and hands it notifications,
  the number of what needs you for the Dock, and, for a Bot Server on this Mac, the folder dialog.
- Updates come through Sparkle, from `appcast.xml` of the newest GitHub release, in a build that
  names `SPARKLE_PUBLIC_KEY`. After an update the app starts its Bot Server anew.

## What you need

- Xcode 26 or newer. Sparkle is the one package; Xcode fetches it.
- For a build with the Bot Server inside: Node 24.11 or newer and the repository's packages
  (`pnpm install`).

## Build and run

The shell alone, which connects to a Bot Server but has none inside:

```sh
xcodebuild -project WizardsMac.xcodeproj -scheme wizards -derivedDataPath build build
open build/Build/Products/Debug/wizards.app
```

A home of this repository to connect it to, on its own port and data folder:

```sh
WIZARDS_BOT_DATA=/tmp/wizards-mac-dev WIZARDS_BOT_PORT=4800 node ../home/src/cli.ts start
WIZARDS_BOT_DATA=/tmp/wizards-mac-dev node ../home/src/cli.ts pair
```

The whole app, with Node and the Bot Server inside, signed with the first Apple Development
certificate of the keychain (`MAC_SIGN_IDENTITY` names another), from the repository's root:

```sh
pnpm pack:mac            # dist/mac/wizards.app
pnpm pack:mac --dmg      # and dist/mac/wizards-bot-mac-arm64.dmg
```

`pack:mac` builds the release tarball, installs it for darwin-arm64, prunes it, adds the official
Node checked against nodejs.org's `SHASUMS256.txt`, signs every native module, Node (with
`allow-jit` and `allow-unsigned-executable-memory`) and the app, and starts the Bot Server once
from the bundle before it is done. A release signs with the Developer ID and notarizes
(`.github/workflows/release.yml`, job `mac`, which says which secrets it needs).

## Test

```sh
xcodebuild -project WizardsMac.xcodeproj -scheme wizards -derivedDataPath build test
```

The tests cover what is not the window: addresses as people type them, pairing links, what
`/health` answers, versions, what `wizards-bot pair` prints and a login shell's `PATH`. Like the
iOS app, the Mac app is built and tested on a Mac before a change lands, not in CI.
