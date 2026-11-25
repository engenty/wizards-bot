# A network of homes

How many people's homes reach each other without a central hub: who is who, how homes find
and reach each other, how an agent is shared and joined, how a group chat across homes works,
and how a home can belong to a group instead of a person. This is a plan; nothing here is built
unless the section "What works today" says so. The decisions at the end are taken.

The short answer: no hub is needed to run the network. Every person, home, agent and room is
reachable from a name the person controls, and every request is signed. A **directory** is
useful but optional: a service that gives a name and a mailbox to people without their own
domain or server, and lists agents and rooms that chose to be found. `wizards.id` can run the
first one; anyone can run another, and a home with its own domain needs none.

## What works today

Read from `apps/home/src/peers/`, `sharing/`, `link/` and `identity.ts` on 2026-11-21. Rooms
were built on 2026-11-22 (`peers/rooms.ts`); what of section 4 they do is said there.

| Works                                                                                                                                                                              | Where                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| A home has one Ed25519 key, made on first start.                                                                                                                                   | `identity.ts`                       |
| A handle is `name@host`: the person's first name (or `person.handle`) at the host of `WIZARDS_BOT_URL`. Without that address a home has no handle and reaches no other home.       | `home.ts` `handle()`                |
| `GET /.well-known/wizards.json` says the handle, the name and the public key.                                                                                                      | `peers/peers.ts`                    |
| Two homes connect once: a signed request, a card for the other person, then `connected`. A home not yet known is looked up at the address its handle names.                        | `peers/peers.ts` `verified()`       |
| Requests between homes are signed after RFC 9421 over method, path, body digest and the receiving handle, with five minutes of clock skew.                                         | `peers/signature.ts`                |
| An agent is shared with a connected contact, to talk to (it stays home and answers over A2A, without tools) or as a copy of its instructions. The contact sees a card and adds it. | `peers/peers.ts` `agent_share`      |
| Each sender has one conversation of its own with a shared agent.                                                                                                                   | `store.ts` `guestConversation`      |
| A document or an artifact is sent to a contact as a copy, at most 20 an hour from one contact.                                                                                     | `sharing/sharing.ts`, `/peers/send` |
| Outside agents are asked over A2A; callers are let in with an access token.                                                                                                        | `peers/outside.ts`, `peers/a2a.ts`  |
| A linked computer holds an outbound WebSocket to the home and offers its models. It needs no public address.                                                                       | `link/hub.ts`, `link/computer.ts`   |

| Missing                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A person apart from a home: the handle is the home's host, so a person with a laptop and a VPS has two handles, and moving the home changes who you are. |
| A key that outlives a home: a lost `home.key` is a lost identity, and contacts cannot tell a new key from an impostor.                                   |
| Reaching a home without a public address, and anything for a home that is off: sending fails with "out of reach", nothing waits to be delivered.         |
| An invite: connecting starts from a handle and trusts whatever key the address serves at that moment.                                                    |
| Sharing one agent without connecting the whole home, and rights finer than talk or copy.                                                                 |
| Rooms: a conversation with several people and agents from several homes.                                                                                 |
| A home owned by a group.                                                                                                                                 |
| Anything that limits strangers beyond five open connect requests (`MAX_OPEN_REQUESTS`).                                                                  |

## Words

New things need words in the table in `AGENTS.md`. Proposed:

| Thing                                                            | Word                                     | Not                                    |
| ---------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| a conversation of several people and agents, maybe across homes  | room                                     | group chat (fine in copy), channel     |
| whoever takes part in a room                                     | member                                   | participant, user                      |
| the home that keeps a room's order and its list of members       | the room's home                          | hub, host server                       |
| a link or QR that lets someone connect, join an agent or a room  | invite                                   | invitation token                       |
| a home that belongs to a club, a company, a forum                | group home; the people who run it admins | organization server, instance          |
| a service that keeps names and mailboxes and lists what is found | directory                                | registry, hub                          |
| a place that keeps what arrives for a home that is off           | mailbox                                  | relay (that one only passes things on) |

"Channel" stays Slack, email, WhatsApp, Signal. "Contact" stays another person's home you
connected to.

## 1. Who is who

### A person, a home, an agent

| Who    | Known by                                                                          | Key                                                                      |
| ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| person | a handle `name@domain` that points to a person record                             | a person key, kept off the server (phone Keychain, plus a recovery code) |
| home   | its address and its home key, listed in the person record                         | `home.key`, as today                                                     |
| agent  | its home and its id: `matthias@wizards.id/travel`, or the A2A address of its card | none of its own; its home signs                                          |
| device | nothing outside the home                                                          | its token with its own home, as today                                    |

The **person record** is a small signed document: the person's name, the homes that speak for
them (address, home key, which one receives) and the next keys. It is signed with the person
key. A contact stores the person, not the host: a request is accepted when its home key is in
the person's current record.

