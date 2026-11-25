# Hosted homes

A plan, written 2026-11-22. Nothing here is built.

A hosted home is a home that runs for someone on our server, at `<name>.wizards.bot`. It is the
same home as on a computer: its own data, its own key, its own agents. The Manage-App of engenty
wizards gives it what a home on a computer has from elsewhere: an account, models through the
gateway, a bill, and someone who starts, updates and backs it up.

## How far apart homes are

| Level | What is separate                 | What is shared                            | Example                              |
| ----- | -------------------------------- | ----------------------------------------- | ------------------------------------ |
| 1     | a database and a folder per team | the processes, the keys, the browser      | engenty wizards' cloud runtime today |
| 2     | everything of one team           | the Manage-App: sign-in, gateway, credits | one runtime per team (not built)     |
| 3     | everything of one person         | the Manage-App, only from outside         | a home per person                    |

Hosted homes are level 3: one container and one volume per home. A team's home (the group home
of [network.md](network.md)) is level 2 on the same machinery: one container for one team. Its
people are the team's members in the Manage-App, and its admins are the owners and admins among
them (Contracts 10 and 11).

- The home's data, its key and the key of its secrets stay in its volume.
- The Manage-App starts, stops, updates and deletes a home. It reads nothing in it.
- The home reaches the gateway with a key that names one team. A leaked key spends that team's
  credits and nothing else. A home never gets a runtime's service key: that key names any team.

## Onboarding

1. **Sign up** at `wizards.bot/start` with the wizards account, the same account as for
   engenty wizards. Its sign-in is the Manage-App's. The person picks an address, `ada`.
2. **The Manage-App makes the home** through Coolify's API: a container from the published
   image, a volume, the address `ada.wizards.bot`, and the home's settings: its address, a setup
   code that works once, and the way to the gateway.
3. **The person lands on `https://ada.wizards.bot/#setup=<code>`.** The home's own setup runs as
   on a computer (`apps/home/src/setup`): the models with their test calls, then the phone.
   The gateway is green from the start. Bringing a key of one's own (a gateway or a provider) or
   linking one's computer is one more line in the same step, nothing else.
4. **A welcome mail** from the Manage-App with the link.
5. Later the person goes to the Manage-App only for the plan, the credits, the backup, the
   export and to delete the home. Devices pair with the home itself, never through the
   Manage-App.

## Addresses

One address belongs to one team and serves everything of that team: its pages at
`<name>.wizards.page` and its home at `<name>.wizards.bot`. The Manage-App keeps it
(`organization.slug`) and its rules apply to both (`apps/server/src/address.ts`):

- 3 to 30 characters, `a-z`, `0-9` and hyphens, no hyphen at either end or twice in a row.
- Not a reserved word, not offensive, not a brand unless its domain is proven (a DNS TXT
  record).
- Its creator may change it once in the team's first 14 days, afterwards only an admin. An
  address given up stays the team's for 90 days.

The reserved words grow by the words a home's address must not be (`www`, `mail`, `status`,
`start` and the like). The home's handle is `ada@wizards.bot`: `wizards.bot/.well-known/wizards.json`
names every hosted home (`{ "names": { "ada": "https://ada.wizards.bot" } }`), made from the
Manage-App's list. `wizards.id` stays the directory of [network.md](network.md).

A home belongs to a team, so one address is one home:

- A new person gets a personal team, and the home its address.
- A person who has a team already picks it, or a personal team for a home of their own.
- A team with several members that picks its own address gets the team's home (level 2).

## Resources

One home at rest takes about 160 MB of memory, 240 MB at its peak (measured on a Mac on
2026-11-22, the home of this repo with Ollama and two subscriptions). Its data was 28 MB. The
VPS has 16 GB, so about 60 homes running at the same time beside Coolify, before any sleeps.

| Way                                          | Memory per home                                  | Separation              | Fits                                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A container per home                         | the home's own, plus a few MB                    | level 3                 | yes, the plan                                                                                                                                                                                                                                 |
| A container per home that sleeps when unused | nothing while it sleeps                          | level 3                 | later: the proxy wakes it on a request, the Manage-App when a task is due. A home with Slack or mail stays awake                                                                                                                              |
| A process per home, no container             | the same as a container                          | weaker: one file system | no: saves nothing                                                                                                                                                                                                                             |
| Many homes in one process                    | less: one Node for all                           | level 1                 | no: the home keeps one data folder and one key per process, and a crash would hit everyone                                                                                                                                                    |
| One agentOS VM per home (Rivet)              | 10 to 20 MB per VM over a helper of about 330 MB | strong                  | no: agentOS runs bash, Node and Python as WebAssembly and V8 isolates, without native programs. The home needs `node:sqlite`, libSQL's native module and a server others reach. agentOS fits a home's sandbox for code, as in engenty wizards |

