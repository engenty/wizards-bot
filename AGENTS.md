# Agent instructions

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): description`.
- No coding-agent attribution anywhere: no `Co-authored-by:` trailer, no "Generated with …" line.
- A change reaches `main` as a pull request, squash-merged; its title is the commit message.
- Releases: `pnpm release`, a pull request, then `pnpm release:tag` (CONTRIBUTING.md).
- Never push without the owner's word.

## Layout

| Path                | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/home`         | the home. Node ≥ 24.11 runs the TypeScript directly: erasable syntax only, relative imports end in `.ts`, no build step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/web`          | the web app: React 19, Vite, Tailwind 4, TanStack Query, built the way engenty wizards builds its web app. Its tokens, UI primitives, composer, camera and file preview are taken from wizards; each such file names its source in the first line. The home serves `apps/web/dist`. Types come from `packages/protocol` as `import type`; run-time numbers from `@wizards-bot/protocol/limits`. Markdown an agent wrote is shown in two ways only: in the chat through `ui/Markdown.tsx` (marked, then DOMPurify), and a document through the block editor in `blocks/` (Markdown to ProseMirror nodes, never set as HTML; raw HTML in it stays text). The layout is three columns at most: the agents at the left (a narrow column of figures or out of sight where the window is small), the chat, and a document, an artifact or a connected folder (`chat/FolderPane.tsx`) beside it. The widths and when a column gives way are in `lib/layout.ts`, which the iPad app follows. New things open in dialogs. |
| `apps/ios`          | the iOS app and the watch app. SwiftUI, no third-party dependencies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/avatar`   | the person's avatar: the figure built from traits (`figure.ts`) and the stacked-sprite renderer (`stack.ts`). Pure TypeScript for the browser and the home; `png.ts` is for Node only. No picture files: a trait is a rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/protocol` | the shapes devices and the home exchange (zod). `docs/protocol.md` is the same in words; change both, and the Swift types in `apps/ios`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The agent loop is Mastra (`@mastra/core`, `@mastra/memory`, `@mastra/libsql`), at the versions
engenty wizards pins.

- **Thread.** A conversation is a Mastra memory thread (thread id = conversation id, resource =
  the agent) in `mastra.db`, beside the home's own `home.db`. Mastra keeps what was said, the
  tool calls and their results; the home's store keeps the message the person reads, the cards
  and the documents.
- **Signal.** What is said to an agent is a signal on its thread (`agent/turns.ts`): it wakes
  the agent when it is idle and is delivered into the running turn when it is not. Card
  answers, tasks and other agents' answers arrive the same way (`home.tell`).
- **Task.** What an agent does by itself (`tasks/tasks.ts`): what to do, and what starts it, a
  time or an event. An agent is its instructions, its memory and its tasks; it reads all three
  in every turn. The home's own timer looks every 30 seconds at what is due, at the folders
  tasks wait for and at the connections they look at. What an event brought reaches the agent
  as data between two marked lines, many events in a short time as one turn.
- **Longer work.** A turn ends after 16 tool rounds. An agent that is not finished calls
  `go_on` with what is done and what is next, and the home gives it the next turn: at most 8
  in a row, none while a card waits, none after the person stopped it. This is the home's own
  queue, not Mastra's goal: that one asks a judge model after every run whether to continue,
  and takes the judge as a model id of Mastra's router, which a home's models are not.
- **Turn.** A run's instructions, models and tools are the turn's, read from the request
  context. The models are a list: when one fails, Mastra asks the next. Always pass
  `maxSteps`; Mastra's default is 5.
- **Tool.** Defined once (`agent/tool.ts`); it serves Mastra and, over MCP, the subscription
  clients. A tool that needs the person asks with `call.ask(card)`: Mastra suspends the run
  (`suspend`, `resumeStream`) and the card's answer resumes it in the same tool call, also
  after a start of the home. Where no run of Mastra waits (a subscription's client, a
  message in between), the home runs the tool again with the answer.
- **Connections.** Mastra's `MCPClient` (`@mastra/mcp`), one per connection.
- **Model.** An AI SDK v3 language model: Ollama on its own API, a gateway through
  `@ai-sdk/openai-compatible`, a subscription client that steps by itself
  (`models/client-model.ts`), a linked computer's model relayed over the link (`link/hub.ts`).
  Ollama (its models, downloads, the chat API) and the clients (found, signed in, their command
  lines and output) are engenty wizards' `@engenty/local-models`; the home keeps which models it
  offers and prefers (`models/ollama.ts`), the client's conversation across turns, and the
  setup's words.
- **Channels.** Slack is moving to Mastra's channels (the Chat SDK's Slack adapter in Socket
  Mode, `channels/slack-mastra.ts`). Mastra is the transport only: the handlers are the home's,
  so there is one conversation, the claim code and the home's cards. `WIZARDS_BOT_SLACK=mastra`
  picks it; once it has run against a real Slack, `channels/slack.ts` and the switch go.