This splits today's one key in two, the way AT Protocol splits a signing key (on the server)
from rotation keys (with the person): the home key signs everyday requests and can be replaced;
the person key only signs a new record, rarely, and never lives on a server.

### Several homes for one person

Most people have one home that receives: the VPS when there is one, the laptop otherwise. The
record names it. Today's linked computer already covers "my laptop helps my VPS home": the
laptop offers its models over the link and needs no address.

A second full home (its own agents, for example one at work) is listed in the record as well.
Contacts keep one list per person: whichever of the person's homes they reach, it is the same
person. What a contact shared with the person is shared with the person, and either home can
use it. The agents themselves are not copied between homes; each agent lives in one home.

When the laptop is off: with a VPS home, nothing changes for others; the VPS loses the laptop's
models until it comes back (as today). Without a VPS, others' messages wait in a mailbox
(section 2) and the person's agents are out of reach.

### Handles and domains

A handle is a name at a domain, resolved by one HTTPS request, the same shape as Nostr's NIP-05
and WebFinger (RFC 7033):

```
GET https://wizards.id/.well-known/wizards.json?name=ada
→ { "names": { "ada": "<person id>" }, "records": { "<person id>": "<url of the person record>" } }
```

- `ada@wizards.id`: the directory at `wizards.id` answers for Ada and points to her record,
  wherever her home runs.
- `ben@example.org`: Ben puts one file on his own site, or a DNS TXT record
  `_wizards.example.org`, that points to his record. His home can run anywhere.
- A home on its own domain answers for itself, as today.

The handle is a name; the **person id** is what contacts keep. It is fixed when the record is
first made (the hash of its first version, as did:plc and did:webvh do), so a person can change
handle or domain, and contacts follow. A handle is valid only while the record names it and
the domain points back, as AT Protocol checks in both directions.

### Moving a home, losing a device

| What happens                  | What the person does                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| the home moves to a VPS       | back up `/data`, start it there, sign a new record with the new address. Contacts follow the record.                    |
| a new home, a new key         | sign a new record that lists the new home key. The old key stops counting at once.                                      |
| the laptop is stolen          | sign a new record without the laptop's home key, from the phone. The laptop's requests are refused from then on.        |
| the phone is lost             | the person key is in the Keychain backup, or comes back from the recovery code; sign a new record from the new phone.   |
| the recovery code is lost too | nothing proves it is you; you start a new person and ask your contacts again. This is said once, when the code is made. |

Apple's Secure Enclave keeps P-256 keys, not Ed25519. The person key should be P-256 if it is
to live in the Secure Enclave, or Ed25519 in the ordinary Keychain. Open decision 2.

## 2. Reaching each other

| Home                     | Reached how                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VPS with an address      | directly over HTTPS, as today                                                                                                                                                                            |
| laptop with a VPS home   | not reached by others; it is the VPS home's linked computer                                                                                                                                              |
| laptop alone, behind NAT | it holds an outbound connection to a mailbox (its own VPS, a friend's group home or the directory's), as the link does today; the mailbox passes requests through and keeps them while the laptop is off |
| a group home             | a VPS with an address                                                                                                                                                                                    |

**The mailbox** takes a signed envelope for a home it serves, keeps it for a while (a week),
and hands it over when the home connects. It needs no trust: the envelope is signed by the
sender, so the mailbox cannot change it, and its content is encrypted to the receiving home
key (HPKE), so the mailbox reads only who it is for. A home with an address still benefits:
the sender keeps an outbox and tries again when a contact's home was out of reach, instead of
failing.

**Direct connections without a server** (hole punching) exist and work: Tailscale connects
directly where the two NATs allow it and otherwise falls back to its DERP relays, which pass on
encrypted packets by public key; iroh dials by public key with the same pattern and says about nine in ten
networks allow a direct path. Both still need a relay for the rest, and a discovery service.
They are worth adding later for speed, not for reaching anyone the mailbox cannot. iroh has a
Node binding (`@number0/iroh`); a person's own Tailscale between laptop and VPS works today and
needs nothing from us.

**Invites.** An invite is a link and a QR:

```
https://wizards.id/i/<code>          (or wizardsbot://invite?…)
  who:  person id, handle, name, fingerprint of the person key
  where: address of the home or its mailbox
  what:  connect | agent <id> | room <id>, with the rights offered
  code:  one use, an end time
```

Opening it sends a signed request with the code. Because the invite carries the fingerprint,
the receiving home checks the key against it instead of trusting whatever the address serves:
stronger than today's lookup by handle. An invite through `wizards.id` only redirects; the page
does not need to know what is inside.

**Discovery.** Without a hub, you find someone by their handle, by an invite or by a link on
their site. A2A defines how an agent card is found (`/.well-known/agent-card.json`) and says it
defines no registry API. The directory is the place for what wants to be found.

