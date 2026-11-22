# Plugins

A plugin is a folder that brings skills and tools to the person's own agents. wizards.bot and
engenty wizards load the same plugins: one contract, `@engenty/plugins`, lives in engenty wizards'
`packages/plugins` (MIT) and goes to npm with each engenty wizards release, like `@engenty/vault`.

## In the home

|               |                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where         | `<data folder>/plugins` (`~/.wizards-bot/plugins`, `WIZARDS_BOT_DATA`). The home looks into it on start, on `GET /v1/plugins` and before a switch                                                                                 |
| What counts   | What `discoverPlugins` finds: a folder with `engenty.plugin.json`, a folder with `index.ts`, one `.ts` file, a package below `node_modules` with a manifest                                                                       |
| Skills        | `skills/<name>/SKILL.md` of the plugin (or the folder `skills` names), read like the home's own (`skills/skills.ts`): loaded by `skill_load` or by the words of a message. A name the home already has is refused                 |
| Tools         | The server half's `registerTool`. A model reads them as `<plugin>_<tool>` (`weather_forecast`). A plugin with skills brings its tools with its skills, shown while one of them is loaded; a plugin without skills has them always |
| On and off    | Off when found. The person switches it on in Settings › Plugins or by asking the main agent (`plugin_switch`, which asks with a card). Kept in `meta` `plugins`                                                                   |
| Who gets them | The person's own agents. A room, a contact's conversation and a caller get none of it (`turns.ts` picks their tools)                                                                                                              |
| Data          | `<data folder>/plugin-data/<id>`: the one folder the plugin writes in                                                                                                                                                             |

Code: `apps/home/src/plugins/plugins.ts`. Shapes: `Plugin`, `PluginsView` in `packages/protocol`,
words in `docs/protocol.md`. The page: `apps/web/src/chat/SettingsDialog.tsx`.

## The rules of the home, for a plugin

- **Fewer rights than the Bot Server.** A plugin's server half never runs in the home's process.
  `startPluginProcess` starts it in a Node process of its own under Node's permission model
  (`--permission`): it reads its own folder, `@engenty/plugins` and zod, writes only its data
  folder, and may not start a process, a worker thread or a native addon. It gets an empty
  environment, so none of the home's settings, and it never sees `Secrets`, `home.db`,
  `mastra.db`, the person's files or a connected folder. Its heap is 256 MB, each call has two
  minutes. It reaches the home only through the messages of `child.ts`: its tools, and a call
  with an input and an answer.
- **Network.** Node 24's permission model has no network permission: the process can reach the
  network. What it could send is what a tool was given, the same as a connection. That is why it
  gets no keys of the home.
