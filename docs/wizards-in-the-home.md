# Wizards in the home: requirements for wizards 0.3.0

Status: draft, 2026-11-22. Nothing here is built.

Readers: whoever works on the kernel in `engenty-wizards` (pull request #697, branch
`feat/kernel`), and whoever builds the host in this repository.

This document says what version 0.3.0 of a wizard has to offer so that a home can run one. It
covers two cases:

- **(a) Defined in the studio.** A company makes an agent's workflow in the studio. A person
  installs it in their home, and it runs there.
- **(b) Defined in the home.** The main agent writes a workflow in the conversation. It never
  leaves the home unless the person sends it somewhere.

The plan for what an agent of the home becomes is [intelligent-agents.md](intelligent-agents.md).
Its decisions 1 and 2 name the kernel as the engine and version 0.3.0 as the format, and its
stages say which of the requirements below each one waits for.

## In short

The kernel is close to what a home needs. It is a package with no imports from the wizards app.
The file says what a run may reach. A step does everything through one `ask`. The host supplies
the store, the answers and the way code runs.

Five things stand between it and a second host:

| #   | Gap                                                                                          | Requirement |
| --- | -------------------------------------------------------------------------------------------- | ----------- |
| 1   | The kernel is on a draft branch, private, without a licence                                  | K1          |
| 2   | The file's schema and the field checks live in `packages/shared`, which a home cannot import | K2, K3      |
| 3   | What each kind of ask means is written only in the runtime's batteries and page              | A1 to A4    |
| 4   | A connection is named for the studio's connectors, not for an MCP connection                 | C1, C2      |
| 5   | A `.wizard` package of 0.3.0 can only be read with `packages/shared`                         | P1 to P4    |

## Where things stand

Checked on `origin/feat/kernel` at `81160871` (2026-11-16) and on this repository at `a3e6450`.

| Fact                                                                                      | Source                                                                 |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The kernel is not on main. #697 is an open draft, 64 commits, 2 behind main.              | `gh pr view 697`                                                       |
| The package is private and names no licence.                                              | `packages/kernel/package.json:5`                                       |
| It depends on `esbuild` and QuickJS only. No code names a tenant, a credit or a space.    | `packages/kernel/package.json`, `src/compile.ts:3`, `src/quickjs.ts:1` |
| It is 1,694 lines without tests.                                                          | `packages/kernel/src`                                                  |
| The file holds `requires`, `connections`, `input`, `output`, `start`, `edges`, `limits`.  | `packages/kernel/src/types.ts:5`                                       |
| The grant is made from the file, and an ask outside it fails.                             | `src/grant.ts:22`, `src/grant.ts:42`                                   |
| A host passes `store`, `wizards`, `batteries`, `now`, `has`, `turn`, `check`.             | `src/kernel.ts:101`                                                    |
| A host can say what it has, and a wizard that needs more is refused.                      | `src/grant.ts:13`, `src/grant.ts:60`                                   |
| QuickJS gives a step no files, network, timers or modules.                                | `src/quickjs.ts:5`                                                     |
| Tests with given answers, evals, and asking a past run again are in the package.          | `src/check.ts`, `src/evals.ts`                                         |
| The only host is the wizards runtime. Its batteries call the step executors of version 1. | `apps/runtime/src/kernel/batteries.ts:5`                               |
| A person's ask is shown by turning the run into a small wizard of version 1.              | `apps/runtime/src/kernel/page.ts`                                      |
| The file's schema is in `packages/shared` (FSL).                                          | `packages/shared/src/definition.ts:1613`                               |
| A stored wizard of 0.3.0 is a definition of version 1 with the file in `kernel`.          | `docs/plans/kernel.md`, "Where it differs"                             |
| The package export carries that definition, the connectors' names, themes and all files.  | `apps/runtime/src/services/package.ts:50`                              |
| The only built-in connection kind is `mail`. Others are connectors a space imported.      | `packages/shared/src/store.ts:52`                                      |
| Starts are kept per install. The definition does not know them.                           | `packages/shared/src/starts.ts:5`                                      |
| Not tested: a real model, a restart during each kind of wait, the cloud.                  | `docs/plans/kernel.md`, "How it was tested"                            |
| The home runs Mastra 1.82.0 and uses no workflow code.                                    | `apps/home/package.json:21`                                            |
| The home asks a person with a card, and the run waits in Mastra.                          | `apps/home/src/agent/tool.ts`, `apps/home/src/agent/turns.ts:424`      |
| The home reaches accounts and apps over MCP.                                              | `apps/home/src/connections/connections.ts:316`                         |
| A card has four field types: text, secret, choice, multi.                                 | `packages/protocol/src/index.ts:108`                                   |
| The home has neither QuickJS nor esbuild installed.                                       | `apps/home/package.json`                                               |