### The directory

| Holds                                                                        | Never holds                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| names at its domain and the person id each points to                         | conversations, documents, memory                                             |
| a mailbox for homes that ask for one (encrypted envelopes, for a week)       | keys other than public ones                                                  |
| a list of agents and rooms whose owners chose to list them, with their cards | anything about who talks to whom, beyond what a mailbox must know to deliver |
| a short page per invite                                                      |                                                                              |

Who runs it: engenty runs `wizards.id`; any group home can run one for its members at its own
domain. A home can use any directory, several, or none. If `wizards.id` goes away, people on
their own domains lose nothing; people with a `wizards.id` name keep their person id and their
contacts, and choose a new handle.

## 3. Sharing and joining one agent

Today a share needs a connected contact, and the share is talk or copy. Proposed:

- **Invite to one agent.** "Invite Ben to Travel" makes an invite for that agent only. Ben's
  home accepts it with Ben's yes, and Travel appears in his list as a shared agent (as today).
  The two homes are connected for that agent only: Ben cannot send documents or connect
  further without a second step.
- **Rights**, set on the share and shown on the card that asks:

  | Right     | What the guest gets                                                                                                                   |
  | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
  | talk      | a conversation of their own with the agent, which answers from its instructions; no tools, as today                                   |
  | documents | the agent may show the guest documents and artifacts the owner named for this share, read only                                        |
  | act       | the agent may use tools the owner named. Reading tools run; a tool that changes something asks the owner with a card, never the guest |

- **A guest's conversation is the guest's.** The owner's devices do not list it and do not
  show it, and no other guest sees it. The agent runs in the owner's home, so the conversation
  is stored there: someone who runs a home on their own computer can read its database. The
  invite says so in one line, before the guest joins.
- **What a guest hears from the memory.** In a guest's turn the agent reads only the part of
  its memory the owner cleared for guests. The card that shares the agent shows the memory and
  asks: nothing of it (the default), all of it, or the notes the owner picks.
- **What a guest teaches.** The agent does not write to its memory from a guest's
  conversation. What a guest asks it to keep becomes a suggestion: a card for the owner with
  the one sentence, to keep or to drop. What the agent learns about a guest stays in that
  guest's conversation. Otherwise what Ben says would reach Ada's other guests through the
  memory.
- **Acting apart.** With the right to act, the agent has the tools, the connections and the
  folders the owner named for this share, and nothing else of the home. A guest's words are
  from outside the home, so every change asks the owner, also where the owner said "always".
- **Joining** someone's agent is the other side of the same invite. The agent stands in your
  list, marked as theirs; your agents ask you before they write to it (as today).
- **Taking it back.** A new tool removes one share; the agent's home tells the guest's home
  with a signed notice, and the agent leaves the guest's list. Requests after that are refused
  (403, as today). An invite not yet used is taken back the same way. Leaving is the same from
  the guest's side.

## 4. Rooms

A room is a conversation of several people and agents, from one home or several.

### What is built

Built on 2026-11-22, in the home and the web app:

- A room is opened, an agent of your own is added and a connected contact is invited by
  telling the main agent (`room_open`, `room_add`, `room_invite`); each of the last two asks
  with a card. The invited person joins with a card on their side.
- The home that opened the room keeps it: it numbers the messages, sends each to the other
  homes in order, and a home that missed some asks for everything after the last it has.
- An agent answers when it is named with @, in its own home, one at a time, eight messages at
  most after a person's message, six agents at most in a room.
- Leaving a room, and closing one by the home that keeps it.
- In the list a room stands beside the agents; in the chat each message says who wrote it.

The person's record and key, built on 2026-11-22 (`peers/person.ts`, the web app's
`lib/personKey.ts`, the iOS app's `Shared/PersonKey.swift`): the key is made on the device
the card is opened on. A browser keeps it where no page reads it out; the iPhone keeps it in
the Keychain, in iCloud Keychain where that is on. The recovery code is shown once and is the
same on both, so a key made in one is brought back in the other. The home keeps and shows the
signed versions; a contact's
home remembers the person and takes a new home key only from a version signed with the key it
remembers. So a home that was lost is replaced by a new one at the same address, and the
person's contacts go on. Not built from this section: several homes in one record, taking a
home out of it, and a new key.

Decisions 12 and 15, built on 2026-11-22 (`Peers.guestTools`, `agent/prompt.ts`): someone an
agent is shared with hears nothing of what it remembers unless the agent's person said so
when sharing or inviting, and what they ask it to remember is one sentence on a card its
person keeps or drops. Not built: choosing single notes for guests (the memory is one text:
it is all of it or nothing), and suggestions from a room.

