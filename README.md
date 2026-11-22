# wizards.bot

Your personal agent. Run it on your own computer, host it yourself on a server, and connect it
to other people's homes, peer to peer.

A **home** is this program. It keeps your agents, their memory, your conversations and the keys
to your accounts. You talk to it in the iOS and watch app, in a browser, in a terminal, or over
Slack, email, WhatsApp and Signal. You set everything up by talking to it.

## Start

Needs Node 24.11 or newer and pnpm.

```bash
pnpm install
pnpm build
pnpm start
```

The home says its address and which model it uses. Open the address in a browser: the setup
tests the models and pairs your phone. Or, in another terminal:

```bash
pnpm wizards-bot doctor
```

```bash
pnpm wizards-bot pair
```

`doctor` tests each model and checks the home. `pair` shows a QR for the iOS app and a link for
a browser.

## Where it runs

|              |                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local        | on your computer, with Claude Code, Codex or Ollama there                                                                                                                        |
| self-hosted  | on your server ([docs/vps.md](docs/vps.md)), with a gateway, or with your computer's models while it is on (`pnpm wizards-bot link`)                                             |
| peer to peer | homes talk to each other directly, with signed requests and no central server: share an agent, invite someone, meet in a room. A laptop home is reached through a contact's home |

## Repository

```
apps/home/           the home: Node, Mastra, SQLite
apps/web/            the web app: React, Vite, Tailwind; the home serves its build
apps/ios/            the iOS and watch app (SwiftUI)
packages/protocol/   what a home and its devices say to each other
packages/avatar/     your avatar, a pixel figure
docs/                protocol, network, privacy, App Review, roadmap
```

## Develop

```bash
pnpm test
pnpm typecheck
pnpm lint
```

The tests run whole homes against a scripted model, without a key or a network.
How changes and releases land: [CONTRIBUTING.md](CONTRIBUTING.md). What changed: [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT, see [LICENSE](LICENSE).