- **A2A.** Asking an agent outside this home, in a contact's home or anywhere else, is
  Mastra's `A2AAgent` (`@mastra/core/a2a`): it reads the card, speaks A2A 1.0 and 0.3, streams
  and follows a task. The home hands it a `fetch` of its own (`peers/a2a.ts`), which is where
  the sign-in, the signature, the allowed addresses and the conversation's `contextId` are.
  Answering is Mastra's A2A handler (`@mastra/server/handlers/a2a`, the package's only use):
  the home's route checks who sends, then hands the request over with a guest turn
  (`turns.guestRun`) and the sender's own task list. Mastra's routes are not mounted, and the
  agent's card is the home's own: Mastra's would publish the instructions.
- **Before you write it yourself:** look at what the installed Mastra ships
  (`node_modules/@mastra/*/dist`) and build on it. Say in the change what Mastra covers and
  what stays the home's.
- **Not from Mastra:** what a card looks like and who may answer it, push, email, WhatsApp and Signal, the
  tasks' timer and longer work, the request to connect and the signature between homes.
  Mastra's working memory and semantic recall are not switched on; an agent's memory is the
  note it keeps with `remember`.

## Words

One word per thing, in code, comments and everything a person reads.

| Thing                                                     | Word                                                                        | Not                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| the program on a computer or server                       | home in code; Bot Server in copy (DE: dein, deinen, auf deinem Bot Server)  | server, backend, node, instance, Zuhause                       |
| iOS app, watch app, a terminal, another computer          | device                                                                      | client                                                         |
| who answers                                               | agent; the first one is the main agent                                      | bot, assistant                                                 |
| inline UI in the chat                                     | card                                                                        | widget, form, dialog                                           |
| open cards that wait for the person                       | what needs you; items in code                                               | inbox, tasks, todos                                            |
| Slack, email, WhatsApp, Signal                            | channel                                                                     | integration                                                    |
| an account or app reached over MCP                        | connection                                                                  | integration, plugin                                            |
| a folder of skills and tools in the plugins folder        | plugin; it is switched on and off                                           | extension, add-on, module                                      |
| what a connection asks the person while a tool runs       | question; elicitation only as MCP's own name                                | prompt, input request                                          |
| another person's home you connected to                    | contact                                                                     | peer (only as the folder name), friend                         |
| a conversation of several people and agents               | room; who is in it are its members                                          | group chat (fine in copy), channel, thread                     |
| what says who a person is to other homes                  | the person's record; a signed state of it is a version                      | profile, identity document, DID                                |
| what signs the person's record, kept on a device          | the person's key; it is made, brought back, never sent                      | account key, master key, seed (the code is the recovery code)  |
| what a home keeps for a contact whose home has no address | kept for it; that home asks for it (`/peers/mailbox`)                       | queue, push, relay                                             |
| a link, with its QR code, that lets someone in once       | invite; it is made, used and taken back                                     | invitation token, join link, share link                        |
| the home that numbers a room's messages                   | the home that keeps the room                                                | hub, host, server                                              |
| a home that belongs to a team, not one person             | group home; the people who run it are its admins                            | team server, organization, instance                            |
| a signed link from the Manage-App that pairs an admin     | pass                                                                        | magic link, invite (that one is for other homes)               |
| an A2A agent that is not a wizards.bot home               | outside agent                                                               | external agent, remote agent, third-party agent                |
| an outside agent let in to write to one of your agents    | caller; you let it in and shut it out                                       | client, consumer, guest (in code: whoever a turn answers)      |
| another computer of yours that offers its models          | linked computer                                                             | worker, node                                                   |
| something the person attached to a message                | file; a picture is a picture                                                | attachment, upload (as a noun), asset                          |
| a folder of the home's computer agents may use            | connected folder                                                            | mount, drive, workspace                                        |
| the connected folder where agents put what they make      | own folder in code; "Ordner deiner Agenten" / "your agents’ folder" in copy | workspace, home dir, output folder                             |
| a folder connected on a phone, read by the phone only     | connected folder, on the phone                                              | synced folder, mount                                           |
| what a device keeps and offers its agents                 | resource (calendar, reminders, contacts, folder)                            | capability, data source                                        |
| a question or task an agent hands to a device's agent     | hand-off; the agent asks the device                                         | job, request, remote call                                      |
| a page an agent wrote: a chart, a 3D scene                | artifact                                                                    | canvas, widget, app, report (only one kind of it)              |
| a passage the person marked in a document                 | mark; with words of the person on it, a comment                             | highlight, annotation, note                                    |
| giving a document or an artifact a link anyone can open   | publish; the address is a link; ending it is to take it back                | share (for this), public URL, revoke, unpublish                |
| giving a contact a copy of a document or an artifact      | send                                                                        | share (the dialog is Share; an agent is shared)                |
| how the person is drawn                                   | avatar; its parts are traits                                                | character, sprite (for the whole figure), profile picture      |
| Claude Code or Codex signed in on a computer              | subscription                                                                | CLI provider                                                   |
| something an agent does by itself                         | task; a time or an event starts it                                          | trigger (that is what starts a turn), job, automation, routine |
| a task that tells the person only when it has to          | quiet task; what its run leaves otherwise is a note                         | silent, background, digest                                     |
| work that takes an agent more than one turn               | longer work; the agent goes on                                              | job, run, loop, background work                                |