A home without an address, built on 2026-11-22 (`peers/mailbox.ts`, `Peers.presented`): a
home on a laptop is known by its person's key, sends its card with every request and asks its
contacts' homes for what they keep for it, with a request that waits there. It joins by
invite, writes in rooms, and its agents answer rooms. This is the mailbox of section 2 with
each contact's home as the mailbox; the one at a directory, for two homes that both have no
address, is not built.

Decision 14, built on 2026-11-22 (`store.ts` `isGuest` and `emit`, the guard in `server.ts`,
`Peers.endShare`): what someone else writes to a shared agent is told to none of the owner's
devices and cannot be read, written in or stopped through them; it is deleted when the share
ends. It is still kept in the home, as the invite says. Decisions 12 and 15 (what a guest
teaches as a suggestion, what a guest hears from the memory) are not built.

Handles on a domain of your own, built on 2026-11-22 (`peers/peers.ts` `lookup`, `follow`;
`handle_set` in `peers/person.ts`): a domain names the home for a name with one file, the home
names the handle, and the handle counts once the person's key signed it. Contacts that
remember the person follow a new handle and a home at a new address from the signed record,
with their shared agents and rooms. Not built: a DNS TXT record in place of the file, and
names at `wizards.id`.

Invites by link, built on 2026-11-22 (`peers/invites.ts`): `invite_make` asks with a card and
then shows the link with its QR code; it is for connecting, for one agent or for one room, and
works once, for a day, a week or a month. The other person gives the link to their agent,
which checks the home's key against the print in the link, shows a card and joins on a yes.
Who joins an agent or a room this way is a contact for that only. The link is at the home's
own address until `wizards.id` exists, so the home that makes an invite needs an address
others reach. On the iPhone the app scans the QR code ("Scan an invite" under the plus) or
is handed the link by the invite's page (`wizardsbot://invite?link=…`), and its home reads
the link without a turn of the agent (`POST /v1/invites/open`): the same card stands in the
main agent's conversation.

Built the same day, from the first stage: a signed request carries a nonce and is heard once
(`peers/signature.ts`, `Peers.verified`), and one share is taken back with `agent_unshare`,
or ended by the other person removing the agent from their list (`POST /peers/unshare`).

Not built yet: roles beyond the
person who opened the room, removing someone else, files and pictures in a room, a room whose
home was out of reach when you wrote (the message is not sent again by itself), notifications
for what others write.

### What an agent brings into a room

An agent in a room brings what is its own: its task, what it remembers, and the documents,
artifacts and files of its conversation with its person. Everyone in the room reads what it
says about them, and the card that adds the agent says so. The person's tools stay private:
the agent has no connections, no folders, no devices, no tasks and no other agents there, and
it sets nothing up.

### Where a room lives