- **Write asks first.** A tool declares `readOnly: true` when it changes nothing. Every other
  tool asks with `call.ask` (Allow once, Always allow, Don't), like a connection's tool. In a turn
  that read data from outside the home, "always" does not count. Switching a plugin off forgets
  what was allowed always.
- **Secrets.** A plugin gets none: no environment, no `Secrets`. A plugin that needs a key of its
  own (an API key of a weather service) gets it the way everything is set up: the person gives it
  on a card's `secret` field, it is sealed with `@engenty/vault` bound to `[plugin, <id>, <name>]`,
  and handed only to that plugin's process as its `config` (not built yet: below).
- **What a plugin answers is data.** Like a connection's answer: never an instruction, and the
  turn answers the person.
- **Switched on by the person.** Code in the folder does nothing until the person switched it on;
  the main agent switches on only after the person said yes on a card that says the code runs on
  the Bot Server.

## One contract, two products

|             | Shared: `@engenty/plugins`                                                                                      | wizards.bot                                                                                                               | engenty wizards                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Manifest    | `engenty.plugin.json`: `id`, `name`, `version`, `description`, `server`, `skills`; other fields kept            | reads the shared fields                                                                                                   | adds `studio`, `styles`, `features`                                                                  |
| Finding     | `discoverPlugins`, `insidePlugin`, `skillsDir`                                                                  | `<data folder>/plugins`                                                                                                   | `modules/`, `PLUGINS_DIR`, `DATA_DIR/plugins`, Pro modules (own copy today)                          |
| Server half | `definePlugin`, `PluginApi`: `plugin`, `config`, `log`, `resolvePath`, `server.registerTool`, `server.onUnload` | this subset                                                                                                               | `WizardsPluginApi`, a superset: runners, routes, tables, events, jobs, the space, accounts, starters |
| Tools       | `PluginTool` with `readOnly`; context `{ signal, emit }`                                                        | asks before a tool that is not read-only                                                                                  | a wizard step (the person is in front of it); the space assistant's `risk`                           |
| Skills      | `skills/<name>/SKILL.md` (Agent Skills, as Mastra reads them)                                                   | loaded like the home's                                                                                                    | not yet: plan step 3                                                                                 |
| Rights      | `startPluginProcess`                                                                                            | every plugin                                                                                                              | in the runtime's process; installed ones in a process: plan step 4                                   |
| UI          | the manifest's `app` (an entry: label, icon)                                                                    | Settings › Plugins: a list with on/off; an app's entry at the foot of the sidebar and its page in the main column (below) | the studio half (`registerNav`, `registerPage`, sections, cards)                                     |
| Install     | none yet                                                                                                        | put the folder there                                                                                                      | Settings › Plugins: a zip or a folder (`plugins/install.ts`), Pro modules from the Manage-App        |

A plugin that uses only `PluginApi` loads in both. It may keep `@engenty/wizards/plugin` as its
import: the process maps that name to `@engenty/plugins`. engenty wizards' plan for its own
loader: engenty wizards `docs/plans/plugins-shared-contract.md`.

## What can be unified, ranked

By what it gives for what it costs.

| #   | What                                                                                                                                              | Gives                                                                                              | Costs                                                                                                                                                                                              | State                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Manifest, ids and finding plugins                                                                                                                 | One plugin folder for both; one place for the rules of ids and paths                               | Small: the runtime's `discovery.ts` calls the package (plan step 1), no change a plugin sees                                                                                                       | Package done; wizards.bot uses it                 |
| 2   | The tool contract (`PluginTool`, `readOnly`, `definePlugin`, `PluginApi`)                                                                         | A tool written once runs in a wizard step and in a home's turn                                     | Small: types only in engenty wizards (plan step 2)                                                                                                                                                 | Package done; wizards.bot uses it                 |
| 3   | The process with fewer rights                                                                                                                     | Plugins from outside run without the host's keys and files, in both                                | Medium in engenty wizards: plugins that need more than tools get marked trusted (plan step 4); a plugin installed from a zip may stop loading until then                                           | Package done; every wizards.bot plugin runs in it |
| 4   | Skills in a plugin (`SKILL.md`)                                                                                                                   | Instructions travel with the tools; the same skills the agent-store plugin (`plugin/skills`) ships | Small in wizards.bot (done); medium in engenty wizards (space skills, plan step 3)                                                                                                                 | wizards.bot done                                  |
| 5   | A plugin's own keys through `@engenty/vault`                                                                                                      | A plugin that needs an API key gets it without seeing the host's                                   | Medium: a `secrets` list in the manifest, a card per key in wizards.bot, the settings section in engenty wizards; replaces `secrets.seal`/`unseal` of `WizardsPluginApi` (the vault note's step 3) | Not built                                         |
| 6   | Install, update, remove (zip or folder, swapped in whole)                                                                                         | One installer; wizards.bot gets install by card                                                    | Medium: `plugins/install.ts` moves into the package (`installPlugin(files, dir)`), the Pro module checks stay engenty wizards'                                                                     | Not built                                         |
| 7   | A plugin that brings an MCP server (`mcpServers`, as agent-plugins.org's `plugin.json` has)                                                       | The agent-store plugin's form loads in a home: its skills become skills, its server a connection   | Medium: wizards.bot runs a local server under the same process limits and adds it as a connection                                                                                                  | Not built                                         |
| 8   | A catalog both products install from                                                                                                              | One list of plugins on wizards.bot and engenty.ai; plans of the Manage-App name bot plugins too    | Large: the Manage-App's Pro modules (`modules.ts`, `runtime-plugins.ts`) are per runtime and per plan; signing and review of plugins first                                                         | Not planned                                       |
| —   | Routes, runners, tables, events, jobs, the studio half                                                                                            | —                                                                                                  | They need engenty wizards' tenants, runs and studio; a home has none of them                                                                                                                       | Stay engenty wizards'                             |
| 9   | An app: an entry, a page, words (like `registerNav`/`registerPage` in engenty wizards and `registerAdminMenuItem`/`registerRoute` in engenty-pro) | Apps beside the chat in wizards.bot, Vault first                                                   | Small for apps that ship with the home; medium for a plugin's own page, which runs in a closed-off frame                                                                                           | Planned (below)                                   |

## Apps

The person reaches the main things by conversation. An app adds a place to look at them: an
entry at the foot of the sidebar beside the settings (a row with icon and label in the wide list,
the icon alone on the rail) and a page that opens in the main column, beside the chat, not in a
dialog. It is the same three parts engenty wizards (`registerNav`, `registerPage`) and engenty-pro
(`registerAdminMenuItem`, `registerRoute`) have: an entry, a page, its words in German and
English.

- **Apps that ship with the home** are first-party plugins whose page is part of `apps/web`: the
  web app registers them (`registerApp({ id, label, icon, page })`), and the home lists them in
  `GET /v1/plugins` with their switch. Their code is the web app's, reviewed like it.
- **A plugin from the data folder** declares its entry in the manifest (`app: { label: { de, en },
  icon }`) and brings its page as files. The page never runs in the web app's origin: it is served
  like an artifact, in a frame without the app's origin, its storage or the device's token, and it
  reaches only its own plugin's tools through messages the web app checks. A tool that is not
  read-only asks first there too.
- **An app shows and asks; it does not set up.** What changes a setting or a secret opens the main
  agent's chat with the request (Rules of the home: everything is set up by conversation, a secret
  goes from a card's `secret` field). An app has no field for a value.
- **Vault** is the first app: the Keys list (`GET /v1/secrets`) and what to add, each opening the
  main agent's chat. `Secrets` and `/v1/secrets` stay in the home's core: connections and
  channels need them before any plugin loads.

Open: whether the Keys page moves out of the settings into the Vault app, and whether the wide
sidebar shows apps as rows or as icons beside the gear.

## What is left

- `@engenty/plugins` reaches npm with the next engenty wizards release; wizards.bot then pins its
  version instead of the local link.
- A plugin's own keys (5), install by card (6), MCP servers in a plugin (7), apps (9).
- `PLUGINS_WATCH`-like reloading: a plugin's changed files take effect after off and on.
- When the home's Node has a network permission, the process gets it for the hosts the manifest
  names.