## Words

| In wizards          | In the home                 | Note                                                                 |
| ------------------- | --------------------------- | -------------------------------------------------------------------- |
| wizard              | workflow                    | An agent of the home owns one or more.                               |
| step, ask, row, way | the same                    | Kernel words are used as they are.                                   |
| host                | the home                    | The home is the second host.                                         |
| battery             | what answers an ask at once | A model, a connection's tool, the clock.                             |
| grant               | what a run may reach        | Made from the file. The home may only narrow it.                     |
| leave for an action | a card that asks first      |                                                                      |
| start               | task                        | A time or an event starts a run.                                     |
| role `user`         | the person                  | Other roles are open, see decision 5.                                |
| space               | none                        | A home has no spaces. The studio's space is reached as a connection. |

## What an agent is, in both cases

An agent of the home stays what it is: a name, instructions, a memory note, tasks and its
conversation. A workflow is something the agent runs: when a task starts it, or when the person
asks for it in the conversation.

So the file does not have to become an agent. It needs no memory and no instructions for a
conversation. What the home needs from a wizard is a run it can start, show, answer and stop.

## Case (a): defined in the studio

What the person sees:

1. In the conversation: "add the bookkeeping agent of my company". The main agent lists what the
   studio offers this person.
2. A card shows the agent: who published it, what it may reach, what it asks before, which of the
   home's connections would stand behind each of its connections.
3. The person says yes. The home keeps the package and the version, and makes the agent.
4. The first runs are supervised: every change asks first.
5. When the company publishes a new version, a card shows what changed in what it may reach.
   The old version runs until the person says yes.

What happens underneath:

| Step                                         | Who                                             | With              |
| -------------------------------------------- | ----------------------------------------------- | ----------------- |
| List what can be installed                   | the home asks the studio                        | P4                |
| Fetch the published package                  | the home                                        | P1, P3, P4        |
| Check it and compile its steps               | the kernel, in the home                         | K3, K4, L2        |
| Compare what it needs with what the home has | the kernel                                      | `lacking`, A1, G3 |
| Bind connections                             | the person, on a card                           | C1, C2            |
| Run                                          | the kernel, with the home's store and batteries | K5                |
| Read company knowledge during a run          | a connection to the studio                      | P5                |
| Learn of a new version                       | the home asks, or the studio tells              | P4                |

## Case (b): defined in the home

What the person sees is in [intelligent-agents.md](intelligent-agents.md), section 6: the main
agent writes a draft, shows it in words, runs it on the person's own examples, and the person
says yes on a card.

What changes is what the main agent writes: a file and one function per step, in place of a
Mastra definition.

| Step                                              | Who                            | With   |
| ------------------------------------------------- | ------------------------------ | ------ |
| Learn the format                                  | the main agent reads the guide | L1     |
| Write `wizard.json` and `steps/*.ts`              | the main agent                 | K3, L3 |
| Check and compile, with issues it can read        | the kernel                     | L2     |
| Show the workflow in words and as a map           | the home, from an outline      | L4     |
| Test run with stand-ins and the person's examples | the kernel                     | L2     |
| Judge what a step wrote                           | the kernel                     | L5     |
| Run                                               | the same host as in case (a)   | K5     |

A workflow written in the home always runs in QuickJS. An agent wrote its code, so it is never
the host's own code.

## Requirements

Each requirement names its case, how much it matters, what is there today, and when it is done.
Must: the home cannot host a wizard without it. Should: the home can work around it, at a cost.
Later: not needed for the first agent.

### K. The kernel as a package

