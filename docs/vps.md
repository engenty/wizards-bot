# A Bot Server on a server

A Bot Server on a server is reachable from everywhere: your phone away from home, your channels'
webhooks, other people's homes. It has no models of its own.

Every release publishes the image `ghcr.io/engenty/wizards-bot:<version>` and `:latest`, for
amd64 and arm64 (or build it yourself: `docker build -t wizards-bot .`).

```bash
docker run -d --name wizards-bot --restart unless-stopped -p 4747:4747 -v wizards-bot:/data -v wizards-bot-files:/files -e WIZARDS_BOT_URL=https://me.example.com ghcr.io/engenty/wizards-bot:latest
```

`GET /health` answers `{ "ok": true }` without signing in; the image checks it by itself.

Put it behind a proxy that ends TLS (Caddy, Traefik, Coolify) and forwards to port 4747.
`WIZARDS_BOT_URL` is the address others reach it at; your handle becomes `you@me.example.com`.
The event stream and the link are long-lived connections: the proxy must not buffer them or cut
them after a minute.

Then:

1. `docker exec -it wizards-bot wizards-bot pair` shows a code. Pair your phone with it.
2. On your computer, `wizards-bot link https://me.example.com <code>` with a second code. While
   it runs, the Bot Server uses your computer's Ollama and subscriptions.
3. In the chat: "add OpenRouter" (or another gateway) for the hours your computer is off.

`/data` holds the database, the Bot Server's key and the key that encrypts your secrets. Back it up
as one.

`/files` is the Bot Server's one folder of files (`WIZARDS_BOT_FILES`): the agents' own folder,
connected for changes from the start. Folders the agents ask for are made and connected inside
it; nothing else of the server is reached.

## Export and import

```bash
docker exec -it wizards-bot wizards-bot export /data/home.export
```

writes all of `/data` into one file, encrypted with a passphrase you choose and keep apart. It
works while the Bot Server runs. Without the passphrase the file shows nothing, also not to whoever
keeps the server or the backups. The passphrase is asked in the terminal, or read from
`--passphrase-file <file>` or `WIZARDS_BOT_PASSPHRASE`.

`wizards-bot import <file>` brings an export into an empty data folder: a new volume, or
`~/.engenty/wizards-bot` on a computer that has no Bot Server yet. The Bot Server must not run meanwhile:

```bash
docker run --rm -it -v wizards-bot-new:/data -v "$PWD":/in ghcr.io/engenty/wizards-bot:latest wizards-bot import /in/home.export
```

The Bot Server that starts from it is the same Bot Server: its key, its handle, its contacts, its secrets.
A wrong passphrase or a changed byte unpacks nothing.

## A demo Bot Server for App Review

App Review pairs the iOS app with a Bot Server that runs for the whole review. Start one with
`-e WIZARDS_BOT_DEMO_CODE=<at least 8 letters and digits>`: that code pairs any number of devices
and does not run out. Add a gateway with a key, keep no one's real data in it, and put its address
and the code into the review notes ([app-review.md](app-review.md)).

## A hosted Bot Server

A hosted Bot Server runs at `<name>.wizards.bot` and spends the credits of a wizards account
([hosted.md](hosted.md)). The Manage-App makes it in Coolify from the image, with a volume on
`/data`, port 4747, and these settings:

| Setting                  | What it is                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `WIZARDS_BOT_URL`        | `https://<name>.wizards.bot`                                                                     |
| `WIZARDS_BOT_SETUP_CODE` | a pairing code (`K7QM-2RXD`) that pairs the first device and then ends                           |
| `WIZARDS_BOT_MANAGE_URL` | the Manage-App's address                                                                         |
| `WIZARDS_BOT_HOME_TOKEN` | a token that works once: the Bot Server claims its way to the gateway with it on its first start |

On its first start the Bot Server sends `POST <MANAGE_URL>/v1/homes/claim` with the token as bearer
and keeps what comes back: the gateway's address, its key (in the Bot Server’s secrets, encrypted
with the key in `/data`), its handle `<name>@wizards.bot` and, when the account has one, the
person’s name, which the setup shows for the person to confirm. Without one, and on any server
where the computer’s account is `root`, the setup asks for the name. A later start has them and does
not claim again. A claim the Manage-App refuses (the token was used, 409) is not tried again;
one that does not reach it is tried every 30 seconds for ten minutes.

The account is the model source "wizards account": the AI SDK's gateway client at
`<gatewayUrl>/v4/ai` with the Bot Server's key, which names the person's team. The setup shows it
first and tests it with one short call right after the claim, so it is green when the person
arrives. There are no Ollama and no subscription checks on the server. A key of one's own (a
gateway or a provider) and the person's computer (`wizards bot setup --link <address> <code>`,
which runs `wizards-bot link`) are two more lines, neither needed.

The person lands on `https://<name>.wizards.bot/#code=<SETUP_CODE>`, which pairs the browser
with the setup code. From then on the code is used up; more devices pair with a code from the
setup's QR or from "Add a device".

The Manage-App reads nothing on a Bot Server. An export is made by the Bot Server with the person's
passphrase (above). Backups that run by themselves, encrypted for the person without asking for
the passphrase each time, are not built yet.