## What changes

### Manage-App (engenty-wizards-manage)

1. A key per home for the gateway: it names one team, can be taken back, has its own rate limit.
2. A table of homes: the team, the address, the Coolify reference, the image version, the state
   (making, running, sleeping, stopped, deleted).
3. Coolify's API: make a home, update every home to a new image, stop it, delete it.
4. The sign-up at `wizards.bot/start`, the address shared with the pages and the new reserved
   words.
5. The welcome mail for a home.
6. `wizards.bot/.well-known/wizards.json` from the table of homes.
7. A plan for a hosted home; its price is set in the Manage-App later. Model calls spend the
   team's credits.
8. Encrypted backups of every volume, with a key the operator cannot read with, and the export
   for the person.
9. The admin app: list, restart, stop a home. No way into its content.
10. The gateway speaks Vercel's AI Gateway protocol (`/v4/ai/language-model`), a home's gateways
    the OpenAI-compatible API. One of the two learns the other's (see the home's first point).

### engenty wizards

- `docs/manage-contract.md`: homes as a second kind of client, with their key.
- Moving the account and the gateway from engenty.ai to a wizards domain, decided in its own
  discussion.

### The home (this repo)

1. The gateway of the account as a model source: the AI SDK's gateway client pointed at the
   Manage-App, or the OpenAI-compatible way if the Manage-App adds it.
2. `WIZARDS_BOT_SETUP_CODE`: pairs the first device and then ends. `WIZARDS_BOT_DEMO_CODE` does
   not run out and stays for App Review.
3. The setup knows a hosted home: the gateway set, no Ollama or subscription checks on the
   server, a key of one's own and the own computer as optional lines.
4. The image on GHCR: `release.yml` publishes it with every tag, and homes pull it.
5. A health route for Coolify and the status page.
6. Export and import of `/data`, and the backup's encryption on the home's side.
7. [vps.md](vps.md) gets the hosted home.

## Decisions

| #   | Question                          | Decision                                                                                  |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Which team pays                   | a personal team for a new person, or a team the person has already                        |
| 2   | The account's domain              | wizards, no more engenty.ai; the name comes from its own discussion                       |
| 3   | How the home gets its gateway key | the home fetches it once with a token that works once (Contract, 3)                       |
| 4   | Models                            | the gateway's credits, and a key of one's own too, kept simple in the setup               |
| 5   | Price                             | later, in the Manage-App                                                                  |
| 6   | Backups                           | encrypted                                                                                 |
| 7   | Sleeping homes                    | not in the first version                                                                  |
| 8   | Who may make a home               | everyone signed in, up to `HOMES_MAX` homes on the server; an admin can close the sign-up |

## Contract

What the home, the Manage-App and the `wizards` command agree on. A change here changes all three.

1. **Image.** `ghcr.io/engenty/wizards-bot:<version>` and `:latest`, linux/amd64 and
   linux/arm64, public. The home's `release.yml` publishes it for every tag `v*`.
2. **Local install.** Every GitHub release of `engenty/wizards-bot` carries
   `wizards-bot-<version>.tgz`: the home with the built web app and the workspace packages in it,
   and a `package.json` whose dependencies `npm install --omit=dev` installs with Node 24.11 or
   newer. Its `bin` is `wizards-bot`. Data stays in `~/.engenty/wizards-bot`; the home moves a
   `~/.wizards-bot` of an earlier Bot Server there on its first start. `docs/install.md` says
   how.
3. **A hosted home's settings.** The Manage-App starts it with:
   - `WIZARDS_BOT_URL=https://<address>.wizards.bot`
   - `WIZARDS_BOT_SETUP_CODE`: a pairing code in the home's format (`K7QM-2RXD`) that pairs the
     first device and then ends.
   - `WIZARDS_BOT_MANAGE_URL`: the Manage-App's address.
   - `WIZARDS_BOT_HOME_TOKEN`: works once. On its first start the home sends
     `POST <MANAGE_URL>/v1/homes/claim` with `Authorization: Bearer <token>` and gets
     `{ "gatewayUrl", "gatewayKey", "handle", "name"? }` (`name`: the person’s name in the account, when it has
     one). It keeps the key in its secrets. A second claim
     gets 409.