| #   | Requirement                                                                                                                                                                             | Case | Weight | Today                                                                                                                                      | Done when                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| K1  | The kernel is on main, has a licence a home can use, and can be installed outside the wizards workspace.                                                                                | both | Must   | Draft #697, `private: true`, no licence. The plan proposes MIT.                                                                            | `pnpm add @engenty/wizards-kernel` works in this repository, from a registry or a git tag. |
| K2  | The package checks an answer against its fields by itself.                                                                                                                              | both | Must   | The host passes `check`. The runtime's check comes from `packages/shared`. Without it the kernel checks `required` only (`kernel.ts:331`). | A host that passes no `check` gets the same refusals as the runtime for every field kind.  |
| K3  | The file's schema ships with the kernel, as code and as JSON Schema.                                                                                                                    | both | Must   | A TypeScript type in the kernel, the zod schema in `packages/shared/src/definition.ts:1613`.                                               | The kernel exports a function that takes unknown JSON and returns a file or its issues.    |
| K4  | QuickJS is a complete way to run a step, with limits a host can set.                                                                                                                    | both | Must   | Built: 32 MB, 20,000 interrupts, a clock that stands still, seeded random (`quickjs.ts:26`).                                               | The package's whole test suite passes with `quickjsTurn` as the only way.                  |
| K5  | The host interface is written down and versioned: `KernelOptions`, `Store`, `Battery`, `NeedsLeave`, `Host`, and the entry points `start`, `answer`, `wake`, `rewind`, `stop`, `judge`. | both | Must   | Types and comments only. One host uses them.                                                                                               | A page "Writing a host" in the package, and a rule for what a minor version may change.    |
| K6  | A set of tests a host runs against its own store and batteries.                                                                                                                         | both | Should | `memoryStore` and the package's tests exist, but they are tied to the package's own store.                                                 | The home runs the set against its store on `home.db` and passes.                           |
| K7  | A run survives a restart of its host at every kind of wait: a person, a time, leave for an action, an agent's turn.                                                                     | both | Must   | Not tested (kernel plan).                                                                                                                  | A test per kind of wait that drops the kernel and builds it again from the store.          |
| K8  | One run with a real model, from start to end.                                                                                                                                           | both | Must   | Not done: the branch was built without a model key.                                                                                        | The mail example runs with a real model in the runtime.                                    |
| K9  | The kernel stays free of tenants, credits, spaces, pages and themes.                                                                                                                    | both | Must   | True.                                                                                                                                      | A test that fails when `packages/kernel/src` imports from another workspace package.       |

### A. Asks

| #   | Requirement                                                                                                                | Case | Weight | Today                                                                                                                                                                         | Done when                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | The kinds of ask are a written list in the package: for each its `type`, what its spec holds, and the shape of its answer. | both | Must   | `type` is a string (`types.ts`). The runtime knows `agent`, `decision`, `tool`, `form`, `review`, `approval`, `motion-graphics` and more (`batteries.ts:109`, `page.ts:139`). | Typed specs for the core kinds: `agent`, `decision`, `tool`, `form`, `review`, leave for an action, a wait. Any other kind is named in `requires.tools`, so a host without it refuses the wizard before it starts. |
| A2  | A person's ask can be shown without the wizards run page.                                                                  | both | Must   | The runtime turns the run into a wizard of version 1 for its page (`page.ts`).                                                                                                | For `form`, `review` and leave, the row alone holds what a host needs to show it: a title, text, fields, and the actions the person may take.                                                                      |
| A3  | Every field kind has a plain form a host with few field types can fall back to.                                            | both | Should | Many field kinds in `FIELD_KINDS` (`definition.ts:278`). A card has four.                                                                                                     | The list of field kinds says for each: text, one of several, several of several, or a file. A host that knows only those can show every form.                                                                      |
| A4  | The row that asks leave says what is about to happen, in words a person can read.                                          | both | Must   | The runtime builds a review of the action's input (`page.ts:177`).                                                                                                            | The row names the connection, the action and its input. The home writes the card from that alone.                                                                                                                  |
| A5  | A review's answer has one fixed shape.                                                                                     | both | Must   | The examples read `approved` and `note` (`examples/mail/steps/look.ts`). Not typed.                                                                                           | Typed in A1.                                                                                                                                                                                                       |
| A6  | An agent's turn can ask leave for one of its tool calls and go on where it was.                                            | both | Should | An agent is not handed an action set to `ask`: "its own turn cannot ask yet" (`batteries.ts:39`).                                                                             | A battery can leave an agent ask waiting on a row under it, and is called again with that row's answer.                                                                                                            |
| A7  | A wait ends at a time the host keeps.                                                                                      | both | Must   | Built: `run.wakeAt`, `wake` (`kernel.ts:416`).                                                                                                                                | Covered by K7.                                                                                                                                                                                                     |

### G. What a run may reach

