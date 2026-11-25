# Intelligent agents

A plan, not built. Written 2026-11-22. This plan asks how an agent of wizards.id can be more
than instructions plus skills, and whether engenty wizards should be its building block. The
open decisions are at the end, each with a recommendation.

Changed on 2026-11-22: the engine under a workflow is the kernel of wizards 0.3.0, not Mastra's
workflows. What the kernel has to offer for that is in
[wizards-in-the-home.md](wizards-in-the-home.md).

## In short

- An agent today is instructions, a memory note and tasks. Every turn has the same shape: a
  model with 16 tool rounds, and `go_on` for longer work. Reliability rests on the prompt alone.
  Nothing checks the agent's work, and it learns only what it chooses to write into its note.
- We add three things to an agent and keep the rest:
  - **workflows**: fixed steps where reliability matters, the model where judgment matters, and
    the person where a decision is theirs
  - **checks**: the agent's work judged before it counts
  - **lessons**: what the person corrected, kept as rules and examples
- One more thing comes later: examples that tune a step's instructions.
- **Engine: the kernel of wizards 0.3.0, with the home as its host.** A workflow is a wizard: a
  file that says what it may reach, and one function per step. The kernel moves the run. The
  home supplies where runs are kept, what answers an ask, and how step code runs (QuickJS).
- **Mastra stays where it is.** It is the agent loop, it answers an agent ask inside a workflow,
  and it holds a turn that waits for a card. Its workflows are not used: one engine, not two.
- **Two ways to get a workflow.** The main agent writes one in the conversation, or the person
  installs one a company made in the studio. Both run in the home, on the same host.