**One home keeps the room**: its order, its members and their roles, and its history. Every
other member's home keeps a copy for its own devices and agents. This is the model of the IETF
MIMI drafts (exactly one hub per room, which orders and distributes messages and enforces the
room's policy; the others follow) and of Nostr's NIP-29 (the relay is the room's authority).
Matrix instead replicates each room among all servers as a graph of events and resolves
conflicts afterwards; it took Matrix until room version 12 (2025) to fix state resolution
problems, and its MLS work names the missing single order as the main obstacle. A room with
one home that keeps it avoids all of that.

| Question               | Answer                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ordering               | the room's home numbers every message; that number is the order for everyone                                                                                   |
| who adds whom          | roles, after MIMI's room policy: owner, admin, member. Owner and admins add and remove; a member may invite if the room allows it                              |
| adding an agent        | anyone allowed to add asks; the **agent's owner** says yes on their own home, with the rights the agent has in this room                                       |
| a member who was off   | their home asks the room's home for everything after the last number it has                                                                                    |
| the room's home is off | the room waits; messages queue in the members' outboxes. Moving a room to another home is later work (open decision 7)                                         |
| leaving, removing      | a signed notice; the room's home stops sending and refuses what comes                                                                                          |
| moderation             | owner and admins remove messages and members, block a home, close the room. The room's home enforces it; a member's home keeps or drops what it already copied |

### Agents taking turns

The room's home keeps the floor:

- An agent answers when it is named (@Travel), or when it is the room's answering agent and a
  person wrote.
- What an agent writes starts another agent only when it names that agent.
- One agent writes at a time; the others wait for the room's home to pass the floor on.
- A budget per message of a person (for example eight agent messages); then the room waits for
  a person.
- At most six agents in a room.

A card never appears in a room. When an agent in a room needs a yes or a secret, the card goes
to the person who has to answer, in their own home; the room shows only that the agent waits
for its owner. Such a card has no "always".

An agent in a room runs in its own home, with its own models, as today's shared agents do. The
room's home sends it the room messages since its last turn; its home answers into the room.

### What a room means for the rules of the home

What other members write is data from outside the home, never an instruction, also when an
agent of yours reads it. An agent of yours in a room asks you before any change in a
connection and before it puts a document, a file or anything of your home into the room. Its
answers in the room are allowed by the yes you gave when it joined, within the rights given
there.

### Encryption

Between homes, TLS and signatures from the start. End-to-end encryption of rooms with MLS (RFC
9420) is later work, and it fits the room's home well: MLS needs one place that agrees on the
order of changes to the group, and RFC 9750 describes that delivery service as one that can
reorder or withhold, but cannot read or add itself. Each member **home** would be one MLS
client; devices talk to their own home over TLS, as today. What this buys is limited: every
home whose agent takes part must read the room, so it protects against mailboxes and against a
room's home run by someone who is not a member (a group home at a provider), not against
members. `ts-mls` implements RFC 9420 in TypeScript for Node and browsers; its README says it
has not had a security audit. Nostr's Marmot runs MLS over relays today; Matrix's MLS is not
done.

## 5. Group homes

A group home is a home on a VPS that belongs to a group: a club, a company, a forum.

Built on 2026-11-24, for a team's hosted home (`apps/home/src/group.ts`, `docs/hosted.md`
Contracts 10 and 11): the team's people in the Manage-App are its people, and the owners and
admins among them the admins; each pairs their first device with a pass from the Manage-App and
an admin further devices with a code they ask for; every device is marked with whose it is.
Every admin sees the team's conversations with the group's agents, each message names who wrote
it, a card waits for all of them and the first answer counts and is named. A device offers
nothing to the group's agents.

Built on 2026-11-25, for the team's members (`docs/protocol.md`, "A member of a group home"): a
member is a person of the team with a device of the group home, paired with a pass like an
admin's. They chat with the group's own agents, each in a conversation of their own
(`conversation.person_id`), made the first time their device lists the agents.

| Of a member's conversation | How it is                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| who reads it               | the member alone. An admin's device gets 404 for it and for its cards, documents and artifacts, hears none of its events and gets no push from it; the admins' search and "what needs you" do not list it |
| what the member reaches    | the group's own agents and what is in their own conversations. Not the team's conversations, rooms, shared and outside agents, the settings, the Vault, folders, devices, models, sharing                 |
| the agent's tools          | what stays in the conversation: questions, documents, artifacts, the conversation's files, skills, longer work. No folder, no shell, no Vault, no device, no task, no other agent                         |
| connections                | the studio the team works in, and no other: it is called with the member's own token, so the studio decides what they see and run. A tool that changes something asks the member, each time               |
| the agent's memory         | read, not written: it stands in every turn of every admin                                                                                                                                                 |
| cards                      | answered by that member alone. No more capable model is offered                                                                                                                                           |
| credits                    | a member's turns spend the team's, like an admin's                                                                                                                                                        |
| someone who leaves         | their conversations go with their devices. Someone who becomes an admin keeps theirs stored, and they are not shown                                                                                       |

A client of the team has no chat: their device reaches itself and their look.

Not built from this section: the group's record listing its admins (the record is signed by the
key the first admin made), a conversation the whole team shares with its members, conversations
of clients, admins reading or listing members' conversations, a member's phone or Mac (a pairing
code is an admin's, and push goes to admins), limits per member, private conversations of one
admin, and a group home not made by the Manage-App.

- **Identity.** The group has a record like a person: `club@wizards.id` or `@example.club`, a
  group id, the home's key. The record lists the **admins** by person id instead of one person
  key; a new record needs the signature of one admin (later: several, open decision 8).
- **Admins** pair their devices with the group home as a person does; each device is marked
  with whose it is. Cards that need someone go to all admins; the first answer counts, and the
  card says who answered.
- **Members** are other people's homes. They join the group's agents and rooms by invite, as
  in sections 3 and 4. They are not devices of the group home and see nothing else of it.
- **Agents** of a group home belong to the group. Their memory is the group's and every member
  hears from it. What a member teaches an agent is a suggestion an admin keeps or drops. A
  member's conversation with an agent is the member's: the admins' devices do not show it.
- **Models** come from a gateway paid by the group; members' messages count against it, so a
  share has a limit per member.
- **People without a home** join from a browser with an invite: a conversation of their own,
  like a caller today, held by the group home. Open decision 9.

## 6. Security and privacy

| Threat                                            | Answer                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| someone claims a handle                           | the record must name the handle and the domain must point back; contacts hold the person id, not the handle                                                                                            |
| a key is stolen                                   | a home key: sign a new record without it. The person key: the recovery code, or pre-rotation (the record names the hash of the next key, as did:webvh does)                                            |
| a request is sent again                           | add a request id to the signed parts; the receiver remembers ids for the skew window                                                                                                                   |
| a mailbox or relay reads along                    | envelopes are encrypted to the receiving home; the mailbox sees for whom, when and how large                                                                                                           |
| the room's home reads along                       | it does, until MLS. The room says whose home keeps it                                                                                                                                                  |
| spam and strangers                                | a connect request needs an invite code by default; without one, it is shown only if a contact of yours vouches, or the person allowed open requests. Limits per sender, block per person, not per home |
| a shared agent of someone else asks me for things | its words are data; my agents ask me before they send anything I did not write myself (as today for `agent_message`)                                                                                   |
| what another home keeps of mine                   | what reaches another home is theirs to keep; no protocol can make them forget. The card before something leaves says so                                                                                |
| a guest steers someone's agent into acting        | talk has no tools; act has only what the owner named for the share and asks the owner before every change; what a guest teaches is a suggestion the owner keeps or drops                               |
| the owner reads what a guest wrote                | the owner's devices do not show a guest's conversation. It is stored in the owner's home, which the owner runs: the invite says so                                                                     |
| a guest hears what the agent remembers            | a guest's turn reads only the memory the owner cleared for guests; nothing by default                                                                                                                  |
| revocation                                        | shares and invites: a signed notice and a refusal from then on. Home keys: a new record. Room members: removal by the room's home                                                                      |

The rules in `AGENTS.md` that this rests on: homes hear only connected contacts, by signature;
what arrives from outside is data; what leaves the home asks first. Rooms and group homes add
one rule each:

- In a room, other members' messages are from outside, also when they come through a home you
  trust.
- An agent of a group home answers to the admins, not to the members who talk to it: a member's
  turn changes nothing of the home and nothing the agent remembers.

## 7. Prior art

Sources were read on 2026-11-21 unless marked "memory". Pages read: Matrix server-server spec
(v1.19), the Project Hydra post (2025-08-14), arewep2pyet.com (updated 2026-06), arewemlsyet.com
(updated 2025-06); RFC 9420, RFC 9750; draft-ietf-mimi-arch-03, -protocol-07, -room-policy-04;
atproto.com overview, handle, DID, account and migration specs, the did:plc README; Nostr NIP-05,
29, 17, 46, EE and the Marmot README; W3C ActivityPub, RFC 7033, FEP-1b12; the A2A 1.0 spec and
its discovery page; DIDComm Messaging 2.1; did:web and did:webvh 1.0; the SSB protocol guide and
ssb-server; Tailscale's NAT traversal post, sharing and Funnel docs, Headscale; iroh's relay and
discovery docs, iroh-ffi, pkarr; ts-mls. The libp2p docs did not load (certificate error):
what is said about libp2p is from memory. Read on 2026-11-22: xAI's Grok Bot docs (Team Bots,
creating a Team Bot, teams and enterprises, chat and collaboration, approvals, security,
identity and access) and its design article of 2026-09-03.