| #   | Requirement                                                                                    | Case | Weight | Today                                                                                                                                               | Done when                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------- | ---- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| G1  | A host may ask where the file allows, never the other way round.                               | both | Must   | Built: a battery throws `NeedsLeave`, and the kernel asks (`kernel.ts:249`).                                                                        | Written in K5 as a rule, with a test.                                                                                 |
| G2  | A host can keep its own facts on a run, saved with it.                                         | both | Should | `Run` has no place for it. The runtime keeps its own in `run.state.kernel`.                                                                         | `Run` has one field the kernel never reads. The home keeps there whether the run has read data from outside the home. |
| G3  | The names in `requires.tools` are a written list, and each says what a host must offer for it. | both | Must   | Named in comments: the sandbox, the browser, a plugin's tools, the wizard's own (`types.ts:15`).                                                    | A list in the package. The home offers none of them at first, and `lacking` refuses a wizard that needs one.          |
| G4  | The model classes are written down as what they promise, not as models.                        | both | Must   | `classifier`, `low`, `standard`, `high`, `image`, `video`, `audio`, `speech` (`definition.ts:423`), bound by the gateway or the runtime's settings. | A sentence per class in the package. The home binds each class to its own models.                                     |
| G5  | An ask can say that what it sends must stay on the host's own computer.                        | both | Later  | Nothing.                                                                                                                                            | An ask names it, and a host without a local model refuses the ask. The home needs this for a photo of the person.     |
| G6  | The kernel sends nothing anywhere by itself.                                                   | both | Must   | True.                                                                                                                                               | Stays true. A run's report to the studio is an ask like any other, and the home asks the person first.                |

### C. Connections

| #   | Requirement                                                                               | Case | Weight | Today                                                                                                                                                                                                       | Done when                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------- | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | A connection and its actions are named so that a host with MCP connections can bind them. | both | Must   | The key is the kind `mail` or a connector of the space. The mail example uses `gmail` with the operations of Google's API (`examples/mail/wizard.json`). The home's connections are MCP servers with tools. | The format says how a name maps to an MCP tool. The mail example runs in a host that has an MCP mail connection and no executor.                                                     |
| C2  | The package says enough about each connection to offer the person the right one.          | (a)  | Must   | The manifest lists `id`, `name`, `domain`, `sourceKind` for imported connectors, and no address (`wizard-package.ts`).                                                                                      | For an MCP connector the manifest names the server as the MCP registry does. The home shows a card: "this agent needs your mail, use this connection?"                               |
| C3  | Which account stands behind a connection is bound where the wizard is installed.          | both | Must   | Decided (`types.ts:23`). The plan is `docs/plans/run-connections.md`.                                                                                                                                       | The kernel hands a battery the connection's name only. The home keeps the binding per installed workflow.                                                                            |
| C4  | Each action says whether it only reads.                                                   | both | Should | The file says `allow` or `ask`.                                                                                                                                                                             | The home asks before every action that is not read-only, whatever the file says. It reads that from the MCP tool today. A mark in the file would let the card say so before install. |

### P. From the studio to the home

| #   | Requirement                                                                                       | Case | Weight | Today                                                                                                                                                                                                                              | Done when                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------- | ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | A package of 0.3.0 can be read with the kernel alone.                                             | (a)  | Must   | The manifest holds a definition of version 1 with the file in `kernel`, and all files under `files/`. Reading it needs `packages/shared`.                                                                                          | The kernel exports a reader: bytes in, a file, step sources, eval sources and the connectors out.                                                                                  |
| P2  | A package can carry its steps compiled for QuickJS.                                               | (a)  | Should | Compiled when a run is driven, kept in memory (`apps/runtime/src/kernel/wizard.ts`).                                                                                                                                               | With compiled steps in the package, a home needs no esbuild for case (a). The reader checks them against a hash of the sources.                                                    |
| P3  | A package names the wizard, its published version and a hash of its content.                      | (a)  | Must   | The manifest has `exportedAt` and the definition.                                                                                                                                                                                  | The home pins a version and can tell whether a new package is a new version.                                                                                                       |
| P4  | A home can list what a person may install, fetch a published package, and learn of a new version. | (a)  | Must   | `GET /wizards` and `GET /wizards/:id/package` with the scope `wizards:read` (`routes/api.ts:268`, `:279`). MCP has `list_wizards`, `get_wizard`, `list_files`, `read_file`. Whether these serve a wizard of 0.3.0 was not checked. | One way that works with the sign-in a home already has, which is an MCP connection. Either an MCP tool that returns the published package, or the API route behind the same token. |
| P5  | A step can read the company's knowledge.                                                          | (a)  | Should | In the studio a step reads its space. Over MCP there are `space_search`, `space_document`, `table_read`.                                                                                                                           | The space is a connection with read-only actions in the file's `connections`. In a home the battery calls the studio over MCP.                                                     |
| P6  | A card can show what changed between two versions in what a run may reach.                        | (a)  | Should | `grantOf` gives a grant per file.                                                                                                                                                                                                  | The kernel exports a comparison of two files: what was added and removed in models, tools, hosts, roles and connections.                                                           |
| P7  | A package says who published it in a way the home can show.                                       | (a)  | Later  | The home knows only which account it fetched from.                                                                                                                                                                                 | The organisation's name comes with the package, from the studio, and cannot be set by the wizard's author.                                                                         |