- **What it waits for.** The kernel is a draft (pull request #697), private and without a
  licence. The requirements for a second host are in
  [wizards-in-the-home.md](wizards-in-the-home.md). An agent can already run a published
  wizard in wizards' cloud over the wizards MCP connection; that is not tried yet.
- **First to build:** checks and lessons on today's agents, and a period in which a new agent
  asks before every change. None of this needs the kernel. Then workflows, made by the main
  agent in the conversation and tested on the person's own examples before a task may start
  them.

## 1. What an agent is today

Read in `AGENTS.md`, `apps/home/src/agent/`, `tasks/`, `skills/`, `docs/roadmap.md` and
`docs/network.md`.

| Part         | What it is                                                                                                                                                                                                                                                  | Where                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Instructions | Free text: the agent's task and how it works. Written by the main agent with `agent_create` and `agent_update`.                                                                                                                                             | `agent/tools.ts`                    |
| Memory       | One note of at most 6 000 characters, replaced whole by `remember` and shown in every turn. Mastra's working memory and semantic recall are off.                                                                                                            | `agent/tools.ts`, `mastra.ts`       |
| Tasks        | A prompt started by a time (`schedule_set`) or an event (`when_set`: a folder, a mail, a webhook, a look at a connection). Quiet tasks leave a note. A task that fails three times in a row is paused.                                                      | `tasks/tasks.ts`                    |
| A turn       | A Mastra agent run: up to 16 tool rounds, models tried in order, and tools that change with each step as skills load.                                                                                                                                       | `agent/turns.ts`                    |
| Longer work  | `go_on` with what is done and what is next, at most 8 turns in a row, none while a card waits.                                                                                                                                                              | `tasks/work.ts`                     |
| Tools        | The same base set for every agent: `ask`, `remember`, documents, artifacts, folders, connections, devices, tasks. The main agent also has the setup tools.                                                                                                  | `agent/tools.ts`, `home.ts`         |
| Skills       | Folders with a `SKILL.md` shipped with the home (word, excel, powerpoint, app-links, google-workspace), loaded by `skill_load` or by the words of a message. A person cannot add one.                                                                       | `skills/skills.ts`                  |
| Cards        | `call.ask(card)` suspends the Mastra run, and the answer resumes it inside the same tool call, also after the home restarts.                                                                                                                                | `agent/tool.ts`, `turns.ts`         |
| Questions    | `ask`: one free answer (written in the chat), a decision (buttons), several things at once (a form, typed values) or an approval (a card). The answer resumes the suspended run.                                                                            | `agent/ask.ts`                      |
| Other agents | `agent_message` hands a task to another agent, whose answer comes back as a `[home]` message. A card that agent asks the person with is no answer: the task waits for the turn after it. An agent in another home gets the text only after a yes on a card. | `agent/tools.ts`, `agent/handed.ts` |
| The phone    | `device_ask` hands a question to the phone's own model. Only the answer comes back.                                                                                                                                                                         | `devices/handoffs.ts`               |
| Network      | A shared agent answers guests with no tools. A room gets the agent's own things and none of the person's tools.                                                                                                                                             | `docs/network.md`                   |

**What it can do:** hold a conversation, keep a short note, act on a time or an event, work for
a few turns in a row, ask the person on a card, use the person's folders, connections and phone,
and hand work to another agent.

**What it cannot do:**

- Follow a procedure reliably. Every run of a task is the model deciding afresh what to do.
- Know whether its work is right. No check, no test, no score.
- Get better from corrections, except by the luck of what it writes into its note.
- Keep a procedure it worked out. A skill is code in the repository, not something an agent or
  a person makes.
- Be tried before it runs alone. A task runs live from its first start.
- Show what it is about to do as anything but a prompt the person would have to read.

## 2. What engenty wizards has

Read-only, in `/Users/m/code/engenty/engenty-wizards`. The local checkout stands 78 commits behind
`origin/main` (v0.20.0), so `origin/main` was read with `git show`. The kernel was first read in
the worktree `engenty-wizards-kernel`, which holds the closed pull request #694, and then again
on `origin/feat/kernel` (#697, an open draft).

| Piece                                  | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Where                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| The definition                         | One JSON document under a zod schema with a published JSON Schema. Its steps are `form`, `agent`, `tool`, `code` (QuickJS, no model), `decision` (a classifier's yes/no, choice or score), `generate`, `review`, `wait` (time or signal) and `result`. `next` rules branch on a condition or on a question a model answers, and a backward `goto` with `max` makes a loop. Values pass between steps as `{{steps.x.y}}` templates.                                                                                                                                                                                       | `packages/shared/src/definition.ts`                              |
| The runtime                            | Its own engine, not Mastra workflows. A loop moves a cursor, runs a step, saves state after each one, and stops at a form, a review or a wait. Mastra runs only inside a step: an `Agent` per agent step, durable agent turns, and Code Mode (`createCodeMode` from `@mastra/core/tools` with `@mastra/quickjs`).                                                                                                                                                                                                                                                                                                        | `apps/runtime/src/engine/runner.ts`, `steps.ts`, `tools/code.ts` |
| The pure transition                    | `transition(def, run, event, host)` takes an event in and gives one command out: run, decide, ask, sleep, wait for a signal, end or fail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `packages/shared/src/transition.ts`                              |
| Durability                             | libSQL tables `run`, `run_event`, `run_effect`, `run_signal` and `run_wait`, a runner line with heartbeats, and another runner taking over a lost run. Wait, signal, retries and `onFail` sit behind the switch `durableRuns`, off by default.                                                                                                                                                                                                                                                                                                                                                                           | `db/schema.ts`, `docs/plans/runner-process.md`                   |
| Results                                | Assets in a store, deliverables converted to files, share targets (mail, Slack, storage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `files/`, `render/`, `sharing/`                                  |
| Starts                                 | `schedule`, `webhook`, `record`, `wizard`, behind `startTriggers`, off by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `packages/shared/src/starts.ts`                                  |
| Authoring                              | `get_authoring_guide` (one guide for the studio's assistant and for MCP), starters, `create_wizard`, op-based `edit_wizard`, `validate_wizard`, `start_test_run` (every field answered, reviews accepted), publish, and the `.wizard` zip.                                                                                                                                                                                                                                                                                                                                                                               | `prompts/authoring.md`, `apps/runtime/src/mcp/tools.ts`          |
| Checks                                 | Output checked against its shape and repaired, retries, the person's review, guards on guest input. No judge model is merged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `steps.ts`, `safety.ts`                                          |
| The kernel (unmerged, switch `kernel`) | A wizard is a file of what it needs and may reach (`requires`, `connections` with `allow` or `ask` per action, `input`, `output`, `edges`, `limits`) plus one function per step, `(run, ask) => { value, to }`. `ask` is the only way to do anything. A run is a cursor and rows: every ask is a row, an ask that waits for a person stops the run, and the answer runs the step again from its top. A grant is made from the file when a run starts, and an ask outside it fails. Evals are files that judge a step and never route. 1 694 lines without tests on `feat/kernel`, depending only on QuickJS and esbuild. | `packages/kernel`, `docs/plans/kernel.md`                        |

**Licences and packaging.** Every package is `private`. The runtime is FSL-1.1-MIT and the format
files are FSL-1.1-MIT or MIT. The kernel's licence is not decided.

**What could move to wizards.id:**

| How                              | What                                                                                                                                                        | Verdict                                                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import the runtime               | `@engenty/wizards-runtime`                                                                                                                                  | No. Its runner imports its tenancy, credits, the managed cloud, its broker and plugins. It is a Hono service, not a library.                                                                                            |
| Share the format (version 1)     | The JSON definition, 3 500 lines of schema                                                                                                                  | Not now. It is built around pages, themes and media for people who fill in a wizard. An agent's work happens in the chat and in cards.                                                                                  |
| Share the format (kernel, 0.3.0) | The file plus step functions, rows, grant, evals                                                                                                            | Yes, as the engine and the format, once the requirements in `wizards-in-the-home.md` are met. It fits the home well: `ask` matches `call.ask`, rows survive a restart, and the grant matches "a connection asks first". |
| Run a wizard from an agent       | The wizards MCP server (`run_wizard`, `answer_form`, `review_step`, `get_run`) as a connection                                                              | Yes, though not tried yet. It is how an agent uses a wizard someone built, for media, documents and research, at the cost of wizards' credits.                                                                          |
| Take the ideas                   | One `ask`, rows, grant from the file, evals as files, test runs with stand-ins, an authoring guide plus starters, `decision` steps answered by a classifier | Covered by using the kernel itself.                                                                                                                                                                                     |

## 3. What the installed Mastra already ships

`@mastra/core` 1.82.0, read in `node_modules/@mastra/core/dist` and in Mastra's docs on
2026-11-22. The workflow builder was read in its types only, not in docs.

| Feature                                                                                                                                                                                                                                                                                                                                                            | In 1.82                                                                 | The home uses it                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Workflows: steps, `suspend` and `resume` with schemas, `sleep` and `sleepUntil`, branches, loops, `foreach`, parallel. Snapshots in storage survive a restart.                                                                                                                                                                                                     | `@mastra/core/workflows`                                                | No                                                                          |
| An agent or a tool as a workflow step (`createStepFromAgent`, `createStepFromTool`), and a classifier as a step (`createStepFromClassifier`)                                                                                                                                                                                                                       | `@mastra/core/workflows`                                                | No                                                                          |
| Workflow definitions as JSON: `WorkflowBuilderDefinition` with `agent`, `tool`, `classifier`, `mapping`, `workflow`, `parallel`, `foreach`, `sleep`, `sleepUntil`, `conditional` and `loop` entries; `normalizeWorkflowBuilderDefinition`, a preflight check, and `rehydrateWorkflow` to make a runnable workflow from the JSON. Agents and tools are named by id. | `@mastra/core/workflows/builder`, `workflows/dynamic`                   | No                                                                          |
| An agent that writes workflow definitions (`createWorkflowBuilderAgent`, with an authoring playbook and its constraints)                                                                                                                                                                                                                                           | `@mastra/core/workflows/builder`                                        | No                                                                          |
| Subagents on a supervisor (`agents: {}`), with hooks before and after a delegation. `.network()` is deprecated.                                                                                                                                                                                                                                                    | `@mastra/core/agent`                                                    | No: `agent_message` is the home's own                                       |
| A goal with a judge model asked after every run                                                                                                                                                                                                                                                                                                                    | `goal` on an agent                                                      | No: it takes a router model id, which a home's models are not (`AGENTS.md`) |
| Durable agents: the loop inside a workflow, re-driven after a crash, fenced claims                                                                                                                                                                                                                                                                                 | `@mastra/core/agent/durable` (beta)                                     | No                                                                          |
| Scorers on agents and steps, sampled; datasets of test cases; experiments; `runEvals`                                                                                                                                                                                                                                                                              | `@mastra/core/evals`, `datasets`                                        | No                                                                          |
| Tool mocks gathered from a run, and a mock model for tests                                                                                                                                                                                                                                                                                                         | `utils/collect-tool-mocks`, `test-utils/llm-mock`                       | No                                                                          |
| Working memory (a template or a schema), observational memory, semantic recall                                                                                                                                                                                                                                                                                     | `@mastra/memory`                                                        | No: the agent's note is the home's own                                      |
| Processors before and after each step: limits, moderation, prompt-injection detection                                                                                                                                                                                                                                                                              | `@mastra/core/processors`                                               | No                                                                          |
| Code Mode: the model writes TypeScript that calls tools, run in QuickJS                                                                                                                                                                                                                                                                                            | `@mastra/core/tools` with `@mastra/quickjs` (not installed in the home) | No                                                                          |
| Schedules for agents and workflows                                                                                                                                                                                                                                                                                                                                 | `@mastra/core/schedules`                                                | No: the home's own timer                                                    |

All of this is already installed, with storage in `mastra.db`. What stays the home's own: cards
and who may answer them, secrets, the timer and longer work, what leaves the home, and the rules
for guests, rooms and devices.

Mastra's workflows and its workflow builder are not used: the kernel is the engine (section 5),
and a second engine beside it would mean two formats, two stores of runs and two ways to wait
for a person. From this list a workflow uses the agent run, inside an agent ask.

## 4. Ways to make an agent more than a prompt

| Way                                | What it gives                                                                                                                                                   | What it costs                                                                                 | Prior art                                                                                                                                              | For wizards.id                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A workflow as the agent's skeleton | Reliable order, fixed steps where judgment is not needed, one picture of what the agent does, runs that survive a restart, and the person asked at known points | Someone has to write it. A rigid workflow fails on cases it did not foresee.                  | Wizards, Mastra workflows, LangGraph, CrewAI Flows, Microsoft Agent Framework workflows                                                                | Yes, as the core of this plan. The main agent writes it. A step that is a free agent turn keeps room for judgment.                                           |
| A goal or state machine            | The agent keeps going until a goal is met                                                                                                                       | A judge model call after every turn, and loops that never end                                 | Mastra `goal`, CrewAI's hierarchical manager                                                                                                           | Not as its own thing. `go_on` stays, and a check at the end of longer work replaces the judge after every turn.                                              |
| Sub-agents and delegation          | Fresh context per piece, parallel work, smaller prompts                                                                                                         | Hand-offs lose context and are hard to follow. Hidden helpers are hard to supervise.          | Mastra subagents, Claude Agent SDK subagents, OpenAI handoffs, Grok Bot's chief of staff                                                               | `agent_message` stays for the person's agents, which have conversations. Inside a workflow a step may call another of the person's agents. No hidden agents. |
| Code the agent writes and keeps    | Exact work (arithmetic, parsing, schedules) and fewer tokens. A toolbox that grows.                                                                             | A sandbox, a test for every tool, and a person who cannot read code being asked to approve it | Voyager, CodeAct, Anthropic's "code execution with MCP", Live-SWE-agent, wizards' Code Mode                                                            | A workflow's steps are code the main agent writes, run in QuickJS from the first workflow. Tools an agent keeps for its own turns come later.                |
| Checks (evaluation)                | Work judged before it counts. A score per run. A test set that catches regressions.                                                                             | Model calls for a judge, a judge that can be wrong, and test sets to maintain                 | Mastra scorers and datasets, Claude Managed Agents' outcomes (a rubric and a separate grader), wizards' kernel evals, Anthropic's "Demystifying evals" | Yes, first. Code checks where possible, a classifier where not.                                                                                              |
| Learning                           | Fewer of the same mistakes, behaviour that fits the person                                                                                                      | Memory that drifts or is poisoned by outside data                                             | Letta memory blocks and dreaming, LangGraph's semantic, episodic and procedural memory, DSPy optimizers, Grok Bot's per-bot memory                     | Lessons from the person's corrections only, kept apart from the memory note. Tuning instructions from examples comes later.                                  |
| Planning and longer work           | Work over hours or days, and a plan the person can see                                                                                                          | Plans go stale. Turns cost money.                                                             | `go_on`, Mastra durable agents, Claude Agent SDK background subagents                                                                                  | `go_on` stays. A workflow with `wait` steps covers work spread over days.                                                                                    |
| Reacting to events                 | The agent acts when something happens, not only when spoken to                                                                                                  | Noise, and outside data that tries to steer the agent                                         | Grok Bot routines, wizards' starts and signals, CrewAI `@listen`                                                                                       | Built already (`when_set`). A task can now start a workflow, and a workflow can wait for an event.                                                           |

**Grok Bot**, read in xAI's design article "Designing Grok Bot for a world of persistent agents"
(2026-09-03) and in docs.x.ai/grok-bot, is closest to us in what an agent is:

- a persistent bot with its own memory and routines
- skills shared by all bots
- routines started by a schedule or an event
- "Ready to send" cards
- review of every action before it runs, with rules in plain language

Its skill format is close to what a workflow is here: when to use it, inputs and access, the
steps, how to validate, what to return, and what needs approval. It makes a skill from the chat
("save this as a skill") or from a recorded demonstration, and advises testing it before it is
scheduled.

Where wizards.id differs:

- It runs in the person's own home, not on a cloud computer.
- A workflow is checked by code before it runs, not left to the model following a skill.
- It is shared across homes as a copy, after a yes.

## 5. What an intelligent agent is in wizards.id

An agent stays what it is: its instructions, its memory and its tasks, read in every turn. It
gains four parts. Each one is set by conversation and shown to the person in words.

| Part              | What it holds                                                                                                                                                             | Today                      | New                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| Instructions      | Its job and how it works                                                                                                                                                  | Yes                        | —                                              |
| Memory            | The note it keeps                                                                                                                                                         | Yes                        | —                                              |
| Tasks             | What starts it: a time or an event                                                                                                                                        | Yes                        | A task starts a turn, as today, or a workflow. |
| Workflows         | Named procedures: steps, where each step's input comes from, what it may reach, where the person is asked                                                                 | —                          | Yes                                            |
| Checks            | What makes a result good: a rule in code, or a question a model answers with yes/no or a score. Run after a step or at the end.                                           | —                          | Yes                                            |
| Lessons           | Rules and examples from the person's corrections ("a receipt from X is office supplies"), kept apart from the memory note                                                 | —                          | Yes                                            |
| What it may reach | Its folders, connections, devices and tools, and for each action whether it is allowed or asks first. Made from the workflows, shown on the card that installs the agent. | Every agent has every tool | Yes                                            |

### A workflow

A workflow is a wizard in version 0.3.0: a file, one function per step, and files that judge.

```
file-receipt/
  wizard.json     what it needs and may reach, its input, its map
  steps/
    read.ts       one function per step, always the same interface
    find.ts
    unsure.ts
    book.ts
  evals/
    find/         judges the step `find`, every time it returned
      fields.ts
      totals.ts
```

The file:

```json
{
  "version": "0.3.0",
  "title": "File a receipt",
  "requires": { "models": ["standard", "classifier"] },
  "connections": {
    "folder": { "read": "allow", "look": "allow", "write": "ask", "move": "ask" }
  },
  "input": { "fields": [{ "id": "file", "label": "File", "kind": "text" }] },
  "start": "read",
  "edges": {
    "read": ["find", "end"],
    "find": ["book", "unsure"],
    "unsure": ["book"],
    "book": ["end"]
  },
  "limits": { "find": 3 }
}
```

A step:

```ts
export default async function (run, ask) {
  const found = await ask({
    type: "agent",
    model: "standard",
    instructions: `Find date, shop, amount, tax and category in this receipt: ${run.steps.read.text}`,
    fields: [
      { id: "shop", kind: "text", required: true },
      { id: "total", kind: "number", required: true },
      { id: "sure", kind: "number", required: true },
    ],
  });
  return { value: found, to: found.sure > 0.8 ? "book" : "unsure" };
}
```

How the home's folders are named in a file (`folder` above) is not settled. It is the home's side
of requirement C1 in [wizards-in-the-home.md](wizards-in-the-home.md).

What a step does, it does through `ask`:

| In a step         | What it does                                                                                                                  | In the kernel                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Agent             | A turn of this agent with the step's instructions, the tools the step names and an output shape. This is where judgment goes. | An `agent` ask, answered by a Mastra agent run with the home's models                              |
| Tool              | One of the home's tools, or a connection's, with fixed arguments. No model.                                                   | A `tool` ask                                                                                       |
| Decide            | A question with yes/no, a choice or a score, answered by a model                                                              | A `decision` ask                                                                                   |
| Ask the person    | A card. The run waits for the answer.                                                                                         | A `form` or `review` ask. The row waits, and the card's answer goes to `answer`.                   |
| Hand to the phone | `device_ask` to the phone's own model. The run waits for the answer.                                                          | A `tool` ask for that tool of the home                                                             |
| Hand to an agent  | `agent_message` to another of the person's agents                                                                             | A `tool` ask for that tool of the home                                                             |
| Wait              | Until a time, or until an event of the kinds a task knows                                                                     | An ask with a `timeout`. The home's clock calls `wake`.                                            |
| Branch, loop      | Code in the step picks a way                                                                                                  | The step returns `to`. The ways are in `edges`, and `limits` says how often a step may be reached. |
| For each          | Several asks side by side in one step                                                                                         | Code in the step                                                                                   |
| Check             | Judges a step's output, never routes, and is scored on the run                                                                | A file under `evals/`                                                                              |

What a workflow looks like to the person is its steps in words, drawn as a short list in a
document beside the chat. They never see the file or the code. The words come from an outline
of the steps, read without running them (requirement L4). The agent's own answer to "what do
you do when a receipt arrives?" is read from the same outline.

What a run may reach is made from the file when the run starts. An ask for anything else fails,
and an action set to `ask` makes a card. The home's rules sit above the file. What leaves the
home asks first, and a turn that read outside data asks before every change in a connection.
The home asks where the file allows, never the other way round, and a workflow cannot set these
rules aside.

### A run

- **Storage.** A run is a cursor and rows, kept in `home.db`: every ask is a row, and every step
  that returned is a row. The home keeps beside it the agent, the task that started it and the
  scores.
- **Waiting.** A run that waits for a card or a hand-off runs nothing. The answer moves it on,
  also after a restart: the kernel is built again from what is stored.
- **What the person sees.** The person sees a run as one message in the agent's conversation that
  grows step by step. A quiet run leaves a note. A failed check, a step that asks or a limit
  reached tells the person.
- **Steps run again.** When an answer comes, the step runs again from its top, and asks that
  were answered give their answers back. So a step only computes and asks. What changes
  something is an ask, and an ask is made once.

## 6. How a person makes one

Everything happens in the conversation with the main agent, as setting up a device or a
connection does today.

1. **The person says what they want.** "Every receipt I drop into Receipts should be booked, and
   ask me only when you are not sure."
2. **The main agent asks only what it cannot infer,** in one or two cards: which folder, where the
   bookings go, which categories, what counts as unsure.
3. **The main agent writes a draft** with one tool, `agent_build`. The draft holds the agent's
   instructions, its workflows (each a file and its step files), its checks, its first lessons
   and what it may reach. The kernel checks it: the file against its schema, the map against
   the step files, and every step compiled. The home's own check confirms that every tool
   exists and that no step sends or publishes without a card. The main agent fixes what the
   checks report, as wizards' assistant does with `edit_wizard` until "issues" is empty.
4. **The person sees it in words**: a document beside the chat ("When a file arrives in Receipts:
   read it, find date, shop, amount and tax, …") and a card with what the agent may reach and
   what it asks first.
5. **A test run, before anything is real** (next section). The person sees the results next to
   their own examples.
6. **The person says yes on the card.** The agent exists, and its tasks are set.
7. **A supervised start.** For its first runs the agent asks before every change, also where its
   `asks` say `allow`. After enough runs that passed their checks, it offers on a card to act
   alone where the person agrees. "Always" never covers what leaves the home.
8. **Changes go the same way.** The person tells the agent, or the agent proposes a change after
   a correction. The main agent rewrites the draft, the check and the test run happen again, and
   the person says yes. Every version is kept, as for documents.

Wizards' starters become **starters for agents**: a few built-in agents (bookkeeping, study
helper, mail sorting) the main agent adapts instead of writing from nothing. The kernel's guide
for writing a wizard (requirement L1) is the base for the main agent's guide, with the home's
own tools and rules added.

An agent can also come from a company's studio, already written. The person installs it on a
card that shows what it may reach, and it goes through the same test run and supervised start.
That case is in [wizards-in-the-home.md](wizards-in-the-home.md).

## 7. Testing before it runs alone

| Test                                | What it checks                                                                                                                                                                                                                                                                          | Built on                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| The check of the definition         | The file fits its schema, the map fits the step files, every step compiles, every loop has a limit, and nothing sends without a card                                                                                                                                                    | The kernel's schema, `describe` and compile, plus the home's own rules                                                              |
| A test run on the person's examples | The workflow runs on two to five real inputs (receipts already in the folder, a photo of notes). Steps that change something are answered by stand-ins that record what they would have done. Cards are answered by the person, or by the test with the answer the main agent proposes. | The kernel's `play` with a case, and batteries that stand in                                                                        |
| Checks on the test run              | Every check runs and is scored. The person sees the scores and what each stand-in would have done.                                                                                                                                                                                      | The kernel's `judge`                                                                                                                |
| A test set                          | The examples of the test run, and every case the person corrected later, kept with the expected result. Run again on every change of the workflow. A change that makes a passing case fail is shown before it is kept.                                                                  | The kernel's `check` with cases and `evaluate` with a dataset; Anthropic advises starting from 20–50 tasks drawn from real failures |
| A past run asked again              | One ask of a stored run, asked again with the new step or another model                                                                                                                                                                                                                 | The kernel's `reask`                                                                                                                |
| Live checks                         | Checks run on every real run, or on a share of them                                                                                                                                                                                                                                     | `judge`, when and how often the home decides                                                                                        |

A test run sends nothing, publishes nothing and changes no file or connection. A model that
should not see the data (a photo of the person, a phone's data) does not see it in a test either.

## 8. How it fits the rules of the home

| Rule                                                       | What it means for an intelligent agent                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything is set up by conversation                       | Agents, workflows, checks and lessons are written by the main agent's tools. The person approves on a card and sees them in words. There is no page and no flag.                                                                                                                                                                                                                                                                         |
| A secret never enters a message, a tool result or a prompt | A workflow names a connection, never a secret. A tool the agent writes gets no secret: it calls the home's tools, which hold them.                                                                                                                                                                                                                                                                                                       |
| Data from outside is data                                  | A step's output that came from outside data (a mail, a file, a connection's answer) is marked and goes into the next step between `⟦outside⟧` lines. It never becomes a step's instructions, a lesson or a change to the workflow. Lessons come from the person only. Memory written by a step that read outside data is a suggestion the person keeps or drops, which is also Anthropic's advice on memory stores.                      |
| What leaves the home asks first                            | A step that sends, publishes or hands to another home makes a card, every time, inside a run as in a turn. The home asks where a workflow's file allows, never the other way.                                                                                                                                                                                                                                                            |
| A connection's tool that is not read-only asks first       | It does so in a workflow too, after outside data always. During the supervised start, every change asks.                                                                                                                                                                                                                                                                                                                                 |
| Folders                                                    | A workflow reaches only the folders bound to it when it was installed. It changes files only in a folder connected for changes, and asks. Whether one workflow step may have a standing yes is decision 6.                                                                                                                                                                                                                               |
| The phone                                                  | The phone runs no workflows: its model has a 4 000-token context. A step hands it a question with `device_ask`, and the phone asks its person before every change. A workflow that needs the phone names it in what it requires, and the phone's per-agent yes applies as today.                                                                                                                                                         |
| Shared agents                                              | A guest gets answers, as today: no tools, no workflows, no runs. Sharing an agent as a copy carries its instructions, workflows, checks and starter lessons. It never carries its memory, its learned lessons, its test set (which holds the person's data) or its runs. The contact's home shows what the copy may reach on a card before it installs it, and runs its own test. Its steps run in QuickJS there, as they do everywhere. |
| Rooms                                                      | An agent in a room brings what is its own, as today. It runs no workflow there and starts none from what the room writes.                                                                                                                                                                                                                                                                                                                |
| Outside agents and wizards                                 | A workflow step may ask an outside agent over A2A or run a wizard over the wizards MCP connection. What comes back is outside data.                                                                                                                                                                                                                                                                                                      |

## 9. Two example agents

### Bookkeeping: files receipts from a folder and asks only when unsure

**Set up.** The person says: "Book every receipt I put into Receipts. Ask only when you are not
sure." The main agent asks two things on cards: where the books are (an Excel file in the
connected folder Books, connected for changes) and which categories to use (it proposes ten).
It writes the agent Ledger.

| Part                       | Ledger has                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions               | Books receipts for the person's work; categories; currency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Task                       | `when_set` on the folder Receipts. A new file starts the workflow "File a receipt". On the first day of each month, "Close the month".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Workflow "File a receipt"  | 1. Read the file (tool `folder_read`, or `folder_look` for a picture). 2. Find date, shop, amount, tax, currency and category (agent step with an output shape). 3. Decide: is this a receipt at all? 4. Check: the tax and net add up to the total (code), and the date lies in the past year (code). 5. Decide: sure? (a score from 0 to 1 against the lessons). 6. If sure and the checks pass: write the row into the book and move the file to `Books/2026/11/` (tools, each asking during the supervised start, and asking as decision 6 settles afterwards). 7. If not sure: a card with the receipt, the fields found and a choice of category. The answer becomes a lesson, then step 6. |
| Workflow "Close the month" | Sums per category (tool on the book), a check that every file of the month has a row, and a document "November 2026". Then a card: "Send it to your accountant?" Sending asks, always.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Checks                     | `receipt-fields`: every field is there and has the right type. `totals-add-up`. At the end: the number of files equals the number of rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Lessons                    | Start empty. "Shop X is office supplies" after the first correction. "Fuel receipts are travel" after the second.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Reaches                    | Receipts (read), Books (change). No connection, no phone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Test.** Before the task is set, the main agent runs "File a receipt" on the five newest files
in Receipts with stand-ins for the write and the move. The person sees five rows that were not
written, two cards it would have asked, and the scores. They correct one category, which becomes
a lesson and a case in the test set. Then they say yes.

**Running.**

- A new receipt arrives at 14:02. Ledger reads it, the checks pass, and it is sure. During the
  supervised start a card asks: "Book Office World, 23.80 EUR, office supplies?"
- After 20 runs that passed their checks, Ledger offers on a card to book without asking where it
  is sure. From then on a quiet run leaves a note ("Booked 3 receipts today").
- A receipt it cannot read, or a total that does not add up, is a card every time.

**What is new over today.** Today Ledger would be a prompt that sometimes forgets the tax, has no
way to know that it did, and asks either always or never.

### Study helper: plans revision from photos of notes and quizzes on a schedule

**Set up.** The person says: "I have a biology exam on 15 January. I'll send you photos of my
notes. Make me revise." The main agent asks what the exam covers and when the person likes to
revise (cards with choices). It writes the agent Owl.

| Part                                                                | Owl has                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions                                                        | Helps the person learn for the biology exam on 15 January. Asks short questions and explains wrong answers from the notes only.                                                                                                                                                                                                                                                                                                                                                                                                           |
| Workflow "New notes" (starts when the person sends photos)          | 1. Read each photo (agent step with a picture: the home's own model or a subscription, as the files rule says). 2. Write the topics and facts found into the document "Biology notes" (tool `document_write`). 3. Check: every fact stands in a photo (a model answers yes/no per fact). A fact that fails is marked, not kept. 4. Make five to ten questions per topic, each with its answer and the passage it comes from (agent step with an output shape). 5. Put the new questions into the question bank, all due tomorrow (tool).  |
| Workflow "Quiz" (task: weekdays at 18:00, and on the person's word) | 1. Pick the questions due today, at most ten (tool, no model). 2. Ask one question at a time on a card with a text field, on the phone or the watch as the person reads it. 3. Wait up to two hours for each answer, else stop for today. 4. Judge the answer against the stored answer (agent step, score 0 to 1, with the reason). 5. Move the question in the schedule: right moves it further out, wrong brings it back tomorrow (tool, no model). 6. At the end, one message: what went well, and the three topics to look at again. |
| Workflow "Plan" (task: Sundays)                                     | From the exam date, the topics and the scores: a plan for the week as a document, and the quiz times adjusted.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Checks                                                              | Grounding (step 3 of "New notes"). A question has exactly one answer, found in the notes. The judging of answers is spot-checked: on a share of runs, the person sees the judge's reason and can overrule it, and an overruled judgment becomes a lesson.                                                                                                                                                                                                                                                                                 |
| Lessons                                                             | "Don't ask for dates." "Latin names count only when spelled right."                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Exact work in code                                                  | The schedule of step 5 (when a question is due next) is code in that step, written by the main agent and covered by a test case.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Reaches                                                             | Documents of its conversation, the question bank, cards on the phone and the watch. No folder, no connection.                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Test.** Owl runs "New notes" on the first three photos and shows the notes document, the
questions and two facts it marked as not found in the photos. The person removes one question
that is wrong, which becomes a case in the test set. A quiz runs once, in the chat, with the
person answering.

**Network.** The person shares Owl with a classmate as a copy. The copy carries the workflows,
the checks and the starter lessons, not the question bank or the person's answers. The classmate's
home shows what it reaches and installs it after a yes. The notes document can be sent separately,
after a yes.

## 10. Recommendation

| Option                                          | Gives                                                                                                                                                                                          | Costs                                                                                                                                                   | Pick                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Import the wizards runtime                      | A complete engine with forms, reviews, files and starts                                                                                                                                        | A second server inside the home, tied to tenancy, credits and broker; private; FSL                                                                      | No                                                     |
| Share wizards' format (version 1)               | One format for both products                                                                                                                                                                   | A page-centred schema of 3 500 lines; nothing in it for cards, the phone or the network                                                                 | No                                                     |
| The kernel of wizards 0.3.0, hosted by the home | One format and one engine for the studio and the home, step code a model writes well, rows, a grant from the file, evals, tests with given answers. A company's agent runs in a person's home. | A draft, private, without a licence, not tried with a real model or across a restart. The home adds QuickJS. The home waits for the wizards repository. | **Yes, as the engine and the format**                  |
| Mastra workflows with stored JSON definitions   | Installed already, durable in `mastra.db`, an authoring agent and its guide                                                                                                                    | A second format beside wizards', so nothing made in the studio runs in a home. The builder was read in its types only.                                  | No                                                     |
| Wizards over its MCP connection                 | Every published wizard as a tool of an agent, run in wizards' cloud                                                                                                                            | Wizards' credits, and the run's data leaves the home (a card first). Not tried yet.                                                                     | Yes, for wizards that need the cloud's media and pages |

So: an intelligent agent of wizards.id is today's agent plus workflows, checks and lessons. A
workflow is a wizard of version 0.3.0. The kernel moves its runs, the home is the kernel's host,
and Mastra answers the agent asks. It is made and changed by the main agent in the conversation,
or installed from a studio.

## 11. Stages

Requirement numbers are those of [wizards-in-the-home.md](wizards-in-the-home.md).

| Stage | What                                                                                                                                                                                                                                                                                                                                                                                                                         | After it                                                       | Needs from wizards / the home's own                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0     | Run a wizard from an agent: the wizards MCP server as a connection, with its widget's `browserUrl` on a card                                                                                                                                                                                                                                                                                                                 | An agent can use a wizard someone built, run in wizards' cloud | Nothing new / the connection card                                                               |
| 1     | **Checks and lessons on today's agents.** A check per task (code, or a question a model answers), scored after each run, failures told to the person. A check gives a score from 0 to 1 and a reason, as a kernel eval does, so it moves into a workflow unchanged. Lessons from corrections, kept apart from the note and shown in every turn. A supervised start for every new task: every change asks for the first runs. | Today's agents become trustworthy before any workflow exists   | Nothing / the checks, the lessons, the supervised start, the cards                              |
| 2     | **Workflows written in the home.** The kernel installed. Runs and rows in `home.db`. What answers an ask: a Mastra agent run, a tool of the home, a card, the clock. Step code in QuickJS. `agent_build` for the main agent. A task starts a workflow. A run shown as one growing message.                                                                                                                                   | The bookkeeping agent                                          | K1 to K5, K7, K8, A1 to A5, G3, G4, L1, L2 / the store, the answers, the cards, the run message |
| 3     | **Testing.** Test runs with stand-ins on the person's examples, a test set per agent, run again on every change                                                                                                                                                                                                                                                                                                              | No workflow runs alone untested                                | L5, K6 / the stand-ins that record, the card with the results                                   |
| 4     | **Connections in a workflow.** A workflow names a connection and its actions. The person binds each to one of the home's connections on a card.                                                                                                                                                                                                                                                                              | A workflow reads and writes mail                               | C1 to C3 / the binding card, the rules for changes                                              |
| 5     | **Workflows from a studio.** The home lists what a person may install, fetches a published package, pins its version, and shows a card when a new version changes what it may reach.                                                                                                                                                                                                                                         | A company's agent in a person's home                           | P1, P3, P4, then P2, P5, P6 / the install card, the version card                                |
| 6     | **Starters and sharing between homes.** Three starter agents. A copy of an agent carries its workflows and checks, and the contact's home installs it after a card and a test.                                                                                                                                                                                                                                               | The study helper. Agents passed between homes.                 | Nothing new / the copy, the install card                                                        |
| 7     | **Tuning from examples.** A step's instructions improved against its test set, the person seeing the before and after                                                                                                                                                                                                                                                                                                        | Fewer corrections over time                                    | `evaluate`, `reask` / which runs count as examples                                              |

**What to build first:** stage 1, which waits for nothing. Then stage 2 with Ledger as the first
agent end to end. It has a folder event, fixed steps, a model step, code checks, cards when
unsure and a monthly document, which covers most of the plan in one small agent. Stage 2 starts
when the kernel can be installed in this repository.

## Open decisions

| #   | Decision                                                                                       | Recommendation                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The engine under a workflow: Mastra's workflows, wizards' kernel, or the home's own            | Wizards' kernel, with the home as its host. One engine and one format for the studio and the home, so a company's agent runs in a person's home. Mastra stays the agent loop and answers an agent ask. This bends "build on what Mastra ships" for workflows, and the reason is the shared format.                                                                                    |
| 2   | The format: Mastra's `WorkflowBuilderDefinition` inside the home's wrapper, or wizards' format | Wizards' format in version 0.3.0: a file and one function per step. No wrapper of the home's and no converter. What the home adds (the agent, its task, the bindings of folders and connections) sits beside the file, not in it.                                                                                                                                                     |
| 3   | Where an agent's definition lives                                                              | In `home.db`, versioned as documents are: the agent, and each workflow as its file and step sources. Shown to the person as a document in words. It is not a file in a folder an agent could change.                                                                                                                                                                                  |
| 4   | Who changes a workflow                                                                         | The main agent writes it. The agent itself may propose a change after a correction. The person says yes on a card every time, and the test set runs first.                                                                                                                                                                                                                            |
| 5   | Where learning comes from                                                                      | Only from the person: corrections, answers on cards, words in the chat. Nothing read from outside, from a guest or from a room. Lessons are shown and can be removed by asking, as Grok Bot does without a memory screen.                                                                                                                                                             |
| 6   | Whether a workflow step may change files or a connection without a card each time              | Not during the supervised start. Afterwards, per step and on the person's yes, only inside a folder connected for changes, with each change listed in a note and undoable. Never for a connection after outside data, and never for what leaves the home. This loosens "asks before each change" for folders, so it needs its own yes from the owner before it goes into `AGENTS.md`. |
| 7   | How long the supervised start lasts                                                            | Until a number of runs passed their checks (20 for a task started by events, 5 for one started by time), then a card offers to act alone. The person can return to it at any time.                                                                                                                                                                                                    |
| 8   | Which model judges                                                                             | The home's own model list, with a local model first for checks on data that may not leave the home. Code checks wherever a rule can be written. Not Mastra's `goal` judge, which takes a router model id.                                                                                                                                                                             |
| 9   | Sub-agents                                                                                     | Keep `agent_message` between the person's agents. A workflow step may hand to one of them. No helper agents the person cannot see. Mastra's subagents only if a step needs parallel helpers, and then as steps of the run.                                                                                                                                                            |
| 10  | Mastra's working memory and observational memory                                               | Keep the memory note as it is. Lessons are a second, structured part beside it. Try observational memory for long conversations separately; it does not decide this plan.                                                                                                                                                                                                             |
| 11  | Code the agent writes                                                                          | A workflow's steps are code from the first workflow on, written by the main agent. QuickJS only, reaching only what the file grants, checked and test-run before the person's yes. The person sees what it does and its test results, not the code. Tools an agent keeps for its own turns are not planned yet.                                                                       |
| 12  | Shared agents and workflows                                                                    | A guest never starts a workflow. A copy carries workflows, checks and starter lessons, and nothing learned from the person. The receiving home tests it before it runs.                                                                                                                                                                                                               |
| 13  | New words                                                                                      | Add to the words table: **workflow** (steps an agent goes through, not "routine", "pipeline" or "playbook"), **step**, **check** (not "eval" or "scorer" in copy), **lesson** (what the person taught, not "feedback" or "learning"), **test run**, **supervised start**. A task keeps its word: it starts a turn or a workflow.                                                      |

The decisions about the kernel itself (its licence, where a studio's agent runs, how a home
fetches a package, roles, compiled steps) are in
[wizards-in-the-home.md](wizards-in-the-home.md).

## Sources

Read on 2026-11-22 unless marked.

- wizards.id: `AGENTS.md`, `docs/roadmap.md`, `docs/network.md`, `apps/home/src/agent/`,
  `tasks/`, `skills/`, `mastra.ts`, `node_modules/@mastra/core` 1.82.0 (`workflows`,
  `workflows/builder`, `workflows/dynamic`, `evals`, `datasets`, `agent`, `signals`,
  `schedules`).
- engenty wizards: `origin/main` at v0.20.0 through `git show`: `packages/shared/src/definition.ts`,
  `transition.ts`, `run.ts`, `starts.ts`, `apps/runtime/src/engine/`, `tools/code.ts`, `mcp/tools.ts`,
  `prompts/authoring.md`, `COPYRIGHTS.md`. The kernel on `origin/feat/kernel` at `81160871`
  (#697): `docs/plans/kernel.md`, `packages/kernel` (README, `src/types.ts`, `src/kernel.ts`,
  `src/grant.ts`, `src/quickjs.ts`, `src/check.ts`, `examples/mail`), and the runtime's host in
  `apps/runtime/src/kernel`. The full list is in `wizards-in-the-home.md`.
- Mastra docs: mastra.ai/docs/subagents, /reference/migrations/network-to-supervisor,
  /docs/workflows/suspend-and-resume, /docs/workflows/agents-and-tools,
  /docs/harness/durable-agents, /docs/memory/working-memory, /docs/memory/observational-memory,
  /docs/evals/overview, /docs/agents/processors. Not read: skills and workspaces pages, and
  workflows as tools of an agent (from memory).
- Claude Agent SDK: code.claude.com/docs/en/agent-sdk (overview, subagents, hooks, sessions).
  "New in Claude Managed Agents" (claude.com, 2026-05-19) for outcomes, dreaming and memory
  stores. The memory-store page is known from search snippets only.
- OpenAI Agents SDK: openai.github.io/openai-agents-python (handoffs, guardrails, sessions,
  tracing).
- LangGraph: docs.langchain.com (persistence, interrupts, memory).
- DSPy: the optimizers page in the GitHub repository. Signatures and modules from memory.
- Letta: docs.letta.com (memory blocks, memory and dreaming). Shared memory from a search snippet.
- CrewAI: docs.crewai.com (processes, flows). Microsoft Agent Framework: learn.microsoft.com
  overview. Its 1.0 announcement from search snippets only.
- xAI: x.ai/news/designing-grok-bot, docs.x.ai/grok-bot (how Grok Bot works; skills, routines
  and automations), x.ai/bot/guides/grok-bot-101. The design article and the docs disagree on
  whether each bot has a computer of its own or all of a person's bots share one.
- Voyager (arXiv 2305.16291), CodeAct (2402.01030), Live-SWE-agent (2511.13646), Anthropic
  "Code execution with MCP" (2025-11-04), Anthropic "Demystifying evals for AI agents"
  (2026-01-09).