4. **The gateway.** The home calls the Manage-App's gateway as engenty wizards' runtime does,
   with the AI SDK's gateway client at `<gatewayUrl>/v4/ai` and `Authorization: Bearer
   <gatewayKey>`. A home's key names its team; the home sends no `x-wizards-tenant`. In the home
   this is the model source "wizards account".
5. **Health.** `GET /health` answers 200 `{ "ok": true }` without signing in.
6. **Sign-up.** `https://wizards.bot/start` (the Manage-App). After the home answers on
   `/health`, the person lands on `https://<address>.wizards.bot/#code=<SETUP_CODE>`, which pairs
   the browser (the web app's pairing link today). The setup there shows the QR for the iPhone.
7. **Names.** `https://wizards.bot/.well-known/wizards.json` answers
   `{ "names": { "<address>": "https://<address>.wizards.bot" } }` for every running home. The
   handle the claim returns is `<address>@wizards.bot`; the home sets it as its handle.
8. **Coolify.** The Manage-App makes a home as an application from the image: domain
   `https://<address>.wizards.bot`, port 4747, a volume on `/data`, the settings of 3. It reads
   `COOLIFY_API_URL`, `COOLIFY_API_TOKEN`, `COOLIFY_PROJECT_UUID`, `COOLIFY_SERVER_UUID`,
   `COOLIFY_ENVIRONMENT`, `HOMES_IMAGE` and `HOMES_MAX`.
9. **The `wizards` command** (npm `wizards`, engenty wizards' repo):
   - `wizards bot install`: takes the newest release's tarball (2), puts it in
     `~/.engenty/wizards/bot/<version>`, installs it with the Node the wizards installer brought,
     makes `wizards-bot` a command, starts the home as a service of the person (launchd on macOS,
     systemd `--user` on Linux) on port 4747 and opens its setup in the browser.
   - `wizards bot setup`: opens the setup of the local home and shows a pairing code. With
     `--link <address> <code>` it links this computer to a hosted home (`wizards-bot link`), so
     the hosted home uses this computer's models while it is on.
   - `wizards bot status`, `wizards bot update`, `wizards bot uninstall` (keeps
     `~/.engenty/wizards-bot`).
   - `~/.engenty/wizards/bot/bot.json` names the data folder (`"data"`):
     `~/.engenty/wizards-bot`, or what `WIZARDS_BOT_DATA` says.
   - When the Mac app runs the Bot Server (its LaunchAgent `bot.wizards.home`, docs/mac-app.md),
     `install` installs nothing and `update` says the app updates it.
10. **People.** `GET <MANAGE_URL>/v1/homes/people` with `Authorization: Bearer <gatewayKey>`
    answers `{ "group": { "name" } | null, "people": [{ "id", "name", "role" }], "studio" }`.
    `group` is the team's name when the team is not a personal one: the home is then a group home
    ([network.md](network.md) §5) and speaks for the team. `people` are the team's members, each
    with their role (`owner`, `admin`, `member`, `client`); `id` is the account's user id. The
    owners and admins run the home and are its admins; a role the home does not know counts as
    `client`. The home asks after its claim and every 60 seconds. The devices of someone no
    longer listed are removed, and so are those of someone who became an admin, a member or a
    client since: they pair again as who they are now. A group home takes no setup code (3):
    every device of it is someone's. `studio` (`{ "mcp" }` or null) is the MCP endpoint of the
    runtime the team works in. The studio at that origin shows the home's page inside its own
    (Work's chats): it is the one other site the page allows as `frame-ancestors`.
11. **The pass.** Someone's first device pairs with a pass. From its own pages the Manage-App
    sends an admin to `https://<address>.wizards.bot/#admin=<pass>`; a page of another site, the
    studio's, gets a pass for the person who uses it. Either page sends it to
    `POST /v1/pair/pass`. The pass is a JWT signed with the Manage-App's own key (EdDSA,
    Ed25519; keys at `<MANAGE_URL>/api/auth/jwks`), with `iss` the Manage-App's address, `aud`
    the home's origin, `sub` the person's user id, `name`, `exp` at most five minutes ahead and
    a `jti` the home takes once. A pass for a page of another site names it in `origin`, and is
    taken from that page only; one without it is taken from no other site's page. The home checks
    all of these and that `sub` is in the team when it asks (10) right then. Further devices pair
    with a code an admin asks their agent for; the code pairs the device as theirs.