### L. Writing one in the home

| #   | Requirement                                                                                                | Case | Weight | Today                                                                                                                      | Done when                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------- | ---- | ------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| L1  | The guide for writing a wizard of 0.3.0 ships with the kernel and does not assume the studio.              | (b)  | Must   | In the runtime's `prompts/authoring.md`, shown while the switch is on. The package has a README.                           | A guide in the package that an agent reads and then writes a working wizard from, tested with one. |
| L2  | Checking and compiling work on a wizard held in memory, and every issue has a file, a line and a sentence. | (b)  | Must   | `check` and `play` take a `Wizard` (`check.ts:33`). `checkDir` and `compile` read a folder (`check-dir.ts`, `compile.ts`). | The home hands step sources as strings and gets compiled steps or a list of issues back.           |
| L3  | A step file needs no build tool when it imports nothing.                                                   | (b)  | Should | `compile.ts` bundles with esbuild.                                                                                         | A step that is one file of plain code compiles without esbuild. The home then needs QuickJS only.  |
| L4  | What a step asks and where it goes can be read without running it, by any host.                            | both | Should | Built for the studio in the runtime: `apps/runtime/src/kernel/outline.ts`, types in `packages/shared`.                     | The outline is in the kernel package. The home shows a workflow in words and as a map from it.     |
| L5  | Tests with given answers, evals, and asking a past run again work in any host.                             | both | Must   | Built in the package: `check`, `play`, `evaluate`, `reask`, `judge`.                                                       | Covered by K6.                                                                                     |
| L6  | A workflow written in a home can be given to the studio.                                                   | (b)  | Later  | `POST /wizards/import` exists (`routes/api.ts:692`).                                                                       | Open, see decision 3.                                                                              |

### S. Starts

| #   | Requirement                   | Case | Weight | Today                                          | Done when                                                                    |
| --- | ----------------------------- | ---- | ------ | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| S1  | Starts stay outside the file. | both | Must   | True (`starts.ts:5`).                          | Stays true. A task of the home starts a run.                                 |
| S2  | A package can suggest starts. | (a)  | Should | Starts sit on the wizard's row in one install. | The manifest lists them. The home offers each as a task on the install card. |

How a suggested start maps to a task:

| Start in wizards                   | Task in the home                                             |
| ---------------------------------- | ------------------------------------------------------------ |
| `schedule`: hour, day, week, month | a time: hour, day, weekday, week. Month has no match yet.    |
| `webhook`                          | the event `webhook`                                          |
| `record`: a row added or changed   | the event `connection`: a read-only tool answers differently |
| `wizard`: another wizard finished  | none yet                                                     |
| none                               | the events `folder` and `mail`, which only a home has        |

## What the home builds

This is this repository's side. It is listed so that both sides see where the line is.

| Part                | In the home                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Store               | Runs and rows in `home.db`, with the refusal of a run someone else moved.                                                          |
| Agent ask           | A turn of a Mastra agent with the home's models and only the tools the ask names.                                                  |
| Tool ask            | A call of an MCP connection, under the rules of the home: not read-only asks first, and after data from outside every change asks. |
| Form, review, leave | A card. The answer goes to `answer`.                                                                                               |
| Wait                | The home's clock calls `wake`.                                                                                                     |
| Code                | QuickJS for every step.                                                                                                            |
| Install             | By conversation: a card with what the workflow may reach, and the bindings.                                                        |
| Supervised start    | The home answers `NeedsLeave` for every change in the first runs.                                                                  |
| Tasks               | A time or an event starts a run. Three failures in a row pause the task.                                                           |
| Guests              | A contact, a caller or a room never starts a run.                                                                                  |

## Not in scope

