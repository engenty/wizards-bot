# The protocol between a home and its devices

A **home** is wizards.bot running on a computer or a VPS. A **device** is the iOS app, the watch
app or another computer of the same person. Devices speak HTTP and JSON to the home and read
one event stream. The shapes are in `packages/protocol/src/index.ts`; this file adds the routes
and examples. Times are ISO 8601 in UTC. Ids are opaque strings.

Base URL: the home's address, e.g. `http://192.168.1.20:4747` or `https://me.example.com`.
Every route below except `GET /health`, `GET /v1/home` and `POST /v1/pair` needs
`Authorization: Bearer <device token>`. An artifact's page and the libraries it loads take no
token either; see "Artifacts". Nor does a published link; see "Sharing".

Errors are `{ "error": "<code>", "message": "<sentence for the person>" }` with a 4xx or 5xx
status. Codes a device handles: `unauthorized` (401: pair again), `already_answered` (409),
`version_conflict` (409), `needs_consent` (409: ask the person, see "Models"), `not_found` (404).

## Home and pairing

`GET /health` → `{ "ok": true, "home": true, "version": "0.2.0" }`: the home runs, it is a Bot
Server, and its version. For a proxy, Coolify, a status page and the Mac app, which tells a Bot
Server from another program on port 4747 by it. Earlier homes answer `{ "ok": true }`.

`GET /v1/home` → `HomeInfo`

```json
{
  "protocol": 1,
  "version": "0.1.0",
  "name": "Matthias",
  "handle": "matthias@me.example.com",
  "publicKey": "…",
  "hosted": false
}
```

`hosted` is true for a Bot Server at `<name>.wizards.bot`, which engenty runs: its pages show
engenty's imprint, privacy policy and terms. A Bot Server on someone's own computer shows none.

`POST /v1/pair` with `PairRequest` → `PairResponse`. The code comes from `wizards-bot pair` in a
terminal or from a pairing card in the chat. It is 8 characters, valid for 10 minutes, used once.
The QR of a pairing card holds `wizardsbot://pair?home=<base url>&code=<code>`. The home's own web app pairs
as kind `browser` from `<base url>/#code=<code>`; the code sits after the `#`, which a browser
never sends to a server. A wrong, used or
expired code answers 401 `unauthorized`; five wrong codes in a minute answer 429 `too_many`.
A demo home for App Review also takes `WIZARDS_BOT_DEMO_CODE` (at least 8 letters and digits),
again and again and without running out; never on a home with a person's data. A hosted home
takes `WIZARDS_BOT_SETUP_CODE` once, for its first device, and only while it has none.

```json
{
  "code": "K7QM-2RXD",
  "name": "Matthias's iPhone",
  "kind": "phone",
  "push": { "token": "<apns hex>", "environment": "development", "topic": "bot.wizards" }
}
```

```json
{
  "token": "<bearer token>",
  "device": { "id": "dev_…", "name": "…", "kind": "phone", "createdAt": "…", "seenAt": "…" },
  "home": { "protocol": 1, "version": "0.1.0", "name": "Matthias", "publicKey": "…" }
}
```

`GET /v1/device` → `Device`: the device that asks, as the home knows it.
`PATCH /v1/device` with `UpdateDevice` → `Device`. Sets the push token, the name and quiet hours.
`DELETE /v1/device` signs this device out. What a device keeps and offers its agents is in
"Devices and what they keep".

A watch pairs through its phone: the phone calls `POST /v1/devices` with
`{ "name": "…", "kind": "watch" }` and hands the returned `PairResponse` to the watch.

### A group home

A group home belongs to a team, not to one person (`docs/network.md` §5). `HomeInfo.group` is
`{ "name": "Club" }` and `name` is the team's. Its **admins** run it: each of their devices
carries `admin: { id, name }`, also in `PairResponse.device`, so a device knows whose it is.

- An admin's first device pairs with a pass from the Manage-App (`docs/hosted.md`, Contract
  11): the web app opens at `<base url>/#admin=<pass>` and sends `POST /v1/pair/admin` with
  `PairAdmin` `{ "pass": "…", "name": "Ada's browser", "kind": "browser" }` → `PairResponse`.
  A pass that is wrong, old, used or not an admin's answers 401 `unauthorized`.
- Further devices pair with a code from a pairing card the admin asks for: it pairs the device
  as that admin. A group home takes no code that is not an admin's, and no setup code.
- Every admin's devices see every conversation of the home's agents and its rooms. A message an
  admin wrote has `role: "you"` and `from: { "name": "Ben", "admin": "<id>" }`; a device shows
  the writer when it is not its own admin. What someone else writes to a shared agent reaches
  no admin's device, as in any home.
- A card waits for every admin. The first answer counts; its `answer.admin` says who gave it,
  `answer.by` on which device. The agent hears who answered.
- Each admin reads for themselves: `unread` in `GET /v1/agents` and in `agent.updated` is what
  the device's admin has not read, and `POST /v1/conversations/:id/read` marks it for them.
- A device offers nothing to the agents: `PUT /v1/device/resources` answers 409 `group_home`.
- An admin the Manage-App no longer lists loses their devices within a minute: their token
  answers 401 `unauthorized`.

## Agents and conversations

`GET /v1/agents` → `{ "agents": Agent[] }`. The main agent comes first. Each agent has one
conversation with the person (`conversationId`). `preview`, `unread` and `updatedAt` describe
that conversation for a list of agents: one line of its newest message, how many messages of the
agent the person has not read, and when it last changed. The home sends `agent.updated` when a
message arrives, when a reply is finished and when the conversation is read.

An agent's `color` (one of the cast's fills: cobalt, amber, moss, rose, ember, teal, violet,
magenta, citron, slate) is the colour its figure wears instead of its own; without it the figure
keeps its own. The main agent sets it with `agent_create` and `agent_update`.

`GET /v1/agents/:id` → `AgentDetail`: the agent, its `memory` (what it wrote down about the person
and their work), its `tasks` and, while it works, `doing`.

A `Task` is something the agent does by itself: `title` names it in a few words, `prompt` is
what the agent is told when it starts, `rule` says what starts it.
Tasks are set, changed and removed in the conversation. The scheduled ones come first, the next
one first, then the ones that wait for an event.

| `rule`                                            | Starts the task                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `{ at }`                                          | once, at that time                                                         |
| `{ every: "hour" }`                               | every hour                                                                 |
| `{ every: "day" \| "weekday", time }`             | every day or Monday to Friday, at `time` in the home's local time          |
| `{ every: "week", time, weekday }`                | every week; `weekday` 0 is Sunday                                          |
| `{ on: "folder", folder, path? }`                 | a file is added or changed in a connected folder, or in `path` inside it   |
| `{ on: "mail", from?, subject? }`                 | mail arrives in the agent's mailbox that is not from the person            |
| `{ on: "webhook" }`                               | another service posts to the task's own address                            |
| `{ on: "connection", connection, tool, minutes }` | a read-only tool of a connection answers differently than at the last look |

`nextAt` is set for a scheduled task. `quiet` says that the agent tells the person only when
something needs them. `paused` is why the home paused the task; a paused task does not run.
`lastAt` and `last` say when it ran last and how that ended: `answered`, `note` (a quiet run
with nothing to tell), `asked` (a card waits) or `failed`.

`doing` is `{ what, turn, turns }`: what the agent works on in one line ("" when it answers a
message), and which turn in a row of how many the home gives. The home sends `agent.updated`
when that changes; a device that shows the detail reads it again.

A quiet run with nothing to tell leaves a message with `role: "note"`: one line, no
notification, not counted in `unread`. While such a run works its message is a note already;
it becomes an `agent` message when it has an answer.

### A task's own address

`POST /hooks/<token>` with any body up to 64 KB → `202 { "accepted": true }`. No device token:
the address is the secret. The home shows it once, on a card, when the task is set. `202` says
the home has what was posted, not that the agent is done with it. `404` for an address that
does not exist, `413` for more than the home takes.

`GET /v1/conversations/:id/messages?before=<message id>&limit=50` →
`{ "messages": Message[], "more": boolean }`, oldest first.

`POST /v1/conversations/:id/messages` with `SendMessage` → `202 { "message": Message }` (the
stored message of the person). The agent's reply arrives on the event stream.

With `about: { "documentId", "quote" }` the person asks about a passage of a document of this
conversation (`400` for a document of another one). The stored message has a `document` part
first and the passage as a Markdown quote above the question; the agent is told which
document it is.

`POST /v1/conversations/:id/read` marks the conversation read.

A message written while the agent writes its reply goes into that reply: the agent reads it
before its next step. With `later: true` it waits instead, for after the answer: the stored
message has `queued: true`, and `message.updated` clears it when the agent starts on it. Without
a reply being written, `later` changes nothing.

`POST /v1/conversations/:id/stop` stops the reply that is being written, and what waits for after
it. The messages stay with the agent, which reads them with the next one; `queued` is cleared.

`POST /v1/conversations/:id/import` with `ImportMessages` → `{ "messages": Message[] }`. A phone
sends what it wrote with its own model while the home was out of reach. The `model` of such a
message is `apple:on-device`.

### A message

```json
{
  "id": "msg_…",
  "conversationId": "cnv_…",
  "role": "agent",
  "agentId": "agt_…",
  "channel": "app",
  "state": "done",
  "model": "ollama:qwen3.8:27b-mlx",
  "createdAt": "2026-11-21T09:12:00.000Z",
  "parts": [
    { "type": "activity", "label": "Reading your calendar", "state": "done" },
    { "type": "text", "text": "You are free after 14:00." },
    { "type": "document", "documentId": "doc_…", "title": "Week plan" },
    { "type": "artifact", "artifactId": "art_…", "title": "Spending by month" },
    {
      "type": "card",
      "card": {
        "id": "crd_…",
        "kind": "approval",
        "level": "needs_you",
        "state": "open",
        "title": "Send the invitation to Anna?",
        "body": "Thursday 15:00, 30 minutes.",
        "actions": [
          { "id": "yes", "label": "Send", "style": "primary" },
          { "id": "no", "label": "Don't send", "style": "plain" }
        ],
        "agentId": "agt_…",
        "conversationId": "cnv_…",
        "messageId": "msg_…",
        "createdAt": "…"
      }
    }
  ]
}
```