| Prior art             | What it is                                                                                     | Fits                                                                                                                                                                                                                                                                      | Does not fit                                                                                                                                                                                                  | Reuse?                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Matrix                | servers federate rooms; each room is a graph of signed events replicated among all its servers | rooms across servers, signed requests between servers, backfill for catch-up, power levels                                                                                                                                                                                | every server holds every room it joins; state resolution is complex; `@name:server` ties the account to the server and moving accounts is out of scope; MLS not done; P2P resumed 2026 but not secure yet     | no. A bridge to Matrix rooms later is possible                                                              |
| MIMI (IETF drafts)    | rooms between messaging providers: one hub per room orders and enforces policy, MLS inside     | exactly the room's home model; roles and who may change what; servers as senders outside the MLS group                                                                                                                                                                    | drafts, not finished; built for providers with accounts, mutual TLS                                                                                                                                           | the model and the room policy, not the wire format yet                                                      |
| MLS (RFC 9420/9750)   | group key agreement for E2E, from two to very large groups                                     | the room's home is the delivery service MLS asks for; adds and removes; forward secrecy and post-compromise security                                                                                                                                                      | does no access control itself; every agent's home must still read the room                                                                                                                                    | yes, later, with `ts-mls`                                                                                   |
| AT Protocol           | PDS hosts a person's data; DIDs; relays and app views build public views                       | signing key on the server, rotation keys with the person; handle by DNS or `.well-known`, checked both ways; account migration                                                                                                                                            | built for public data; no shipped private or group data found in the specs read; handles are host names, not `name@domain`; did:plc needs its central directory                                               | the identity ideas, not the protocol                                                                        |
| Nostr                 | keys are identities; relays store and pass on signed events                                    | NIP-05 `name@domain` → key; NIP-29 rooms where one relay is the authority; NIP-46 key on another device; Marmot is MLS over relays                                                                                                                                        | relays are not homes; NIP-17 private chats give up above about ten people; agents and A2A are foreign to it                                                                                                   | NIP-05's shape for handles; the NIP-29 model for rooms                                                      |
| ActivityPub           | actors with an inbox and outbox, servers deliver to each other; WebFinger for `user@domain`    | `user@domain` lookup; a Group actor that passes members' posts on unchanged, signed (FEP-1b12)                                                                                                                                                                            | made for public posts; no E2E in the spec; actors tied to the server                                                                                                                                          | WebFinger's shape; maybe a group home that publishes to the fediverse, much later                           |
| Secure Scuttlebutt    | every person an append-only signed log; pubs and rooms for reach                               | works offline, peers sync when they meet; a network key for a private network                                                                                                                                                                                             | logs never shrink and cannot be edited; private messages up to 7 recipients; current maintenance not confirmed (ssb-server README is out of date; Manyverse wrote in 2023 about a successor)                  | no                                                                                                          |
| A2A                   | one agent asks another; agent cards; tasks, streaming, push                                    | already how a home talks to a shared agent and to outside agents; signed cards (JWS) for checking an agent's card                                                                                                                                                         | no group or room: one client, one agent, a `contextId`; no registry API                                                                                                                                       | yes, as today, for one agent at a time; rooms are the home's own                                            |
| DIDComm 2.1           | messages between DIDs, encrypted, routed through mediators                                     | mediators are the mailbox idea; authcrypt proves the sender                                                                                                                                                                                                               | no groups; no store-and-forward defined beyond "try later"; DIDs and envelopes add a lot for what signatures already do                                                                                       | no                                                                                                          |
| did:web / did:webvh   | DIDs on a domain; webvh adds a signed log, pre-rotation and moving to another domain           | did:webvh is close to the person record: id fixed at creation, keys rotate, domain can change                                                                                                                                                                             | did:web dies with its domain; did:webvh is young; a resolver library is another dependency (a TypeScript one exists, from memory: `didwebvh-ts`, not checked)                                                 | the person record could be a did:webvh log; open decision 1                                                 |
| Tailscale / Headscale | WireGuard mesh; direct connections by hole punching, DERP relays otherwise                     | a person's laptop and VPS on one tailnet; Funnel puts a laptop on the internet                                                                                                                                                                                            | a tailnet is one person's or one company's; sharing between tailnets is beta and per machine; the control server is a hub                                                                                     | for one person's own computers, by their choice; not the network's base                                     |
| iroh                  | dial by public key; QUIC, hole punching, relays; discovery over DNS or the Mainline DHT        | same key idea as homes; a laptop reached directly most of the time                                                                                                                                                                                                        | a relay and discovery are still needed; Rust first, Node binding young                                                                                                                                        | later, for direct connections                                                                               |
| libp2p (memory)       | peer-to-peer stack with relays and hole punching                                               | similar to iroh                                                                                                                                                                                                                                                           | large; the home already has HTTP                                                                                                                                                                              | no                                                                                                          |
| Grok Bot (Team Bots)  | agents shared inside one team on xAI's cloud; roles owner, manager, collaborator               | each person's chat is private, also from the owner; what a collaborator teaches is a suggestion the owner approves; shared chats use a computer of the agent's own; only the person being answered approves, never "always" in a group; two to six agents in a group chat | one team, one cloud: no live agent leaves the team (a public link gives a copy), no federation, no A2A, an agent has no identity of its own; agents in a group message each other without a limit or a switch | its rules for sharing inside a group; not its trust in whoever asks, and not its group chat without a floor |