- Running a home's workflow in engenty's cloud.
- The runtime's pages, themes, widgets and media steps in a home.
- Converting a wizard of version 1 for a home. `toKernel` exists for that in the studio.
- Where an organisation's own agents run. A home that belongs to an organisation is one answer,
  and it is not decided.
- Work mode. It is part of the studio today.
- Credits. A home pays for its own models.

## When it is done

Two runs, each from start to end, each with a restart of the home in the middle:

1. **From the studio.** "Answer a customer" (`packages/kernel/examples/mail`) is published in the
   studio. A person installs it in a home. It reads the thread through the home's mail connection,
   a model of the home drafts the answer, the person reviews it on the phone, and a card asks
   before it sends.
2. **From the home.** The main agent writes the bookkeeping workflow of
   [intelligent-agents.md](intelligent-agents.md), section 9. A test run on five of the person's
   receipts passes. A folder task starts it.

## Order of work in the wizards repository

| Stage | Requirements               | After it                                                                   |
| ----- | -------------------------- | -------------------------------------------------------------------------- |
| 1     | K1, K2, K3, K9             | The home can install the kernel and check a file.                          |
| 2     | A1, A2, A4, A5, G3, G4, K5 | The home can write its batteries and its cards against a written contract. |
| 3     | K7, K8, K6                 | A run is known to survive a restart, also in a second host.                |
| 4     | L1, L2, L5                 | Case (b) works: the main agent writes and tests a workflow.                |
| 5     | C1, C2, C3                 | A workflow uses the home's connections.                                    |
| 6     | P1, P3, P4                 | Case (a) works: a home installs from the studio.                           |
| 7     | The rest marked Should     |                                                                            |

Case (b) comes before case (a): it needs nothing from the studio, and it proves the host.

## Open decisions

| #   | Decision                                                                                      | Recommendation                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The kernel's licence.                                                                         | MIT, as its plan proposes and as `packages/runner` is. A home is installed on other people's computers.                                                    |
| 2   | Where a studio-defined agent runs: in the home, or in the cloud with the home only answering. | In the home. Running in the cloud works over MCP today, but then the run uses the company's connections and models, and the person's data leaves the home. |
| 3   | Whether a workflow written in a home can be given to the studio.                              | Later. It asks first, as everything that leaves the home does.                                                                                             |
| 4   | How a home fetches a package: an MCP tool or the API.                                         | An MCP tool. The home already signs in to MCP connections, and has no other sign-in to the studio.                                                         |
| 5   | Roles other than `user`.                                                                      | Refuse such a wizard in a home at first. Later a role can be a contact or a member of a room.                                                              |
| 6   | Whether a package carries compiled steps (P2).                                                | Yes. It keeps esbuild out of a home that only installs.                                                                                                    |
| 7   | Whether the home also keeps Mastra workflows for anything.                                    | No. One engine for workflows. Mastra stays what answers an agent ask, as the kernel's plan says for the runtime.                                           |

## Sources

- `engenty-wizards`, branch `origin/feat/kernel` at `81160871`: `packages/kernel` (README, `src/types.ts`,
  `src/kernel.ts`, `src/grant.ts`, `src/quickjs.ts`, `src/check.ts`, `src/describe.ts`,
  `examples/mail`), `apps/runtime/src/kernel` (`batteries.ts`, `page.ts`, `host.ts`, `outline.ts`,
  `still.ts`), `apps/runtime/src/services/package.ts`, `apps/runtime/src/routes/api.ts`,
  `apps/runtime/src/mcp/tools.ts`, `packages/shared/src` (`definition.ts`, `kernel-file.ts`,
  `wizard-package.ts`, `starts.ts`, `store.ts`), `docs/plans/kernel.md`.
- This repository at `a3e6450`: `AGENTS.md`, `packages/protocol/src/index.ts`,
  `apps/home/src/agent/tool.ts`, `apps/home/src/agent/turns.ts`,
  `apps/home/src/connections/connections.ts`, `apps/home/package.json`.

Not read, or read only in part:

- `docs/plans/run-connections.md` in wizards: named by the kernel plan, not read.
- Whether `get_wizard`, `read_file` and `/wizards/:id/package` serve a wizard of 0.3.0 as a home
  would need it.
- The sync routes (`/sync/…`) of the runtime, which may already tell an install of a new version.
- How the WordPress plugin runs a wizard on a site. It is a second host of version 1 and may
  hold lessons for this one.
- `batteries.ts`, `page.ts`, `outline.ts` and `still.ts` were read at their heads and by search,
  not line by line.