Rules for a device that draws messages:

- Draw parts in order. Text is Markdown.
- While a message is `streaming`, the home announces every new part with `message.updated` (a new
  text or reasoning part arrives empty) and then sends its text as `message.delta`.
- A `reasoning` part (`{ "type": "reasoning", "text" }`) is what the model thought before it
  answered, as far as it shows it, in Markdown. Draw it quiet, open while the message streams and
  folded away once it is done. It is not the answer: a voice, a notification and a channel read
  only the text parts.
- `source` parts (`{ "type": "source", "url", "title"? }`) are pages the answer draws on, named by
  the model itself. Draw them together, as links that open outside the app.
- A part type or card kind the device does not know is drawn as its `title` or skipped; it never
  breaks the message.
- A `document` part is a row that opens the document beside the chat (split screen on a wide
  screen, a sheet on a phone).
- An `artifact` part is a row that opens the artifact the same way.
- An answered card stays in the chat with its title and the chosen action.

## Search

`GET /v1/search?q=<words>` → `{ "hits": SearchHit[] }`: Wizards by name and about, the text of
messages in the person's own conversations, documents and artifacts by title and content, each
hit with its `kind`, its `id`, the Wizard it belongs to (`agentId`), a `title`, a `snippet` and
`at`. Fewer than two letters find nothing. A conversation someone else has with an agent (a
guest's, a caller's, a room's turn) is never searched.

## Cards and what needs you

A card is the inline UI of the chat. The device draws it from its data: `title`, `body`,
`fields`, `actions`, `url`, `qr`. A new kind of card needs no new app version.

| kind       | draws as                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval` | title, body, one button per action                                                                                                                                                                                                                                              |
| `question` | title, body, the fields, the actions                                                                                                                                                                                                                                            |
| `connect`  | title, body, a button that opens `url` in the system browser, and the card's own actions ("Not now"); the home answers the card itself when the sign-in is done (`answer.by` is then "sign-in"). The sign-in ends at `wizardsbot://signed-in`, where the app closes its browser |
| `secret`   | fields of type `secret` in a secure field; the values go to the home and are never shown again                                                                                                                                                                                  |
| `pairing`  | the QR from `qr` and the code in `body`                                                                                                                                                                                                                                         |
| `contact`  | title, body, the actions                                                                                                                                                                                                                                                        |
| `info`     | title and body; no actions                                                                                                                                                                                                                                                      |

`POST /v1/cards/:id/answer` with `{ "action": "<action id>", "values": { "<field id>": "…" } }`
→ `200 { "card": Card }`. The first answer wins: a second one gets
`409 { "error": "already_answered", "message": "…", "card": Card }` and the device shows the
card as answered.

`GET /v1/items` → `{ "items": Card[] }`: every open card with `level: "needs_you"`, oldest
first. This is the list of what needs the person. A device answers them in place with the same
route. `Agent.open` counts them per agent.

A field of type `folder` is a folder of the home's computer: the device shows its folder picker
(see Folders), never a bare text field, and sends the chosen folder's path as the value. With the
card's main action the home checks that it may connect that folder: 400 `invalid` or 404
`not_found` otherwise, and the card stays open.

A field may carry `value`: what it starts with. The device shows it typed or picked, and sends
it like a typed value unless the person changes it. A card of another kind than `connect` may
carry `url` as well: a page the person opens in the system browser ("Open page"), with the
card's actions beside it.

### Views in a card

A card may carry `view`: a view an agent wrote with `show_view` (key figures, a list, cards, a
form), in place of `fields`. `view.program` is OpenUI Lang, written for the components of
`view.library` (`engenty:core/1`, from engenty wizards' `@engenty/chatviews`). The home checks it
before the card is stored: what is shown is what was checked. The device draws it with that
library; a device that knows no such library shows `title` and `body`, which the home always
fills. A view never asks for passwords, card numbers or other secrets: those are `secret` cards.

A view that only shows is an `info` card. One with a form, or with a button that asks the agent,
is a `question` card and waits for the person. Its buttons answer it, not `actions` (which may be
empty):

`POST /v1/cards/:id/answer` with `{ "action": "view", "message": "<what the person says>",
"state": { "<field name>": <value> } }`. `message` is the button's or the form's send label,
`state` the form's values as the person left them (texts, numbers, yes/no, lists). The answer
reaches the agent as the person's message, and the first answer wins as for every card.

### What a connection asks

A connection is an account or app the home reaches over MCP (Streamable HTTP, with Mastra's
`MCPClient` from `@mastra/mcp`). The home speaks revision `2026-07-28` where the server has it
(it asks with `server/discover` first) and the older revisions, with their `initialize`
handshake, where it does not. It says it shows forms and pages (`elicitation: { form, url }`);
it gives no sampling and no roots.

A server may need the person while one of its tools runs. The home then puts a `question` card
into the conversation of the agent that used the tool, and the agent's turn ends, as with every
card. The title names the connection.

| The server asks with                | The card                                                                                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a form (`mode: "form"`, or no mode) | one field per property of `requestedSchema`: a string is `text`; a number or integer is `text` with a hint and is checked; a boolean is a `choice` of Yes and No; an enum is a `choice`, a list of enums a `multi`. `required` and `default` are kept |
| a page (`mode: "url"`)              | `url`, and in the body the page's host and the whole address. The home never fetches it                                                                                                                                                               |

The actions are `accept` ("Send", or "Go on" for a page), `decline` ("Don't") and `cancel`
("Not now"), and they reach the server under these names. For a page, "Go on" says the person
is done there; a server that still waits asks again with a new card.

What the home does not show: a form that asks for a password, a key, a token, a card number or
a code (MCP forbids these in a form; they belong on a page of the service), a field that is an
object or a list of anything but choices, more than 12 fields, a page that is not `https`
(except on the home's own computer) or carries a sign-in in its address, and a request for
sampling or roots. The tool then fails with the reason, and the person is asked nothing. The
server's words are shown as text: a link in them is not a link.

What the person types goes to that server and nowhere else. It is not stored with the card
(`answer.values` stays empty), not written into a message and not given to a model: the agent
hears that the person answered, said no or put it off, and then the tool's result. The result is
the server's: a server that repeats in it what was typed gives that to the agent.

The call stays open in the home while the card waits. Mastra's client answers a server's
question inside the call: for `2026-07-28` it gets `resultType: "input_required"` and calls
the tool again with `inputResponses` and the server's `requestState` as it came; for
`2025-11-25` and older the server sent `elicitation/create` as a request and gets its answer.
Either way the home waits 10 minutes with the server; most servers of the older kind wait 60
seconds. When the call is over before the answer, or the home starts again, the card is
`expired`, the agent is told, and nothing is sent. A server may ask again after an answer;
several questions at once are one card after another.

### A tool that asks

A tool of the home that needs the person asks with a card and stops (`call.ask` in
`agent/tool.ts`). It runs again, from the start, with the answer.

| The model is                                   | While the card waits                                                  | When the answer comes                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| stepped by the home (Ollama, a gateway)        | Mastra suspended the run at the tool call and keeps it in `mastra.db` | Mastra resumes the run: the tool's answer is the result of the same call, and the model goes on from there |
| a subscription's client, which steps by itself | the client was told to end its turn                                   | the home runs the tool again and tells the agent what it says, as a `[home]` message                       |

A message that arrives while a run is suspended ends that run, so the message is read at once.
The card stays open and is then answered the second way. A start of the home ends nothing:
Mastra kept the run and goes on with it when the answer comes. What the person typed travels beside Mastra to the tool: Mastra keeps the card's id, not
the answer. `ask`, `connection_call` and `folder_connect` ask this way; the other cards still start a new turn
through `home.onCard`.

## Documents

`GET /v1/documents/:id` → `Document`.

`PUT /v1/documents/:id` with `SaveDocument` → `Document`, or
`409 { "error": "version_conflict", "message": "…", "document": Document }` when the agent
wrote a newer version meanwhile.

`GET /v1/conversations/:id/documents` → `{ "documents": DocumentMeta[] }`.

### Marks

A mark is a passage the person marked in a document, with or without a comment. It is kept
by its text, as read without Markdown: the passage (`quote`) and up to 32 characters before
and after it, which tell which place is meant where the words repeat. A mark is drawn where
that text stands; when the text around it changed, at the first place with the same words;
not at all while the passage is gone. The agent sees the marks when it reads the document.

```json
{
  "id": "mrk_…",
  "documentId": "doc_…",
  "quote": "gloves",
  "before": "Hat, scarf, ",
  "after": "\nComfortable, waterproof shoes",
  "comment": "The warm ones",
  "createdAt": "2026-11-21T12:00:00.000Z"
}
```

`GET /v1/documents/:id/marks` → `{ "marks": DocumentMark[] }`, oldest first.

`POST /v1/documents/:id/marks` with `AddMark` (`quote`, `before`, `after`, `comment`, which is
`""` for a mark without one) → `201 DocumentMark`.

`DELETE /v1/documents/:id/marks/:mark` → `204`.

## Artifacts

An artifact is a page an agent wrote: a chart, a diagram, a 3D scene, a report on one page. It
is HTML with its own styles and scripts, at most 512 KB. It belongs to a conversation and has
versions like a document. Only an agent writes one; the person asks for a change in the chat.

`GET /v1/artifacts/:id` → `Artifact`.

```json
{
  "id": "art_…",
  "title": "Spending by month",
  "format": "html",
  "version": 2,
  "updatedAt": "…",
  "conversationId": "cnv_…",
  "content": "<main class=\"sheet\">…",
  "page": "/v1/artifacts/art_…/page?until=1795251881&key=…"
}
```

`GET /v1/conversations/:id/artifacts` → `{ "artifacts": ArtifactMeta[] }`, newest first.

The event `artifact.updated` carries the `ArtifactMeta` after each write. A device that shows
the artifact reads it again and shows the new `page`.

`GET <page>` → the page as HTML, ready to show and to print. `page` is a path on the home with
a key that opens this one artifact for an hour. The route takes no token: a frame and a tab
cannot send one, and the page must never be near one. Without a key that still works it answers
403 with a short page for the person; the device reads the artifact again for a new address.

### Showing an artifact

An agent wrote the page, maybe from something it read, so a device treats it as a stranger's
page. It never puts `content` into a page of its own: not as HTML, not as `srcdoc`, not as a
`blob:` address. It shows `page` in a frame:

```html
<iframe
  sandbox="allow-scripts allow-modals allow-same-origin"
  referrerpolicy="no-referrer"
  src="<base url><page>"
></iframe>
```

The origin of its own comes from the home: the page's policy carries `sandbox` without
`allow-same-origin`, and a browser applies the stricter of frame and policy. The frame adds its
own limits (no pop-ups, no forms, no leaving the frame) and leaves the origin to that policy,
because a frame that takes the origin away itself is refused its page by browsers that load
only for sites they know (the one in Claude's desktop app is one). After the frame loaded, the
device checks that it cannot reach into it; a page it can reach into did not come closed off
and is not shown. `allow-modals` is there for the print dialog.

What the home does to keep the page closed off:

- It serves the page with `Content-Security-Policy: sandbox allow-scripts allow-modals;
  default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src
  data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none';
  base-uri 'none'; frame-ancestors 'self'`, and writes the same policy into the page's head,
  before anything the agent wrote. `sandbox` holds in a tab as well: the page reads no storage
  and no cookie of the web app.
- The page can ask no address for anything: not the home's routes, not the network. Its
  libraries are part of the page (below), and no answer of the home carries
  `Access-Control-Allow-Origin`.
- It keeps no page that loads something from an address (a script from a CDN, a font, a
  picture): the agent reads why and writes the page again.

What the device adds: the policy of the page around the frame. A page's own policy cannot keep
it from sending its frame to another address. The web app's policy does (`default-src 'self'`
covers frames), so there the page cannot leave. In a tab of its own nothing does, so a tab is opened only when the
person asks for it.

A `srcdoc` frame would not work in any case: it takes over the policy of the page around it,
and the web app's policy allows no script written into a page.

### A connection's view (`format: "app"`)

When a tool of a connection answers with a view of its server (MCP Apps: `ui://…` in the tool's
or the result's `_meta.ui.resourceUri`), the home keeps the call as an artifact of
`format: "app"` with a `summary` (the result's text, for a watch or a notification) and puts it
into the message as an `artifact` part. Its `page` is the home's host:
`/v1/artifacts/:id/host?until=…&key=…`. A device frames it as it frames any artifact's page.

The host runs the MCP Apps bridge (`@modelcontextprotocol/ext-apps`) and frames the view,
`/v1/artifacts/:id/page` with the same key. The view is served with the policy its server
named (`_meta.ui.csp`): `sandbox allow-scripts allow-forms` without `allow-same-origin`,
`connect-src` only to its `connectDomains`, styles, fonts and pictures only from its
`resourceDomains`. The host reaches the home only with the artifact's key, answered with
`Access-Control-Allow-Origin: null`:

| Route                                                   | What                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/artifacts/:id/app/call`                        | `{ title, tool, input, result }`: the call as the view gets it                                                                                                                                                           |
| `POST /v1/artifacts/:id/app/tool` `{ name, arguments }` | a tool of the same connection, run without a card (the person pressed it in the view); a tool with `destructiveHint` asks with a card in the conversation and answers an error; one the person set to "never" is refused |
| `POST /v1/artifacts/:id/app/context` `{ text }`         | what the view tells the agent; kept with the artifact, `artifact_read` gives it                                                                                                                                          |
| `POST /v1/artifacts/:id/app/message` `{ text }`         | a message as the person, into the conversation                                                                                                                                                                           |

The host posts `{ "source": "wizards-app", "type": "open-link", "url" }` and `{ "source":
"wizards-app", "type": "size", "height" }` to the frame around it; on iOS the same to the
`app` script message handler.

### Libraries

A page uses D3 and three.js from the home's own dependencies, and the home puts them into the
page it serves: a page arrives in one piece and asks no address for anything, not a CDN and not
the home. So a page also works where a browser refuses requests from a closed-off page, and as
a file that was saved or sent.

| An agent writes                          | The served page holds                                               |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `<script src="/artifact-lib/d3.js">`     | D3 7 in that script tag, as the global `d3`                         |
| `import … from "three"`                  | three.js as a module of the import map                              |
| `import … from "three/addons/<path>.js"` | that addon, and the addons it imports, as modules of the import map |

A module of the import map has its own text as its address (`data:text/javascript,…`), which is
why the policy's `script-src` lists `data:`. The page is sent packed (`gzip`) to a browser that
takes that. `/artifact-lib/…` is a name in what the agent writes, not an address the home answers.

### Printing

The home adds the print layout to every page: A4 with 14 mm margins, colours kept, no chart
wider than the paper or cut in two, and nothing with the class `no-print`. The browser's own
print then makes the PDF. A device prints in one of two ways:

- It posts `{ "type": "artifact.print" }` to the frame (`frame.contentWindow.postMessage(…, "*")`).
  The page opens the print dialog for itself alone.
- It opens `page` in a tab, where the person prints as usual.

The page tells the frame around it when it could not show something:
`{ "source": "wizards-artifact", "type": "artifact.problem", "message": "A script on this page
stopped: …" }`. The same sentence stands at the foot of the page.

## Sharing

A document or an artifact leaves the home in two ways: published, as a link anyone can open, or
sent, as a copy in a contact's home. A device does both for the person directly. An agent has
tools for both (`link_publish`, `link_list`, `link_take_back`, `contact_send`); publishing and
sending ask the person first with a card, and the card for publishing takes the password in a
`secret` field.

### Published links

`POST /v1/links` with `Publish` → `PublishedLink`.

```json
{ "kind": "document", "id": "doc_…", "lasts": "week", "password": "optional, 4 characters or more" }
```

```json
{
  "id": "lnk_…",
  "kind": "document",
  "sourceId": "doc_…",
  "version": 3,
  "title": "Weekend in Kraków",
  "url": "https://me.example.com/p/Jq3…",
  "expiresAt": "2026-11-28T09:30:00.000Z",
  "password": false,
  "createdAt": "2026-11-21T09:30:00.000Z"
}
```

`lasts` is `hour`, `day`, `week`, `month` (30 days) or `always`; with `always` there is no
`expiresAt` and the link works until it is taken back. A password is stored hashed (scrypt) and
never given back.

`GET /v1/links?kind=<document|artifact>&id=<id>` → `PublishedLinks`: the links to that one thing
that still work, newest first, and `reach`.

`DELETE /v1/links/:id` takes a link back: `204`. From then on it opens nothing.

`GET /v1/documents/:id/page` → the newest version of a document as the HTML page a link shows,
for a device to keep as a file or to print as a PDF.

- **As published.** A link shows the `version` it was made for, also after the document or the
  artifact changed. A change leaves the home only with a new link, so nothing goes out that the
  person has not seen. A device marks a link whose `version` is behind the one it shows.
- **Looked up, not signed.** The link is a random token the home looks up each time it is
  opened. That is what lets a link be taken back before its time, also one with no end.
- **Reach.** `url` starts with the home's own address, and a link works as far as that address
  does. `reach` says how far: `internet`, `network` (a private network: only devices in it) or
  `computer` (this computer alone). A device says so where the link is made.

`GET <url>` → the page, for anyone who has the link. No token, no cookie.

| Answer | When                                                                                    |
| ------ | --------------------------------------------------------------------------------------- |
| 200    | the document as plain HTML, or the artifact's page                                      |
| 401    | the link has a password: a short page with a form, which says nothing about the content |
| 404    | the address was never a link; the same page for every such address                      |
| 410    | the link's time is over, it was taken back, or what it showed is gone from the home     |
| 429    | five wrong passwords in ten minutes: the link listens again after that                  |

The form sends the password with `POST <url>` (`password` in a form body); the answer is the
page itself. Nothing is kept in the browser, so the next look asks again.

Every answer carries `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: private,
no-store` and `Referrer-Policy: no-referrer`. A document is rendered on the home from its
Markdown: HTML written into the text is shown as text, a link leads to `http`, `https` or
`mailto` or stays text, a picture is shown only when it is a `data:` address in the text. Its
policy is `sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'`, one style
sheet by its hash and `img-src data:`: no script, nothing loaded from an address. An artifact
is served with the policy of its page (see "Showing an artifact"): `sandbox allow-scripts
allow-modals`, no address to ask, and `frame-ancestors 'none'`.

### Sending to a contact

`GET /v1/contacts` → `{ "contacts": Contact[] }`: the connected contacts.

`POST /v1/send` with `SendToContact` → `{ "contact": Contact }`.

```json
{ "kind": "artifact", "id": "art_…", "handle": "ben@ben.example.com" }
```

The home sends a signed `POST /peers/send` with `{ kind, title, content }` to the contact's
home. That home takes it only from a connected contact (401 otherwise), keeps it as a new
document or artifact in the conversation of its main agent and adds a message there: one line
saying whom it is from, and the `document` or `artifact` part. It is a copy: later changes do
not reach it. A page the receiving home would not keep as an artifact answers 400; more than 20
copies an hour from one contact answer 429. `POST /v1/send` answers 400 `not_contact` for a
handle that is no connected contact and 502 `not_sent` when the other home is out of reach or
refused.

A device also hands a document out as a file (its Markdown) through the share sheet of its
system, an artifact as the HTML it reads from `page` (the page is complete in itself), and a
link the same way.

## Rooms

A room is a conversation of several people and agents, from one home or several. A device
needs nothing new for it: a room stands among the agents as an `Agent` with `origin: "room"`,
its `from` the handle of the home that keeps it, its `about` the names of who is in it
("Ada, Ben · Travel"). Its conversation is read and written like any other
(`GET` and `POST /v1/conversations/:id/messages`); what the person writes there goes to
everyone in the room, and no agent of the home answers it. A message someone else wrote has
`role: "agent"` and `from`:

```json
{
  "id": "msg_…",
  "conversationId": "cnv_…",
  "role": "agent",
  "agentId": "agt_…",
  "channel": "home",
  "from": { "name": "Recipes", "kind": "flame", "of": "Ben" },
  "parts": [{ "type": "text", "text": "A tasca on the hill." }],
  "state": "done",
  "createdAt": "2026-11-22T12:00:00.000Z"
}
```

`from.kind` is set when an agent wrote it, and `from.of` then names whose agent it is. A line
of the room itself ("Ben joined the room.") is a `note`. Files and pictures are not sent to a
room yet: its messages are text, 20 000 characters at most.

A room is opened, an agent added and a contact invited in the conversation with the main agent
(`room_open`, `room_add`, `room_invite`, `room_list`); adding and inviting ask with a card.
Removing a room from the list leaves it; the home that keeps it closes it for everyone.

### Between homes

One home keeps a room: it gives every message its number (`seq`, from 1), knows the members
and says which agent answers next. All requests are signed as between contacts, and only a
connected contact is heard.

| Route, to the home that keeps the room | From            | Does                                                                                             |
| -------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `POST /peers/rooms/join`               | an invited home | takes the home's person into the room; answers the name, the members and the last 200 messages   |
| `POST /peers/rooms/say`                | a member's home | `{ room, id, as, text }`: `as` is one of that home's members. Answers `{ said }` with the number |
| `POST /peers/rooms/since`              | a member's home | `{ room, after }`: up to 200 messages after that number, and the members                         |
| `POST /peers/rooms/agent`              | a member's home | `{ room, agent: { id, name, kind } }` adds one of its agents, `{ room, remove }` takes one out   |
| `POST /peers/rooms/leave`              | a member's home | takes that home's person and agents out                                                          |

| Route, from the home that keeps the room | Does                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST /peers/rooms/invite`               | `{ room: { id, name }, members }`: a card for the person, who joins or does not                                                     |
| `POST /peers/rooms/told`                 | `{ room, messages, members }` in the order of their numbers; `closed: true` when the room is over. A gap makes the home ask `since` |
| `POST /peers/rooms/floor`                | `{ room, agent }`: it is this agent's turn. Its home runs it and sends the answer with `say`; no text means it passes               |

A request between homes is signed after RFC 9421 with a `nonce` of its own in the signature's
parameters. A home hears each signed request once: the same one sent again within the five
minutes its time counts answers 401.

`POST /peers/unshare` with `{ "agent": "<id>" }` ends one share, from either side: sent by the
home an agent lives in, the agent goes from the other's list; sent by the other home, that
home is no longer answered by the agent. The answer is the same whether there was such a share.

### The person's record

A person is more than the home they use. Their **record** names their key and the homes that
speak for them. The key (Ed25519) is made on a device and stays there; a home keeps only the
signed versions of the record and shows them to other homes.

A version is `{ "payload": "<text>", "sig": "<base64url>" }`. The text is JSON and is checked
and kept exactly as it was signed:

```json
{
  "v": 1,
  "id": "753e…",
  "seq": 1795347770000,
  "name": "Ada",
  "handle": "ada@me.example.com",
  "key": "<person's public key>",
  "homes": [{ "url": "https://me.example.com", "key": "<home's public key>", "receives": true }],
  "at": "…"
}
```

`id` is fixed when the first key is made: the first 40 hex digits of the SHA-256 of
`wizards.bot person <first key>`. `seq` is the time the version was made, in milliseconds, and
only grows. The first version is signed with its own `key`; every later one with the key of
the version before, so a new key is named by the old one.

For a paired device:

| Route                     | Does                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/person`          | `PersonState`: `record`, the version that counts, and `proposed` `{ payload, why }` when the home asks for a new one (the name, the handle or this home's address changed) |
| `POST /v1/person/start`   | `{ key }`, the public key the device holds → `{ payload }`: the text to sign. 409 when the home has the record with another key, or nothing is to sign                     |
| `POST /v1/person/records` | `{ payload, sig }` → `PersonState`. 400 when it is not signed with the key in force, is not newer, is another person's or does not name this home                          |

The main agent's tool `person_key` shows a card with `url: "wizardsbot://person"` and no
buttons: a device that can keep a key draws its own controls there (make the key and show the
recovery code once, bring a key back from its code, sign). The card is answered when a version
was handed in. The recovery code is the key's 32 bytes and one check byte in Crockford base32,
in groups of four.

A home shows its person's versions in `GET /.well-known/wizards.json` as `person.log`. Another
home remembers, with a contact, the person's `id`, `key` and `seq`. It takes the record the
first time only from the home it already knows, and later versions only when they are signed
with the key it remembers. A request signed with a home key it does not know is heard when the
record at the contact's address, read anew, names that key in such a version; the contact's
key is then the new one. A record is read again at most once an hour.

### What someone else writes to an agent

A contact an agent is shared with, a caller and a room an agent answers each have a
conversation of their own with that agent, kept in the agent's home. It is theirs: the home
tells no device of what is written in it (no `message.created`, `message.updated` or
`message.delta`), and every route under `/v1/conversations/<its id>/` answers 404
`not_found`, as for a conversation that is not there. When a share ends, from either side or
because the contact is removed, the conversations of that contact with the agent are deleted
with what Mastra kept of them. The cards on both sides say so: the other person is told that
the conversation is kept in a home someone else runs, the agent's person that it is not shown
to them.

### What an agent remembers, and its guests

What an agent remembers is its person's. A contact the agent is shared with hears of it only
when the person said so: `agent_share` and `invite_make` take `memory`, `none` (the default)
or `all`, the card says which, and `agent_share` called again changes it. A caller hears
nothing of it. In a room the agent brings what it remembers: adding it to the room is the yes
to that.

An agent keeps nothing from a guest's conversation by itself. In a contact's conversation it
has one tool, `remember_suggest` with one sentence of 300 characters at most: the sentence
becomes a card in the agent's own conversation with its person, who keeps it (it is added to
what the agent remembers) or drops it. Five such cards wait at most. Nothing else of what the
contact wrote is shown. A caller's conversation has no tool at all.

### Handles

A person's handle is `name@domain`. The domain answers for it at
`GET https://<domain>/.well-known/wizards.json?name=<name>` in one of two ways:

- as the home itself, with its card `{ protocol, handle, name, publicKey, person? }`. That is
  so when the home runs at the domain;
- as a site that is no home, with the address of the home for each name:
  `{ "names": { "ada": "https://me.example.com" } }`. The home is then asked for its card at
  `<address>/.well-known/wizards.json`.

Either way the home found must name the handle as its own: the domain and the home name each
other. A home on the internet follows no address that is private, and no redirect at the home.

The person sets a handle on a domain of their own with the main agent's `handle_set`. The home
checks that the domain names it; when it does not, the agent says which file to put there.
The handle then waits for a version of the person's record that names it, and counts from
the moment that version is signed: the home answers to it, and its places in rooms go under it.

A home that remembers a contact's person follows the record:

- a request signed under a handle it does not know is looked up; when the record there is of
  a person it remembers, signed onward from the key it remembers, and names that handle, the
  contact is known under the new handle from then on, with everything kept about them;
- a contact that does not answer, or answers 401, is looked for once more: where the handle
  leads, or at the home's last address, whose new handle must lead back to it. A new address
  counts only when a signed version names it, not on the domain's word alone.

### A home without an address

A home on a laptop has no address others reach (`WIZARDS_BOT_URL` is not set): it calls other
homes, and none calls it. It takes part once its person has a key:

- **Its handle** is `name@k-<first 20 hex digits of the person's id>`. It leads nowhere and
  is never looked up; nobody else can make it theirs, because the id comes from the key.
- **Its card travels with its requests**, in the header `wizards-card` (base64url of the
  card's JSON, with `person.log`). A home that does not know it yet checks the card by itself:
  the record holds, names the handle and the home's key, and the handle is made from the
  record's id. A contact's new home key is taken the same way, from a version signed with
  the key remembered.
- **What others tell it is kept for it.** A request to a contact whose home has no address
  is not sent: it is kept, for a week and 1 000 at most, and answered `202 { "state": "kept" }`.
- **It asks for what is kept**: `POST /peers/mailbox` with `{ after, wait }`, signed, at each
  contact's home that has an address. `after` is the id of the last request it got: everything
  up to it is dropped there. `wait` (25 seconds at most) holds the request until something is
  kept. The answer is `{ items: [{ id, path, headers, body }] }`, 50 at most, each signed
  for it at that moment; it hears each as a request that arrived by itself. Only a contact
  gets what is kept for it.

Such a home joins by invite, writes in rooms, and its agents answer rooms. It makes no invites
and keeps no room for other people, and an agent in it cannot be talked to from another home.
Two homes without an address do not reach each other.

### Invites

An invite is a link that works once: `<home>/i/<code>#k=<print>`, shown on a card with its QR
code. `print` is the first 16 hex digits of the SHA-256 of the home's public key; the part
after `#` never reaches a server. It is made, listed and taken back in the conversation with
the main agent (`invite_make`, `invite_list`, `invite_take_back`), for one of three things:
to connect, to talk to one agent, or to join one room the home keeps. The person who gets the
link gives it to their own agent (`invite_open`), which shows a card and joins on a yes. A
device that scanned the code or was handed the link asks its home to open it:
`POST /v1/invites/open { link }` answers `{ opened: true }` when the same card now stands in
the main agent's conversation, and `{ opened: false, message }` with the reason when not. No
turn of the agent runs for it.

| Route                       | Signed | Does                                                                                                                                                                                                                                                       |
| --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /i/:code`              | no     | a page for a person who opened the link in a browser: who invites to what, to give the link to their agent, and a link that hands it to the app on a phone (`wizardsbot://invite?link=<the link>`). 404 for a link that opens nothing, 410 when it is over |
| `GET /peers/invite/:code`   | no     | `{ protocol, handle, name, publicKey, what, title, about?, expiresAt }`; `what` is `connect`, `agent` or `room`. 404 and 410 as above                                                                                                                      |
| `POST /peers/invite/accept` | yes    | `{ code }` from the home that uses it, looked up at its handle when it is no contact yet. Answers `{ what, agent? }` or `{ what, room: { id, joined } }`                                                                                                   |

The home that opens a link refuses it when the handle the other home names is not at the
link's address, or when the key it shows does not match the print in the link. Using an invite
to connect makes both homes contacts. Using one to an agent or a room makes them contacts for
that only: such a contact is heard about what it joined, sends no documents and offers no
agents, and is not among the contacts of `GET /v1/contacts`. It becomes a contact like any
other when one side asks to connect and the other says yes. A code is used up by the first
home that sends it, also when what it was for is gone by then.

A member is `{ id, kind, handle, name, agentKind?, role }`: a person's `id` is their handle,
an agent's is `<handle>/<agent id>`. An agent writes only when it is its turn (409 otherwise):
after a person's message the agents it names with `@name` answer one after the other, each
may name another, and after eight messages of agents the room waits for a person. An agent
that does not answer within three minutes is passed over. A room takes six agents at most. A
home that is not in a room gets 403 or 404 on every route, and `told` and `floor` are taken
from the room's own home only.

## Agents outside the home

A home talks to agents that are not wizards.bot homes in [A2A](https://a2a-protocol.org), the
protocol a shared agent already answers a contact's home in. Both directions are Mastra's:
asking another agent is its `A2AAgent` (`@mastra/core/a2a`), answering one is its A2A handler
(`@mastra/server`), each in A2A 1.0 and 0.3. The home adds who may call, the sign-in, the
addresses it may call and the conversation a message belongs to. A device needs nothing new for it:
everything is set up in the conversation, with cards. An outside agent is an `Agent` with
`origin: "shared"`; its `from` is the host of its agent card, where a contact's shared agent has
a handle.

### Adding an outside agent

The person gives the main agent the address of an agent card (`…/agent-card.json`), or of the
agent's site, where the card is at `/.well-known/agent-card.json`. The card is read as A2A 1.0
and, when it is not that, as 0.3. The tool `outside_agent_add` reads the card and puts
a card into the chat that says who the agent is (its name, its host, who runs it, what it says
it can do) and where messages to it go. The agent is added when the person says yes; what was
shown on the card is what is kept.

| The card asks for                                                 | The home                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| nothing (no `securityRequirements`; in 0.3 no `security`)         | asks with an `approval` card                                                                        |
| `httpAuthSecurityScheme` with `scheme: "Bearer"`                  | asks with a `secret` card that has one field; sends `Authorization: Bearer <token>`                 |
| `apiKeySecurityScheme` in `header`, `query` or `cookie`           | asks with a `secret` card that has one field; sends the key under the name the card gives           |
| OAuth, OpenID Connect, a client certificate, two schemes together | does not add the agent and says why. A card that lists several ways is added by the first one above |

A 0.3 card says the same the way OpenAPI does (`type: "http"`, `type: "apiKey"`).

The token or key goes from the card's field into the home's secrets and from there into the
request. It is in no message, no tool result and no prompt, and it is deleted with the agent.
It is sent only to the address the person saw on the card: when the agent's card later names
another one, the home sends nothing and says so.

Addresses: `https` only, and no address with a password in it. A private address (this
computer, a private network) is called only by a home that is private itself. The home follows
no redirect, neither for the card nor with a token.

The person writes to an outside agent in its chat. To an agent whose card offers streaming the
message goes with `SendStreamingMessage`, and the answer appears in the chat as it is written;
to any other with `SendMessage`. A 1.0 agent gets the header `A2A-Version: 1.0`, at the card's
`JSONRPC` interface of version 1.0, with that interface's `tenant` when it has one. A 0.3 agent
gets `message/stream` or `message/send` at the card's `url`. The `contextId` is the home's
addition: Mastra's client starts every message anew, and a chat is one conversation.

```json
{
  "jsonrpc": "2.0",
  "id": "…",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "…",
      "role": "ROLE_USER",
      "parts": [{ "text": "A table for two on Friday" }],
      "contextId": "<what the agent named in its first answer>"
    }
  }
}
```

The answer is a `message` or a `task`. A task that is `TASK_STATE_SUBMITTED` or
`TASK_STATE_WORKING` is asked for again with `GetTask` until it ended; the home waits six
minutes for an answer at most. A finished task
answers with the text of its artifacts, or of its status message when it has none. A task in
`TASK_STATE_INPUT_REQUIRED` answers with its status message, and the next message carries its
`taskId`. A failed, rejected or canceled task, an error and a refused sign-in (401, 403) end
the reply as `failed`, with a sentence for the person. The `model` of a reply is `shared:<host>`.

Another agent hands an outside agent a task with `agent_message`. That asks the person first:
a card shows the text and where it goes, and the text is sent as written. The same holds for an
agent a contact shared. The answer comes back marked as written outside the home.

### Letting a caller in

A caller is an outside agent the person lets write to one of their own agents: "let the booking
agent of Hotel Lux talk to Travel". The tool `outside_agent_let_in` asks with a card. After a
yes, the home makes an access token and shows it once, on a card with the address of the
agent's card. The home keeps the token's hash; when the person presses "I copied it", the token
leaves the card. `outside_list` lists the callers, `outside_shut_out` ends one: its token stops
working at once. The main agent is never opened to a caller, and the home needs a public
address.

`GET /a2a/agents/:id/agent-card.json` → the agent's card, without a token. 404 unless the agent
is shared with a contact to talk to, or has a caller. With the header `A2A-Version: 1.0` it is
the card of A2A 1.0, below; without it the card of 0.3 (`url`, `protocolVersion: "0.3.0"`,
`security`), as Mastra's own agents hand theirs out. The card says the agent's name and what it
is for. It never says its instructions.

```json
{
  "name": "Travel",
  "description": "Plans your trips.",
  "version": "1",
  "supportedInterfaces": [
    {
      "url": "https://me.example.com/a2a/agents/agt_…",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    },
    {
      "url": "https://me.example.com/a2a/agents/agt_…",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "0.3"
    }
  ],
  "capabilities": { "streaming": true, "pushNotifications": false, "extendedAgentCard": false },
  "securitySchemes": {
    "token": { "httpAuthSecurityScheme": { "scheme": "Bearer", "description": "…" } }
  },
  "securityRequirements": [{ "schemes": { "token": { "list": [] } } }],
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [{ "id": "talk", "name": "Travel", "description": "Plans your trips.", "tags": [] }]
}
```

`POST /a2a/agents/:id` takes JSON-RPC from two kinds of senders: a caller with
`Authorization: Bearer <access token>`, and a connected contact's home with its signature
(RFC 9421, Ed25519; the card does not name that scheme, a home learns it from the share).

- No token, a wrong or ended one, a signature of a home that is no connected contact: 401
  `{ "error": "refused", "message": "…" }` with `WWW-Authenticate: Bearer`.
- A sender the home knows, at an agent that is not its own: 403, the same for an agent that
  does not exist.
- Everything else is answered by Mastra's handler, in the version the request names with
  `A2A-Version` (none: 0.3, where the methods are `message/send`, `message/stream`,
  `tasks/get`, `tasks/cancel`, `tasks/resubscribe`).
- `SendMessage` with text → `{ "result": { "task": { "id", "contextId", "status": { "state":
  "TASK_STATE_COMPLETED" }, "artifacts": [{ "parts": [{ "text" }] }] } } }`, when the agent's
  reply is finished; with `returnImmediately` at once, and `GetTask` asks for the task.
- `SendStreamingMessage` → the task, the text in pieces as the agent writes it
  (`artifactUpdate`), and its end (`statusUpdate`), as server-sent events.
- The home takes text only (-32005 for anything else) and sends no notifications (-32003).

Each sender has one conversation of its own with the agent; its id is the `contextId` of every
task, whatever `contextId` the sender names. The agent answers there from its instructions
and its memory, without tools, and is told that an agent from outside is writing. The person's
own conversation with the agent is another one. A sender's tasks are its own as well: it asks
for, lists and stops only those. Mastra keeps tasks in memory: they are gone when the home
starts again, and after 200 a sender's list starts anew.

### What of A2A the home does

| Part                                                      | Asking an outside agent (Mastra's `A2AAgent`)                                                | Answering a caller (Mastra's A2A handler)                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Agent card                                                | read from the address given or the well-known one                                            | one per agent at `/a2a/agents/:id/agent-card.json`, written by the home; none at the well-known one |
| Card signatures, extended card                            | not checked, not asked for                                                                   | none; `GetExtendedAgentCard` answers -32007                                                         |
| Binding                                                   | JSON-RPC; not gRPC, not HTTP+JSON                                                            | JSON-RPC                                                                                            |
| Version                                                   | 1.0, and 0.3 when the card is that                                                           | 1.0 and 0.3, by `A2A-Version`; a missing one is 0.3, another one answers -32009                     |
| `SendMessage`                                             | yes, to an agent that does not stream                                                        | yes; answers with a task                                                                            |
| Tasks: `GetTask`, `ListTasks`, `CancelTask`               | `GetTask` while a task is worked on; never cancels, never lists                              | yes, a sender's own tasks; kept in memory only                                                      |
| Streaming: `SendStreamingMessage`, `SubscribeToTask`      | `SendStreamingMessage` when the card offers streaming; `SubscribeToTask` is not used         | yes                                                                                                 |
| Push notifications                                        | not used                                                                                     | -32003: the home calls no address a caller names                                                    |
| Parts                                                     | text; when an answer has no text, `data` is shown as JSON, a file by its address or its name | text; a message with anything else answers -32005                                                   |
| Sign-in                                                   | none, bearer token, API key                                                                  | bearer token, or a home's signature                                                                 |
| OAuth 2, OpenID Connect, mTLS, `TASK_STATE_AUTH_REQUIRED` | not yet: the agent is not added, the task ends as failed                                     | not offered                                                                                         |
| Extensions, `tenant`                                      | no extensions; `tenant` of the interface is sent                                             | none                                                                                                |

## Files

A person attaches files to a message: pictures, a photo from the camera, documents. A device
uploads each file first and then names the ids in the message.

`POST /v1/files` with `multipart/form-data`, one field `file` → `FileRef`. At most 15 MB. The
home checks that the bytes are what the name and type say, and stores the type it found. A
picture browsers do not show (HEIC, AVIF from a phone) is kept as a JPEG, its longest side at
most 3024 pixels, when the home's computer can make one (`sips` on a Mac, ImageMagick elsewhere):
the `FileRef` then names the JPEG (`IMG_7159.jpg`, `image/jpeg`).
15 MB means 15 × 1024 × 1024 bytes. Errors, each with a sentence for the person: 413 `too_large`,
415 `not_its_type` (the bytes are not what the name says), 415 `empty`, 400 `invalid` (no field
`file`).

```json
{ "id": "fil_…", "name": "ticket.jpg", "mime": "image/jpeg", "size": 482113 }
```

`DELETE /v1/files/:id` removes a file that was uploaded and not sent.

`GET /v1/files/:id` → the bytes, with their `content-type`. It needs the device token like every
route, so a web page loads it with `fetch` and shows the blob.

`POST /v1/conversations/:id/messages` takes `files`: up to 10 ids. `text` may then be empty. The
stored message has one `file` part per file, before its text:

```json
{
  "type": "file",
  "file": { "id": "fil_…", "name": "ticket.jpg", "mime": "image/jpeg", "size": 482113 }
}
```

A device draws a `file` part as the picture (png, jpeg, webp, gif) or as a row with the file's
name. What the agent gets: a picture as a picture, a text file as its text, a Word, Excel or
PowerPoint file or a PDF as the text read from it, any other file by its name.

An agent's message carries `file` parts too: a Word, Excel or PowerPoint file the agent made.
A device draws it the same way, and the person saves it from `GET /v1/files/:id`.

## Secrets

`GET /v1/secrets` → `{ "secrets": SecretEntry[] }`: the keys, tokens and passwords the person
gave the home, for the settings. Each names what uses it (`kind`: `gateway`, `account`,
`connection`, `channel` or `outside`, and its `label`) and when it was set (`setAt`). A value
never leaves the home, here or anywhere else; the home's own secrets are not listed. A secret is
set, replaced and removed in the conversation, through a card's `secret` field and the main
agent's tools.

```json
{
  "name": "connection.con_….key",
  "kind": "connection",
  "label": "linear",
  "setAt": "2026-11-22T20:00:00.000Z"
}
```

## Vault

The person's passwords (website logins, with an authenticator key when they have one), payment
cards and notes, sealed on the home. A device lists them without their secrets and shows one
only when the person asks; every showing, change and use is in the activity.

`GET /v1/vault` → `VaultView` (`items`, `activity`). `POST /v1/vault` with `VaultInput` (`kind`
`login`, `card` or `note`) → `VaultItem`. `PUT /v1/vault/:id` with `VaultInput` changes it; an
empty secret field keeps what is kept. `DELETE /v1/vault/:id` deletes it. `POST
/v1/vault/:id/reveal` → `VaultSecret`: the password and the authenticator's current code (never
its key), the card's number and code, the note's text. `POST /v1/vault/import` with `{ "csv":
"…" }`, the text of a CSV export of Chrome, 1Password, Bitwarden or another password manager →
`VaultImported`. A website is kept as its origin; a password fits pages of that origin and of its
`www` or root twin. The event `vault.updated` carries the `VaultView` after each change.

An agent signs in with `vault_sign_in` on the page open in its browser: the person says yes on a
card, then the home enters the user name and the password into the fields the agent named,
only when the page and each field are on the password's website. `vault_code` enters the
authenticator's code the same way, for the password just used.

## Plugins

A plugin is a folder in the home's plugins folder (`<data folder>/plugins`) that brings skills
and tools. It is off until the person switches it on (docs/plugins.md).

`GET /v1/plugins` → `PluginsView`: the folder, each plugin with `on`, `state` (`off`,
`starting`, `ready`, `failed` with `problem`), its skills and its tools (`readOnly` false: the
person is asked before each use), and what looked like a plugin and is none. The home looks into
the folder again on every request.

`PATCH /v1/plugins/:id` with `{ "on": boolean }` → `PluginsView`, once the plugin's tools are
ready or failed. 404 `not_found` for a plugin that is not in the folder.

```json
{
  "id": "weather",
  "name": "Weather",
  "version": "0.1.0",
  "on": true,
  "state": "ready",
  "skills": [{ "name": "forecast", "description": "Reads the weather for a place and a day." }],
  "tools": [
    { "name": "weather_forecast", "description": "The forecast for a place.", "readOnly": true }
  ]
}
```

## Folders

A folder of the home's computer can be connected, so that agents read its files, and change
them when the person allows it. The files stay where they are. The home reads the disk; a device
only says which folder.

`GET /v1/folders` → `{ "folders": Folder[] }`.

A device never asks the person to type a path first. It offers a folder picker:

| Where the person is                                     | The picker                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| the Mac app, with the home on the same Mac              | the Mac's own folder panel (`NSOpenPanel`, folders only, a new folder allowed), through the app's bridge                    |
| a browser, the Mac app with a home elsewhere, the phone | the home's folder browser below: the person's home folder and disks, one level at a time, with breadcrumbs and a new folder |

Typing the path stays possible as a second way where a device offers it.

`GET /v1/folders/browse?path=<path>` → `FolderListing`: the folders inside `path`, for the folder
browser. Without `path` it starts at the person's home folder (`home`); `~` stands for it, and a
relative path is read from it. A path whose last part is not a folder yet (a half-typed name)
lists its parent. Only the home folder, the person's other disks (`disks`: `/Volumes/*` on a
Mac, `/media/<user>/*` and `/mnt/*` on Linux) and what is in them is shown, only folders (no
files and nothing of what they hold), nothing hidden, and no link that leads out: anything else
is 400 `invalid`; 404 `not_found` when there is no such folder. `root` is the home folder or
the disk the folder is in, the first of its breadcrumbs; `parent` is null there.

A home on a server (`WIZARDS_BOT_FILES`, `/files` in the Docker image) has one folder of files:
it is `home`, the agents' own folder from the start, connected for changes, and there are no
disks. Folders are picked, made and connected inside it only.

```json
{
  "path": "/Users/ada/Documents",
  "parent": "/Users/ada",
  "home": "/Users/ada",
  "root": "/Users/ada",
  "disks": [{ "name": "Archiv", "path": "/Volumes/Archiv" }],
  "folders": [{ "name": "Trips", "path": "/Users/ada/Documents/Trips" }]
}
```

`POST /v1/folders/new` with `{ "parent": "…", "name": "Gesetze" }` → the `FolderListing` of the
new folder. The same bounds as above; a name that starts with a dot, holds `/`, `\` or `:`, or is
taken already is 400 `invalid`.

`POST /v1/folders/preview` with `{ "path": "…" }` → `FolderPreview`. 404 `not_found` when there
is no such folder; 400 `invalid` for a folder that cannot be connected (the whole disk, a folder
of the system or its apps with everything in it, such as `/etc`, `/private` or `~/Library`, the
whole home folder, the home's data folder, a hidden folder). A device shows it under the chosen
folder.

`POST /v1/folders` with `ConnectFolder` (`path`, `access`, and `conversationId` when it is
connected from a chat: that chat's agent is told and answers there) → `Folder`. With
`own: true` it becomes the agents' own folder (`Folder.own`), connected for changes whatever
`access` says. A folder that is not there yet is made first, inside the person's home folder
only (400 `invalid` elsewhere). There is one own folder at most: another one takes the mark,
and the one before stays connected as it was. Disconnecting it leaves the agents without one. `PATCH /v1/folders/:id` with
`{ "access"?: "read" | "write", "allow"?: "ask" | "always" }` (`UpdateFolder`) → `Folder`. `DELETE /v1/folders/:id` disconnects it; nothing on
the disk changes.

```json
{
  "id": "fld_…",
  "name": "Trips",
  "path": "/Users/ada/Documents/Trips",
  "access": "read",
  "allow": "ask",
  "own": false,
  "createdAt": "…"
}
```

The event `folders.updated` carries the whole list after each change.

The agents' own folder is where they put what they make for the person, unless the person
names another place: `folder_write` without a folder writes there, after the person said yes
to that change as in every connected folder.

### An agent changes files

In a folder connected for changes an agent makes folders (`folder_make`), writes a text or a
file of the conversation (`folder_write`), changes a passage (`folder_edit`) and copies
(`folder_copy`), and moves, renames (`folder_move`) or deletes (`folder_delete`) up to 200
files and folders in one call. Each change is an `approval` card with the agent's sentence as its title, what
changes in the body (a file's text, a diff), and the actions `once` (primary), `always` ("Always
allow in <folder>") and `deny`. `always` does the change and sets the folder's `allow` to
`always`: from then on these changes go without a card, at most 50 files and 500 MB in one turn.
Deleting is always a card, also under `always`, with the actions `once` (style `danger`, "Move
to the Trash") and `deny`. A turn that read data from outside the home (a mail, a page, what a connection or a contact
sent) asks anyway. A task that an event started (mail, a webhook, a connection, a folder)
changes no files at all. What a change replaces goes to the Trash first: the Mac's Trash, the
freedesktop Trash on Linux, on a server a `trash` folder in the data folder kept 30 days. No
agent writes a program, a file larger than 10 MB, a file with a second name elsewhere, or
anything when the disk would keep less than 1 GB.

### The file browser

What a connected folder holds, its files and what was done in it. The routes reach exactly what
the agents reach (nothing hidden, no file with keys or passwords by its name, no link), through
the same checks; 400 `invalid` otherwise, 404 `not_found` for what is not there.

- `GET /v1/folders/:id/entries?path=<path>` → `FolderEntries`: folders first, then files, each
  with its path inside the folder, its size and when it changed; at most 500 (`more`).
- `GET /v1/folders/:id/file?path=<path>` → the file's bytes, its type read from them. A picture,
  a PDF or text is `inline`, anything else (and every file with `&download`) an `attachment`; it
  never runs as a page (`content-security-policy: sandbox`, `nosniff`).
- `GET /v1/folders/:id/activity` → `{ "activity": FolderActivity[] }`, newest first, kept 90
  days: one row per turn of an agent (its name, how many files it read, each change) or per
  thing the person did here. The event `folder.activity` with the folder's id says it grew.
- `POST /v1/folders/:id/undo` with `{ "activityId", "index" }` (`UndoFolderChange`) takes one
  change back: a new file, folder or copy goes to the Trash, a replaced or deleted one comes back
  from it, a moved one goes back where it was → the new activity. 400 when it was taken back
  already or the files are not where the change left them.
- In a folder connected for changes the person also changes things themself, without a card:
  `PUT /v1/folders/:id/file?path=<path>` with the bytes drops a file in (a file there already goes
  to the Trash first; at most 200 MB) → the `FolderEntries` of its place; `POST
  /v1/folders/:id/edit` with `FolderEdit` makes a folder (`make`), moves or renames (`move`) or
  moves up to 200 paths to the Trash (`trash`) → 204. Both are noted in the activity without an
  agent.

```json
{
  "id": "fac_…",
  "folderId": "fld_…",
  "agentId": "agt_…",
  "agentName": "Goose",
  "conversationId": "cnv_…",
  "read": 3,
  "changes": [
    {
      "action": "move",
      "path": "2026/Q1/scan1.pdf",
      "fromFolder": "fld_…",
      "from": "scan1.pdf",
      "at": "…"
    },
    {
      "action": "replace",
      "path": "notes.md",
      "bytes": 812,
      "kept": true,
      "undone": true,
      "at": "…"
    }
  ],
  "at": "…"
}
```

### An agent asks for a folder

An agent that needs a folder asks with one card (`folder_connect`), never with a question for
the path. The card is a `question`: its title is the agent's one line of what the folder is for,
a field of type `folder`, the access as a `choice` set to what the agent asked, and the actions
`connect` and `keep`. The folder field carries `value` when the agent knows the path from the
person; the device then shows that folder chosen. Every agent of the person may ask; an agent
in a room or answering someone else has no folder tools.

An agent may propose a folder that is not there yet (`create: true` with its path, e.g.
`~/code/wizards/data`): the field's `value` is that path and its `placeholder` the line that the
Bot Server makes it, which a device shows under the chosen folder while it is the one chosen.
When the person connects that folder, the home makes it with the folders on the way, then
connects it; another folder the person picks instead must be there. The home makes no folder a
picker would not show or the home would not connect.

```json
{
  "kind": "question",
  "title": "Ein Ordner für die Gesetzestexte von Lex",
  "body": "Die Dateien bleiben, wo sie sind.",
  "fields": [
    { "id": "folder", "label": "Ordner", "type": "folder", "required": true },
    {
      "id": "access",
      "label": "Was dürfen deine Agenten darin?",
      "type": "choice",
      "required": true,
      "value": "write",
      "options": [
        { "id": "read", "label": "Nur lesen" },
        { "id": "write", "label": "Lesen und ändern, nach Rückfrage" }
      ]
    }
  ],
  "actions": [
    { "id": "connect", "label": "Verbinden", "style": "primary" },
    { "id": "keep", "label": "Nicht verbinden", "style": "plain" }
  ]
}
```

The pick and the yes are one answer: `{ "action": "connect", "values": { "folder": "/Users/ada/Gesetze", "access": "write" } }`
connects the folder, and no second card follows. A folder the home would not connect is 400
`invalid` (or 404 `not_found`), and the card stays open for another pick.

## Devices and what they keep

A device keeps its own data: the calendar, the reminders and the contacts of a phone, folders
connected on it (picked in the phone's Files dialog: iCloud Drive, On My iPhone or any other
provider) and services signed in on it (MCP servers whose token is in the phone's Keychain). That data stays on the device. The device's own agent (on a phone, Apple's
model on the phone) works on it, and the home's agents hand it questions and tasks. The home
knows only what a device offers, never what it holds. A home may run on a server: it never
reaches a device's data itself.

`PUT /v1/device/resources` with `DeviceResources` → `Device`. The device says what it offers,
after each change on it (a permission given or taken back, a folder connected or removed).
`kind` is `calendar`, `reminders`, `contacts`, `folder` or `connection`; `can` holds `read`, and `change`
where the device's agent may also change it, after the person said yes on the device.

```json
{
  "resources": [
    { "id": "calendar", "kind": "calendar", "name": "Calendar", "can": ["read", "change"] },
    { "id": "contacts", "kind": "contacts", "name": "Contacts", "can": ["read"] },
    { "id": "pf_3k9", "kind": "folder", "name": "Receipts", "can": ["read"] }
  ]
}
```

`agents` (optional) says which of the person's agents may hand this device questions, as the
person said on the device: `{ "allowed": ["agt_…"], "refused": ["agt_…"] }`. An agent the device
refused does not see the device; an agent in neither list may ask, and its first question asks
the person on the device.

`GET /v1/devices` → `{ "devices": Device[] }`: the person's devices, each with `resources` and
`agents` once it said what it offers. The event `devices.updated` carries the same list after a device said
what it offers.

### Hand-offs

An agent hands a question or a task to a device with its tool `device_ask`. Only the person's
own agents have that tool; an agent of a contact or an outside agent never reaches a device.
The device's agent works on what the device keeps and sends back only the answer: the findings,
never the calendar or the folder itself. Every change on the device asks the person there
first; so does a file that would leave the device. The first question of an agent asks the
person on the device whether that agent may ask it at all.

The tool ends the agent's turn. The answer starts the agent's next turn as a `[home]` message,
read as data from outside the home, never as an instruction, with the files the device sent.
A question for a device whose app is closed stays open until the app opens; the agent sees the
questions that still wait and says so.

A device whose event stream is closed and that has a push token is woken by a silent push
(`apns-push-type: background`) that names only the hand-off:
`{ "aps": { "content-available": 1 }, "handoff": "hnd_…" }`. The app loads it and answers in
the seconds the system gives it; what needs the person waits as a notification and is asked when
the app opens. Without a key on the home, the hand-off waits until the app opens.

`GET /v1/handoffs` → `{ "handoffs": Handoff[] }`: the open hand-offs of this device, oldest
first. A device loads them whenever its event stream opens. The event `handoff.updated` carries
a hand-off when it is made and when it is answered, and only to the device it is for.

```json
{
  "id": "hnd_…",
  "deviceId": "dev_…",
  "agentId": "agt_…",
  "agentName": "Goose",
  "conversationId": "cnv_…",
  "text": "What is in my calendar tomorrow morning?",
  "state": "open",
  "createdAt": "…"
}
```

`POST /v1/handoffs/:id/answer` with `{ "text": "…", "files": ["fil_…"], "declined": false }` →
`Handoff`. `files` are uploaded first with `POST /v1/files`, after the person said yes on the
device. `declined: true` when the person did not let the agent ask this device or said no to
the task; `text` then says why in one sentence. 404 `not_found` for a hand-off of another
device, 409 `already_answered`, 400 `invalid` for an unknown file.

### Links, calls and messages on the phone

An agent with the skill `app-links` puts an `info` card with a `url` into the chat: the person
taps it, and nothing opens by itself. `url` is an `https` link (an app's universal link, or the
web), or `tel:`, `sms:`, `mailto:`, `facetime:`, `facetime-audio:`, `shortcuts:` or
`app-settings:`. A call or a message to someone in the person's contacts carries the app's own
address, so the contact never leaves the phone:

- `wizardsbot://call?to=<name or number>`
- `wizardsbot://message?to=<name, number or address>&via=messages|mail|whatsapp&text=<text>&subject=<subject>`

The phone finds the number or the address in its contacts, shows it, and opens the call, the
system's message or mail form with the text filled in, or WhatsApp. The person sends it there.
The web app shows such a card with a line saying to tap it on the phone.

## The person's avatar

The person is drawn as a pixel figure built from a few named traits (`Avatar`): skin, hair,
glasses, beard, hat, top, bottom, shoes and one accessory. A device draws it with the engine in
`packages/avatar` (stacked sprites: the figure turns to any angle), or asks the home for a
picture. There are two views of one figure: `head` (head and shoulders in a square, for a
small place beside a name) and `body` (the whole figure, where there is room). Traits kept in
an earlier shape (shoes as a colour only, no accessory) are read as the same figure.

`GET /v1/avatar` → `{ "avatar": Avatar | null }`. `PUT /v1/avatar` with `Avatar` →
`{ "avatar": Avatar }`.
`DELETE /v1/avatar` removes it.

`POST /v1/avatar/from-selfie` with `{ "fileId": "fil_…", "anywhere": false }` → `AvatarFromSelfie`.
A model looks at the picture and names the traits. Without `anywhere`, only a model on the
home's own computer is asked. When none there sees pictures, the home answers
409 `{ "error": "leaves_home", "message": "…", "models": ["Claude"] }` and keeps the picture:
the device asks the person, and sends the request again with `"anywhere": true`, or deletes the
picture with `DELETE /v1/files/:id`. In every other case the home deletes the picture itself.
Nothing is saved until the device sends `PUT /v1/avatar`. 400 `invalid` when the file is no
picture; 503 `no_model` when no model that sees pictures answers.

`GET /v1/avatar.png?angle=<degrees>&size=<pixels>&view=head|body` → the figure as a PNG about
`size` pixels high, for a device without the engine. `view` is `body` when left out; `head` is
a square. 404 when there is no avatar.

The event `avatar.updated` carries the avatar after each change, or `null`.

## Models

`GET /v1/models` → `Models`. The person changes them by conversation; this route only shows
them.

### Where what the person writes goes

A model source that sends what it reads to a company outside the person's own computers names
that company in `service`: Claude to Anthropic, Codex to OpenAI, a gateway to itself (OpenRouter,
Vercel) or, for OpenAI's and Anthropic's own addresses, to them. Ollama, on a computer of the
person, and the model on a phone have none. `Models.services` lists each such service: which
sources send to it, whether the home would use one of them now (`inUse`: one of the model refs
it tries), and when and on which device the person said yes (`agreed`).

```json
{
  "sources": [
    {
      "id": "claude",
      "kind": "subscription",
      "label": "Claude",
      "where": "Ada's Mac",
      "online": true,
      "models": [{ "id": "sonnet", "label": "Sonnet" }],
      "service": "anthropic"
    },
    {
      "id": "ollama",
      "kind": "ollama",
      "label": "Ollama",
      "where": "Ada's Mac",
      "online": true,
      "models": [{ "id": "qwen3:8b", "label": "qwen3:8b" }]
    }
  ],
  "order": [],
  "current": "claude:sonnet",
  "services": [{ "id": "anthropic", "label": "Anthropic", "sources": ["Claude"], "inUse": true }]
}
```

The yes is kept by the home and counts for all of the person's devices. Before a phone, a watch
or a browser sends what the person wrote, the device shows where it goes and asks once; a
service that comes into use later asks again. While a service in use has no yes, the home answers
these routes of a phone, a watch or a browser with 409
`{ "error": "needs_consent", "message": "…", "services": ModelService[] }` and keeps nothing:
`POST /v1/conversations/:id/messages`, `POST /v1/conversations/:id/import`, the answer of a
hand-off that is not declined, and the answer of a card with text typed into a field. A
computer (a terminal, a linked computer) is the person's own and is not asked.

`POST /v1/consent` with `{ "services": ["anthropic"] }` → `Models`: the person said yes on this
device. 400 `invalid` for a service the home does not know. `DELETE /v1/consent/:service` →
`Models` takes the yes back. Both send `models.updated`.

## Setup

The first start and the Status of the settings show the same checks, and `wizards-bot doctor`
prints them. `GET /v1/setup` → `Setup`:

- `models`: one `SetupCheck` per model source: Claude Code and Codex where they may be used,
  Ollama, each gateway, the sources of a linked computer. Its `state` and `said` come from the
  source's last **test call** (a prompt of a few words, with a timeout: 90 seconds for a
  client, 120 for Ollama, 30 for a gateway), kept with its time in `at`. `untested`: no call
  yet. `absent`: not on this computer, which is no problem. `testing`: a call runs now.
- `home`: the address and whether something answers there, the data folder (a `warning` when
  it lies in a temporary folder or the disk is nearly full), the connected folders (a
  `problem` when one is gone), notifications (an Apple key or not).
- `capabilities`: text, reading pictures, the phone's own model (a phone that said what it
  keeps has one).
- `done`: the person went through the first start, or wrote to an agent before there was one.
  `working`: a model answered its last test call. `hasModel`: the home has a model it would
  ask. The web app shows the setup instead of the chat while `done` is false or `hasModel` is.
- `name`: the person's name, `confirmed` once they said it (here or with the main agent).
- `hosted`: the home runs on wizards.bot. Its models come from the wizards account; the setup
  offers a key of one's own and the person's computer beside it.
- `address`: the address at wizards.host ([address.md](address.md)), as `SetupAddress`:
  `{ on, state, name?, reason? }`. `state` is `off`, `starting`, `on`, `refused` (the relay
  said no) or `failed` (the relay or GitHub did not answer, or frpc did not start); `reason`
  says why in one sentence, the relay's own where it said no. `name` (`k7qf2mxd3a.wizards.host`)
  is known once the home made its claim key and stays when the address is switched off. Missing
  on a hosted home and on one with an address of its own (`WIZARDS_BOT_URL`).
- `ownFolder`: the agents' own folder, `{ path, connected, exists }`: the one connected, or
  `~/wizards` in the person's home folder, which the setup suggests. Missing on a hosted home,
  whose computer has no folders of the person's.

The first start asks, in this order: the name, the models, the folders (not on a hosted home)
and the phone. The folders step shows the agents' own folder, `~/wizards` unless the person
picks another; going on connects it with `POST /v1/folders` and `own: true`. Below it the
person may connect further folders, each read only or read and change; they are connected at
once with the same route, and the step goes on with none.

`said` is one sentence the person can act on, `todo` says what to do, `command` is what to run
in a terminal on the home's computer, e.g.:

```json
{
  "id": "claude",
  "kind": "model",
  "label": "Claude Code",
  "state": "problem",
  "said": "Claude Code is signed in with an API key whose usage limit is reached.",
  "todo": "Raise the key's limit in the Anthropic Console, or sign in with your subscription instead: run claude, then /login.",
  "command": "claude",
  "source": "claude",
  "at": "2026-11-22T10:44:12.000Z"
}
```

A check of Ollama on the home's own computer that has no model, or only one too large for the
computer's memory, offers one in `pull`: `{ "model": "qwen3:8b", "size": 5200000000 }`, the
largest of the home's suggestions that leaves the computer room. `POST /v1/setup/pull` with
`PullSetup` (`{ "model": "qwen3:8b" }`, only a model the setup offers) starts the pull and
answers 202 with the `Setup` at once; its `pulling` says how far it is (`state` `pulling`,
`done`, `failed` with Ollama's `error`; `done` and `total` in bytes). When the model is
complete the home tests Ollama. A home on a server pulls nothing (400).

A model of Ollama takes a large part of the computer's memory, so the home has Ollama load one
only once the person picked it: `POST /v1/setup/ollama` with `SwitchOllama` (`{ "on": true }`)
picks it and tests it, `{ "on": false }` stops using it; both answer the `Setup`. Naming one of
its models in `PUT /v1/models/order` picks it as well, and so does a pull. Until then Ollama is
found and not asked, by a test call, a turn or a picture: its check is `untested` with `on: false`
and, in `start`, the model it would load and its size (`{ "model": "qwen3:8b", "size":
5200000000 }`). A home that answered with Ollama alone before it could be picked has it picked. A
hosted home has no Ollama (400 `refused`).

Test calls cost tokens. The home makes them only when asked: `POST /v1/setup/test` with
`TestSetup` (`{}` for all sources, `{ "source": "claude" }` for one) answers once the calls are
done, with the new `Setup`. A call that runs already is not made twice. The web app asks once
when the models step opens and nothing was tested, and again on "Test again".

`PATCH /v1/setup` with `ChangeSetup` sets the person's name, ends the first start
(`{ "done": true }`) or says the language the person reads (`{ "lang": "de" }`) → `Setup`. What
the Bot Server writes for the person itself (the checks' `said` and `todo`, a pairing card, the
greeting after the first start) is in that language, English until a device said one.

`POST /v1/setup/gateway` with `SetupGateway` puts the key card of a gateway into the main
agent's chat, with a field for the model, and answers `{ card }`. It works while no model
answers; answering the card sets the gateway up and tests it. `POST /v1/setup/pairing` makes a
pairing code for the setup's own page and answers `{ address, code, link }` (`link` is what the
QR holds); nothing goes into the chat. While the address at wizards.host is switched on and has
its certificate, `address` is `https://<name>`.

`POST /v1/setup/address` with `SwitchAddress` (`{ "on": true }`) switches the address at
wizards.host on or off and answers the `Setup` at once; on, its `address.state` is `starting`
and `setup.updated` follows each change of state. Off stops frpc and keeps the name. A hosted
home, or one with an address of its own, refuses it (400 `refused`). The main agent switches it
with its tool `address_switch`, on only after the person said yes on a card.

The event `setup.updated` carries the `Setup` when a test call starts and when it ends, after
a change, when the address at wizards.host changes its state, and about once a second while a
model is pulled.

## Events

`GET /v1/events` is a server-sent event stream. Each event is one line of JSON in `data:` with
the `Event` shape, and an `id:`. A device reconnects with `Last-Event-ID`; the home replays what
the device missed or sends `{ "type": "reset" }`, after which the device loads agents, items and
its open conversation again. `message.delta` events have no id and are never replayed: after a
reconnect the device loads the message. The home sends a comment line every 20 seconds.

```
id: 412
data: {"type":"message.created","message":{…}}

data: {"type":"message.delta","conversationId":"cnv_…","messageId":"msg_…","part":1,"text":" free"}

id: 413
data: {"type":"message.updated","message":{…}}
```

## Notifications

The home pushes through APNs when it has a key (see `docs/notifications.md`); without one, the
app shows local notifications from the event stream while it runs.

Payload of a push:

```json
{
  "aps": {
    "alert": { "title": "Goose", "body": "Send the invitation to Anna?" },
    "category": "card.approval",
    "thread-id": "agt_…",
    "interruption-level": "time-sensitive",
    "sound": "default",
    "badge": 2,
    "mutable-content": 1
  },
  "cardId": "crd_…",
  "conversationId": "cnv_…",
  "agentId": "agt_…",
  "actions": [{ "id": "yes", "label": "Send" }, { "id": "no", "label": "Don't send" }]
}
```

- `needs_you` cards push as `time-sensitive` with category `card.<kind>`; replies and `update`
  cards push as `active` with category `message`.
- A card with at most two actions and no fields is answered from the notification, on the
  phone and on the watch: the device calls the answer route. Other cards open the chat.
- When a card is answered anywhere, the home sends a silent push with
  `{ "resolved": ["crd_…"] }` and the device removes the delivered notification.
- `badge` is the number of open items.
- Every alert push has `"mutable-content": 1`, so the app's notification extension can give a
  card its own buttons. A card's push carries `cardId` and `actions`; a reply's push carries
  `messageId`. A device that also notifies from the event stream drops the double by these ids.
