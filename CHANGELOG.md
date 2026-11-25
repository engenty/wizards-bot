# Changelog

All notable changes to wizards.bot. Generated from [Conventional Commits](https://www.conventionalcommits.org/)
by [git-cliff](https://git-cliff.org) via `pnpm release`. Pre-`1.0`: a **minor**
bump is a notable or breaking change, **patch** is fixes and small features.

## [0.1.8] - 2026-11-25

- ADDED **[home]** Members of a team chat with its agents, each in a conversation of their own (#84)
- ADDED **[chat]** An agent shows a view in a card (#83)
- ADDED **[home]** The studio the team works in is a connection, used as the person who writes (#82)

## [0.1.7] - 2026-11-25

- ADDED **[home]** The studio the team works in shows the home's page inside its own (#80)

## [0.1.6] - 2026-11-25

- ADDED **[home]** Every person of the team on its home (#78)

## [0.1.5] - 2026-11-25

- ADDED **[web]** Base color in every theme, agents in bubbles, and how much of their tools is shown (#75)
- ADDED **[chat]** The steps of an answer are one line in the person's words (#74)
- ADDED A question of an agent is answered in the chat, several things at once on a form (#73)
- ADDED **[agent]** One harness around the tools, levels of models and what a small model may do (#72)
- ADDED **[settings]** Each model source opens its details, with the setup's own parts (#71)
- ADDED An agent waits for the agent it handed a task to, and what needs you leads to its chat (#70)
- ADDED **[setup]** One wide frame on every step, clearer folders, and how to reach the Bot Server (#69)
- ADDED The setup of what the wizards think with, shared with engenty wizards, and models on this computer (#66)
- ADDED Ollama is found, and loads a model only once the person picks it (#64)
- ADDED **[web]** One button each for the theme and the language in the setup's header, the version in its footer (#63)
- ADDED **[ios]** Show what the model thinks and the pages it draws on (#60)
- ADDED **[home]** Show what the model thinks and the pages it draws on while it answers (#59)
- ADDED **[ios]** A message for after the answer (#58)
- ADDED **[home]** A message for after the answer (#57)
- ADDED **[ios]** Show a connection's view beside the chat (#62)
- ADDED **[web]** Show a connection's view in the chat and beside it (#61)
- ADDED **[home]** MCP Apps views as artifacts (#52)
- ADDED **[home]** A connection's call that becomes a task runs on in the background (#51)
- ADDED **[home]** A tool's result keeps what it carries (#50)
- ADDED **[protocol]** Cards that carry a view (#53)
- ADDED **[ios]** Group homes: another admin's messages and answers carry their name (#48)
- ADDED **[web]** Group homes: admins open them with a pass, and see who wrote and who answered (#47)
- ADDED **[home]** In a group home each admin reads for themselves (#45)
- ADDED **[home]** Group homes: several admins, their devices, and cards any of them answers (#44)
- ADDED **[home]** A sandboxed shell for the agents, agentOS by default and a full Linux on a Mac (#43)
- ADDED **[ios]** The file browser on the iPhone and the iPad (#42)
- ADDED **[web]** The file browser beside the chat (#41)
- ADDED **[home]** What agents did in a folder, and the file browser's routes (#40)
- ADDED **[home]** Move and delete files in connected folders, with one card (#39)
- ADDED **[home]** Make, copy, write and edit files in connected folders (#38)
- ADDED **[home]** Every agent can create a folder and connect it in one card (#37)
- ADDED **[setup]** A folders step: the agents' own folder and folders to connect (#35)
- ADDED Agents ask for a folder with a picker, never a typed path (#34)
- ADDED **[mac]** A dev app beside the installed one, pnpm dev:mac (#32)
- ADDED **[mac]** The first screen shows the engenty figure (#31)
- ADDED **[web]** The setup asks for the AI on a plain screen (#29)
- ADDED **[home]** An address at wizards.host, switched on in the setup (#28)
- ADDED A simpler first start on Petrol, in the Mac app, the setup and the iPhone app (#27)
- ADDED **[web]** Petrol is the default colour of the branded theme (#25)
- CHANGED **[home]** Read every run from the conversation's thread and stop it through Mastra (#56)
- CHANGED **[home]** Ollama, Claude Code and Codex through @engenty/local-models (#30)
- FIXED **[web]** An agent's question is in its bubble too, where agents speak in bubbles (#76)
- FIXED **[home]** A claim at another relay signs that relay's domain (#65)
- FIXED **[home]** A connection's tools in short, one tool in full (#49)
- FIXED **[home]** Folder paths stay in their folder (#36)
- FIXED **[mac]** The title bar takes the web app's colour (#33)
- FIXED **[web]** A Bot Server on your own computer shows no imprint or terms, only a line with wizards.bot (#26)
- PERFORMANCE **[home]** Keep the start of every request stable and mark it for the prompt cache (#54)

## [0.1.4] - 2026-11-23

- ADDED A password Vault with a browser for the agents and private sign-in (#21)
- ADDED **[home]** Plugins from the data folder with their skills and tools, through @engenty/plugins (#19)
- ADDED **[mac]** Offer to update an older Bot Server the app finds on this Mac (#22)
- ADDED **[mac]** The wizards.bot Mac app (#13)
- ADDED A new bot with its look, and smoother resizing (#20)
- ADDED **[web]** A resizable list of Wizards, relative times and a tighter card (#18)
- ADDED Search with ⌘K over Wizards, messages, documents and artifacts (#17)
- ADDED **[web]** A Keys page in the settings lists what uses each secret, never a value (#16)
- ADDED **[home]** Seal secrets with @engenty/vault, bound to their name, with a key check (#10)

## [0.1.3] - 2026-11-22

- ADDED **[web]** The settings in two columns (#14)
- ADDED **[web]** Seven colours for the branded theme, citron by default (#7)
- ADDED **[web]** Theme and language in the user menu; the Wizard centred in the chat's header (#12)

## [0.1.2] - 2026-11-22

- ADDED Bot Server in copy, a calmer setup in the person's language, and the sidebar (#6)
- FIXED **[web]** The user menu opens below the person's card at the top (#8)
- FIXED **[ios]** Talking no longer hears its own voice, and the chat keeps its place (#5)

## [0.1.1] - 2026-11-22

- ADDED Hosted homes at <name>.wizards.bot (#3)
- DOCS Plan for hosted homes at <name>.wizards.bot (#2)

## [0.1.0] - 2026-11-22

- ADDED Person key, handles, invites, homes without an address, guest memory rules
- ADDED Setup with live checks, consent before AI services, rooms across homes
- ADDED Phone agent, phone folders and connections, Wizards drawer
- ADDED iPhone files, camera, iCloud folders, artifacts; busy counter
- ADDED Daten and user menu, model choice, iOS agent detail, Mastra asking
- ADDED Pictures in folders, document marks, downloads, A2A on Mastra
- ADDED Agents list, panes, tasks, sharing, outside agents, MCP questions
- ADDED First version