## 8. Recommendation and stages

Build on what is there: the home key, RFC 9421 signatures, `.well-known/wizards.json`, the
contact table, A2A for one agent at a time, the link's outbound WebSocket. Take the room model
from MIMI and NIP-29, handles from NIP-05 and AT Protocol, MLS later. Do not adopt Matrix,
ActivityPub, SSB or DIDComm as the base.

### First: people, invites, sharing one agent

- The person record (person id, person key, the homes) at `.well-known/wizards.json`, signed;
  contacts keyed by person id. The phone keeps the person key; a recovery code is made once.
- Handles on any domain by a file or a TXT record that points to the record.
- Invites (link and QR) for connecting and for one agent, with the key fingerprint and a code.
- Rights on a share (talk, documents, act), a tool to take one share back, and the signed
  notice that removes it on the other side.
- A guest's conversation out of the owner's sight, the memory cleared for guests, and what a
  guest teaches as a suggestion for the owner.
- A request id against replays; an outbox that tries again when a contact is out of reach.

Builds on `identity.ts`, `peers/peers.ts`, `peers/signature.ts`, the `contact` and `share`
tables, `agent/prompt.ts` (the guest prompt).

### Second: rooms

- Rooms kept by one home: members and roles, numbered messages, a copy in every member's home,
  catch-up by number, invites to a room, the agent's owner saying yes to each agent.
- The floor for agents: named or answering agent, one at a time, a budget per message, six
  agents at most. Cards go to the person who answers, never into the room.