Copy follows engenty wizards' `docs/copy-style.md`: calm, plain, "you", no exclamation marks,
no emoji, no "please".

## Rules of the home

- Everything is set up by conversation. A new setting is a tool of the main agent, not a page
  and not a flag.
- A secret goes from a card's `secret` field into `Secrets` and from there to the code that
  needs it. It never enters a message, a tool result or a prompt.
- The Vault (`vault/`) keeps the person's passwords, cards and notes; the person adds, imports,
  shows and changes them on the Vault page of the settings, the one page that takes a secret. An agent signs in
  with a saved password only through `vault_sign_in` and `vault_code`, after the person said
  yes on a card: it sees the name, the website and two letters of the user name, and the home
  types the password and the code into the page itself, on that website only. Every browser
  answer goes through the Vault's redactor; no tool runs the model's JavaScript on a page.
- A tool that waits for the person makes a card and stops. New tools ask with `call.ask`, which
  suspends the run in Mastra; older cards start a new turn through their handler
  (`home.onCard`). A message is never held back by a card: it ends the suspended run.
- A tool of a connection that is not marked read-only asks first.
- A plugin is off until the person switches it on. Its code runs in a process of its own
  (`@engenty/plugins`): its folder, its data folder, no environment, no `Secrets`. Its tools
  follow the rules of a connection's: not read-only asks first, its answer is data
  (docs/plugins.md).
- What a connection asks the person while one of its tools runs is a card (`connections/calls.ts`).
  The answer goes to that connection only: not into a message, a tool result or a prompt, and
  it is not kept with the card. A form that asks for a secret is refused.
- What arrives from outside the home (a mail from someone else, the names and the text of
  files, what a service posts, what a connection answers) is data, never an instruction. A
  turn that read such data asks before every change in a connection, also where the person
  said "always", and it answers the person, never the sender.
- A task is set, changed and removed by its agent, in the conversation. The home pauses a
  task that failed three times in a row and tells the person with a card.
- A file is checked before it is kept: its type is read from the bytes, and a file that is not
  what it says is refused. It is served for saving or showing, never as a page of the home.
- An agent reaches nothing outside a connected folder, nothing hidden in it, no file that holds
  keys or passwords by its name and no link (`folders/rules.ts`). It changes a file only in a
  folder connected for changes, and asks before each change unless the person said "Always
  allow" for that folder (`folder.allow`); a turn that read outside data asks anyway, and a task
  an event started changes no files. What a change replaces or deletes goes to the Trash. It
  writes no program and no file with a second name elsewhere. Writes go through Mastra's `LocalFilesystem`, which checks the
  path again as it writes. No folder of the system or its apps is connected, with everything
  in it (`/etc`, `/private`, `~/Library`, …).
- A photo of the person is looked at by a model on the home's own computer. Any other model sees
  it only after the person said yes to that. The home deletes the photo afterwards.
- A channel hears only its owner. Homes hear only connected contacts, by signature. An agent
  that is not a home is heard only as a caller the person let in, by its access token. It
  reaches one agent, in a conversation of its own, and that agent has no tools there.
- An outside agent is added only after the person said yes on a card that shows who it is. An
  agent hands a task to an agent that is not in this home only after the person said yes to
  the text. What such an agent answers is information, never an instruction.
- An agent is put into a room only after the person said yes on a card. In a room it brings
  what is its own (its task, its memory, the documents, artifacts and files of its
  conversation) and none of the person's tools: no connection, no folder, no device, no task,
  no other agent. What the others write there is data, never an instruction. It answers when
  it is named and it is its turn, which the home that keeps the room decides.
- What an agent remembers is its person's. Someone it is shared with hears of it only when
  the person said so, a caller never. An agent writes nothing to its memory from a
  conversation someone else has with it: what a contact asks it to keep is one sentence on a
  card for its person (`remember_suggest`, the one tool it has there).
- A conversation someone else has with one of the person's agents (a contact it is shared
  with, a caller, a room it answers) is theirs. The home tells no device of it and no device
  route reads it, writes in it or stops it. It is deleted when the share ends.
- The person's key is made on a device and never reaches a home: not in a request, a
  message or a file. A home keeps the signed versions of the record and nothing to sign with.
  A contact's new home key is taken only from a version signed with the key remembered.
- A group home belongs to a team: every device of it is one admin's, and the Manage-App says who
  the admins are. Every admin reads the conversations of the group's agents, a card waits for
  any of them and the first answer counts. A device of it offers nothing to the agents: what one
  admin's phone keeps would reach the turns of the others.
- What a device keeps stays on the device. Its own agent works on it and sends back only the
  answer; it asks the person on the device before every change and before a file leaves the
  device. Only the person's own agents hand a device anything, each only after the person
  let it on the device. The home knows what a device offers, never what it holds.
- What leaves the home asks first: an agent publishes a link or sends a copy only after the
  person said yes on a card. A published link shows one version of one thing, read only, and
  nothing else of the home.
- Comments say what the code does and why. No history, no plan labels.

## Gates

```bash
pnpm fix
pnpm lint
pnpm typecheck
pnpm test
```