- Moderation by owner and admins.
- The web app and the iOS app show rooms beside conversations.

Builds on the Mastra thread per conversation (a room is a thread on every member's home), the
signal that wakes an agent (`agent/turns.ts`), the guest turn, `home.tell`.

### Third: the directory, the mailbox, group homes

- `wizards.id`: names, a mailbox for homes without an address, invite pages, an opt-in list of
  agents and rooms. The same program runs on any group home that wants to be a directory.
- Envelopes encrypted to the receiving home key for everything that goes through a mailbox.
- Group homes: a group record with admins, devices of several admins, cards that go to all
  admins, limits per member.

### Later

- MLS for rooms (`ts-mls`), with each member home as a client.
- Moving a room to another home; a second home of the group taking over when the first is off.
- Several admins' signatures for a group record; pre-rotation of the person key.
- Direct connections with iroh.
- People without a home in a group home's rooms, from a browser.
- The person record as a did:webvh log, if other systems should read it.
- A bridge to Matrix rooms.

## Decisions

Decided on 2026-11-21: each recommendation below is taken as it stands.

| #   | Decision                                                                            | Recommendation                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The person record: own small format, or did:webvh                                   | Own format now (a JSON document signed by the person key, each new version signed by the previous key, the id the hash of the first). Keep its fields close to did:webvh so it can be exported later |
| 2   | Person key: P-256 in the Secure Enclave, or Ed25519 in the Keychain                 | Ed25519 in the synced Keychain, plus a recovery code: same curve as home keys, and it survives a lost phone through the backup. The Secure Enclave key cannot be backed up                           |
| 3   | One home per person that receives, or several equal homes                           | One that receives, named in the record; others are listed and may host agents. The laptop next to a VPS stays a linked computer                                                                      |
| 4   | `wizards.id`: a directory engenty runs, from the start                              | Yes, for names, invite pages and mailboxes, and say plainly what it holds. Every function also works without it for a home on its own domain                                                         |
| 5   | Connect requests from strangers without an invite                                   | Off by default; an invite code is needed. The person can allow open requests                                                                                                                         |
| 6   | Where a room lives                                                                  | In one home that keeps its order, members and history (MIMI, NIP-29); no replicated rooms                                                                                                            |
| 7   | When the room's home is off                                                         | The room waits; messages wait in outboxes. Moving a room is later work                                                                                                                               |
| 8   | Who may change a group record                                                       | One admin first; several signatures later                                                                                                                                                            |
| 9   | People without a home in rooms                                                      | Not in the first rooms. Later, in a group home only, from a browser with an invite                                                                                                                   |
| 10  | E2E for rooms                                                                       | Not in the first rooms: TLS, signatures, and envelopes encrypted for mailboxes. MLS after rooms work, once `ts-mls` or another library has had an audit                                              |
| 11  | Agent-to-room transport: A2A with the room as `contextId`, or the home's own routes | The home's own signed routes for rooms; A2A stays for one agent at a time. A2A has no group                                                                                                          |
| 12  | Does a shared agent write memory from guests                                        | Not by itself. What a guest teaches is a suggestion the owner keeps or drops                                                                                                                         |
| 13  | New words: room, member, invite, group home, admin, directory, mailbox              | Add them to `AGENTS.md` when the first of them is built                                                                                                                                              |

Decided on 2026-11-22, after reading how Grok Bot shares an agent inside a team:

| #   | Decision                                         | Taken                                                                                                                            |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 14  | Can the owner read a guest's conversation        | The owner's devices do not show it. The home stores it, and the invite says that the person who runs the home could read it      |
| 15  | What a guest hears from the agent's memory       | Only what the owner cleared for guests when sharing; nothing by default                                                          |
| 16  | Where a shared agent acts                        | With the tools, connections and folders the owner named for the share, and nothing else of the home                              |
| 17  | Who approves what a guest's request would change | The owner, every time. Grok Bot lets the person who asked approve; between homes of different owners that person is from outside |
| 18  | Cards in rooms                                   | Never. A card goes to the person who has to answer, in their own home, without "always"                                          |
| 19  | How many agents in a room                        | Six at most. An agent answers when named, within the budget; agents do not decide among themselves who answers                   |

Decided on 2026-11-22, when rooms were built:

| #   | Decision                         | Taken                                                                                                                                                          |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20  | What an agent brings into a room | What is its own: its task, its memory, the documents, artifacts and files of its conversation. This replaces 15 for rooms: adding the agent is the yes to that |
| 21  | The person's tools in a room     | Private. An agent in a room has no connections, folders, devices, tasks or other agents. The right to act (decision 16) is not built                           |
| 22  | How much of this the apps show   | As little as possible for now: a room is one more entry in the list and a chat with names; everything else is said to the main agent                           |
