// What a home and its devices say to each other. docs/protocol.md describes the same
// shapes with examples; the iOS and watch app mirror them in Swift.
import { z } from "zod";
import { FILES_PER_MESSAGE, GARMENT_COLORS, LINK_LASTS, LINK_PASSWORD_MIN } from "./limits.ts";

export {
  FILE_LIMIT,
  FILES_PER_MESSAGE,
  FOLDER_PREVIEW_LIMIT,
  GARMENT_COLORS,
  LINK_LASTS,
  LINK_PASSWORD_MIN,
  ROOM_AGENT_TURNS,
  ROOM_AGENTS,
  ROOM_MESSAGE_LIMIT,
} from "./limits.ts";

export const PROTOCOL_VERSION = 1;

export const EngentyKind = z.enum([
  "round",
  "drop",
  "dome",
  "flame",
  "oval",
  "bean",
  "pebble",
  "sprout",
  "tower",
  "wedge",
]);
export type EngentyKind = z.infer<typeof EngentyKind>;

/** Where a message came in or went out. */
export const Channel = z.enum(["app", "watch", "slack", "email", "whatsapp", "signal", "home"]);
export type Channel = z.infer<typeof Channel>;

export const DeviceKind = z.enum(["phone", "watch", "computer", "browser"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

// ── The person's record ─────────────────────────────────────────────────────

/**
 * One version of a person's record as it was signed: the exact text, and the signature over
 * it (Ed25519, base64url). The text is JSON of the shape `PersonRecord`; it is checked and
 * kept as it is, never written anew, so no two programs have to agree on how to write JSON.
 */
export const SignedRecord = z.object({
  payload: z.string().max(8000),
  sig: z.string().max(200),
});
export type SignedRecord = z.infer<typeof SignedRecord>;

/**
 * Who a person is to other people's homes: their key, and the homes that speak for them. The
 * person's key signs it and lives on a device of theirs, never in a home. A later version is
 * signed with the key of the version before, so a new key is named by the old one.
 */
export const PersonRecord = z.object({
  v: z.literal(1),
  /** Fixed when the first key is made: it is derived from that key and never changes. */
  id: z.string().max(80),
  /** Grows with every version: the time it was made, in milliseconds. */
  seq: z.number().int().positive(),
  name: z.string().min(1).max(80),
  handle: z.string().max(200).optional(),
  /** The person's public key from this version on (Ed25519, base64url). */
  key: z.string().max(100),
  homes: z
    .array(
      z.object({
        /** Where the home answers; none for a home others cannot reach. */
        url: z.string().max(300).optional(),
        /** The home's public key. */
        key: z.string().max(100),
        /** The one home that takes what is sent to the person. */
        receives: z.boolean(),
      }),
    )
    .min(1)
    .max(8),
  at: z.string(),
});
export type PersonRecord = z.infer<typeof PersonRecord>;

/** `GET /v1/person`: the person's record as the home has it, and what waits to be signed. */
export const PersonState = z.object({
  /** The record that counts; none while no key was made. */
  record: PersonRecord.optional(),
  /** A new version the home asks a device that holds the key to sign, and why. */
  proposed: z.object({ payload: z.string(), why: z.string() }).optional(),
});
export type PersonState = z.infer<typeof PersonState>;

// ── Cards: the inline UI of a conversation ──────────────────────────────────

export const CardKind = z.enum([
  "approval", // the agent wants to do something and waits for a yes or no
  "question", // the agent needs an answer: choices, fields or both
  "connect", // sign in to an account or app; `url` opens the sign-in
  "secret", // fields the home stores and the model never reads
  "pairing", // a code and a QR to add a device
  "contact", // someone wants to connect, or shares an agent
  "info", // a result worth a card; never waits
]);
export type CardKind = z.infer<typeof CardKind>;

export const CardField = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["text", "secret", "choice", "multi"]),
  options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  /** What the field starts with. The person may change it; it is sent like a typed value. */
  value: z.union([z.string(), z.array(z.string())]).optional(),
});
export type CardField = z.infer<typeof CardField>;

export const CardAction = z.object({
  id: z.string(),
  label: z.string(),
  style: z.enum(["primary", "plain", "danger"]),
});
export type CardAction = z.infer<typeof CardAction>;

export const CardAnswer = z.object({
  action: z.string(),
  /** Field values by field id. A secret field reads "•••" here. */
  values: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  /** Device name or channel the answer came from. */
  by: z.string(),
  at: z.string(),
});
export type CardAnswer = z.infer<typeof CardAnswer>;

export const Card = z.object({
  id: z.string(),
  kind: CardKind,
  /** `needs_you` waits for the person and is listed under what needs you. */
  level: z.enum(["needs_you", "update"]),
  state: z.enum(["open", "answered", "expired"]),
  title: z.string(),
  /** Markdown. */
  body: z.string().optional(),
  fields: z.array(CardField).optional(),
  actions: z.array(CardAction),
  url: z.string().optional(),
  /** Text to draw as a QR code. */
  qr: z.string().optional(),
  answer: CardAnswer.optional(),
  agentId: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  createdAt: z.string(),
});
export type Card = z.infer<typeof Card>;

// ── Files ───────────────────────────────────────────────────────────────────

/** A file the person gave the home: a picture, a photo from the camera, a document. */
export const FileRef = z.object({
  id: z.string(),
  name: z.string(),
  /** The type the home found in the bytes, e.g. "image/jpeg". */
  mime: z.string(),
  size: z.number(),
});
export type FileRef = z.infer<typeof FileRef>;

// ── Messages ────────────────────────────────────────────────────────────────

export const Part = z.discriminatedUnion("type", [
  /** Markdown. Grows by `message.delta` while the message is streaming. */
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("card"), card: Card }),
  /** A file the person attached, or in an agent's message one the agent made. */
  z.object({ type: z.literal("file"), file: FileRef }),
  /** A document the chat opens beside itself. */
  z.object({ type: z.literal("document"), documentId: z.string(), title: z.string() }),
  /** An artifact the chat opens beside itself. */
  z.object({ type: z.literal("artifact"), artifactId: z.string(), title: z.string() }),
  /** One line about what the agent is doing. */
  z.object({
    type: z.literal("activity"),
    label: z.string(),
    state: z.enum(["running", "done", "failed"]),
  }),
]);
export type Part = z.infer<typeof Part>;

export const Message = z.object({
  id: z.string(),
  conversationId: z.string(),
  /**
   * `note` is a line no one is notified of: by the home itself, e.g. "Answered on your
   * watch", or what a quiet task's run leaves when nothing needs the person.
   */
  role: z.enum(["you", "agent", "note"]),
  agentId: z.string().optional(),
  channel: Channel,
  parts: z.array(Part),
  state: z.enum(["streaming", "done", "failed"]),
  /** Which model wrote it, e.g. "ollama:qwen3.8:27b-mlx". */
  model: z.string().optional(),
  /**
   * In a room: who wrote a message that is not the person's own. `kind` is set when it is an
   * agent, `of` then names whose agent it is.
   */
  from: z
    .object({ name: z.string(), kind: EngentyKind.optional(), of: z.string().optional() })
    .optional(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;

export const SendMessage = z.object({
  /** May be empty when files are attached. */
  text: z.string(),
  /** Ids of files uploaded before, in the order they are shown. */
  files: z.array(z.string()).max(FILES_PER_MESSAGE).optional(),
  /** The person spoke and listens: the agent answers short, in plain sentences. */
  spoken: z.boolean().optional(),
  /** Made by the device; the same id is stored once. */
  clientId: z.string().optional(),
  /** The person asks about a passage of a document of this conversation. */
  about: z.object({ documentId: z.string(), quote: z.string().min(1).max(4000) }).optional(),
});
export type SendMessage = z.infer<typeof SendMessage>;

/** An exchange a phone had with its own model while the home was out of reach. */
export const ImportMessages = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["you", "agent"]),
      text: z.string(),
      createdAt: z.string(),
      model: z.string().optional(),
      clientId: z.string(),
    }),
  ),
});
export type ImportMessages = z.infer<typeof ImportMessages>;

// ── Agents and conversations ────────────────────────────────────────────────

export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  kind: EngentyKind,
  about: z.string(),
  /**
   * `shared` agents live outside this home: in a contact's home, or as an outside agent.
   * `room` is no agent: a conversation of several people and agents, listed among the agents.
   * Its `from` is the handle of the home that keeps it, its `about` names who is in it.
   */
  origin: z.enum(["own", "shared", "room"]),
  /**
   * Where a shared agent is from: the handle of the person who shares it, e.g.
   * "anna@anna.example", or the host of an outside agent's card, e.g. "agents.example.com".
   */
  from: z.string().optional(),
  state: z.enum(["idle", "working", "needs_you"]),
  /** Open cards that wait for the person. */
  open: z.number(),
  /** The agent's one conversation with the person. */
  conversationId: z.string(),
  /** One line of the newest message in that conversation, "" when there is none. */
  preview: z.string(),
  /** Messages of the agent the person has not read. */
  unread: z.number(),
  /** When the conversation last changed. */
  updatedAt: z.string(),
  /** The first agent of a home. It cannot be removed. */
  main: z.boolean(),
});
export type Agent = z.infer<typeof Agent>;

/** When a scheduled task runs: once at a time, or again and again. Times are the home's local time. */
export const TimeRule = z.union([
  z.object({ at: z.string() }),
  z.object({ every: z.literal("hour") }),
  z.object({ every: z.enum(["day", "weekday"]), time: z.string() }),
  /** `weekday`: 0 is Sunday. */
  z.object({ every: z.literal("week"), time: z.string(), weekday: z.number() }),
]);
export type TimeRule = z.infer<typeof TimeRule>;

/** The event a task waits for. */
export const EventRule = z.discriminatedUnion("on", [
  /** A file is added or changed in a connected folder, or in `path` inside it. */
  z.object({ on: z.literal("folder"), folder: z.string(), path: z.string().optional() }),
  /** Mail arrives in the agent's mailbox that is not from the person, narrowed by sender or subject. */
  z.object({ on: z.literal("mail"), from: z.string().optional(), subject: z.string().optional() }),
  /** Another service posts to the task's own address. */
  z.object({ on: z.literal("webhook") }),
  /** A read-only tool of a connection answers differently than at the last look, every `minutes`. */
  z.object({
    on: z.literal("connection"),
    connection: z.string(),
    tool: z.string(),
    minutes: z.number(),
  }),
]);
export type EventRule = z.infer<typeof EventRule>;

/** What starts a task: a time or an event. */
export const TaskRule = z.union([TimeRule, EventRule]);
export type TaskRule = z.infer<typeof TaskRule>;

/**
 * Something an agent does by itself: at a time or when an event happens, it gets a turn with
 * `prompt`. Set, changed and removed in the conversation.
 */
export const Task = z.object({
  id: z.string(),
  /** What it does, in a few words for a list: "Morning look". */
  title: z.string(),
  /** What the agent is told when the task starts. */
  prompt: z.string(),
  rule: TaskRule,
  /** When it runs next, for a scheduled task. */
  nextAt: z.string().optional(),
  /** The agent tells the person only when something needs them, and leaves a note otherwise. */
  quiet: z.boolean(),
  /** Why the home paused it, when it did. A paused task does not run. */
  paused: z.string().optional(),
  /** When it last ran. */
  lastAt: z.string().optional(),
  /** How that run ended: with an answer, a note, a card that waits, or it failed. */
  last: z.enum(["answered", "note", "asked", "failed"]).optional(),
});
export type Task = z.infer<typeof Task>;

/** An agent with what it keeps and does: its memory, its tasks and what it works on right now. */
export const AgentDetail = z.object({
  agent: Agent,
  /** What the agent wrote down about the person and their work. "" for a shared agent. */
  memory: z.string(),
  /** Scheduled tasks first, the next one first; then the tasks that wait for an event. */
  tasks: z.array(Task),
  /**
   * While the agent works: what on, in one line ("" when it answers a message), and which
   * turn in a row of how many the home gives before the person has to say go on.
   */
  doing: z.object({ what: z.string(), turn: z.number(), turns: z.number() }).optional(),
});
export type AgentDetail = z.infer<typeof AgentDetail>;

export const Conversation = z.object({
  id: z.string(),
  agentId: z.string(),
  updatedAt: z.string(),
  preview: z.string(),
  unread: z.number(),
});
export type Conversation = z.infer<typeof Conversation>;

// ── Documents ───────────────────────────────────────────────────────────────

export const DocumentMeta = z.object({
  id: z.string(),
  title: z.string(),
  format: z.enum(["markdown"]),
  version: z.number(),
  updatedAt: z.string(),
  updatedBy: z.enum(["you", "agent"]),
  conversationId: z.string(),
});
export type DocumentMeta = z.infer<typeof DocumentMeta>;

export const Document = DocumentMeta.extend({ content: z.string() });
export type Document = z.infer<typeof Document>;

export const SaveDocument = z.object({
  content: z.string(),
  title: z.string().optional(),
  /** The version the edit started from. A newer one on the home answers 409. */
  baseVersion: z.number(),
});
export type SaveDocument = z.infer<typeof SaveDocument>;

/**
 * A passage of a document the person marked, with or without a comment. It is found again by
 * its text, so it stays with the passage when text around it changes, and is not shown while
 * the passage is gone. The text is as read, without Markdown.
 */
export const DocumentMark = z.object({
  id: z.string(),
  documentId: z.string(),
  quote: z.string(),
  /** Up to 32 characters before and after the passage: which one it is where it repeats. */
  before: z.string(),
  after: z.string(),
  /** "" for a mark without a comment. */
  comment: z.string(),
  createdAt: z.string(),
});
export type DocumentMark = z.infer<typeof DocumentMark>;

export const AddMark = z.object({
  quote: z.string().min(1).max(4000),
  before: z.string().max(32),
  after: z.string().max(32),
  comment: z.string().max(4000).default(""),
});
export type AddMark = z.input<typeof AddMark>;

// ── Artifacts ───────────────────────────────────────────────────────────────

/**
 * A page an agent wrote: a chart, a diagram, a 3D scene, a report on one page. The home
 * serves it closed off, so it reaches neither the home nor the network.
 */
export const ArtifactMeta = z.object({
  id: z.string(),
  title: z.string(),
  format: z.enum(["html"]),
  version: z.number(),
  updatedAt: z.string(),
  conversationId: z.string(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMeta>;

export const Artifact = ArtifactMeta.extend({
  /** The page as the agent wrote it: HTML with its own styles and scripts. */
  content: z.string(),
  /**
   * Path of the page as the home serves it, ready to show and to print. It carries a key
   * that opens this one page for an hour and needs no token. A device shows it in a
   * sandboxed frame and never puts `content` into a page of its own.
   */
  page: z.string(),
});
export type Artifact = z.infer<typeof Artifact>;

// ── Sharing ─────────────────────────────────────────────────────────────────

/** What leaves the home when it is shared: a document or an artifact. */
export const SharedKind = z.enum(["document", "artifact"]);
export type SharedKind = z.infer<typeof SharedKind>;

/** How long a published link works. `always`: until it is taken back. */
export const LinkLasts = z.enum(LINK_LASTS);
export type LinkLasts = z.infer<typeof LinkLasts>;

/**
 * A link anyone can open without a device token. It shows one document or one artifact,
 * read only, as it was when the link was made.
 */
export const PublishedLink = z.object({
  id: z.string(),
  kind: SharedKind,
  /** The id of the document or the artifact. */
  sourceId: z.string(),
  /** The version the link shows. A newer one stays in the home until a new link is made. */
  version: z.number(),
  title: z.string(),
  /** The whole address, at the home's own. */
  url: z.string(),
  /** Missing: the link works until it is taken back. */
  expiresAt: z.string().optional(),
  /** Whoever opens it is asked for a password first. */
  password: z.boolean(),
  createdAt: z.string(),
});
export type PublishedLink = z.infer<typeof PublishedLink>;

export const Publish = z.object({
  kind: SharedKind,
  id: z.string(),
  lasts: LinkLasts,
  /** Stored hashed. The home never gives it back. */
  password: z.string().min(LINK_PASSWORD_MIN).max(200).optional(),
});
export type Publish = z.infer<typeof Publish>;

/**
 * Who reaches the home's address: everyone (`internet`), devices on the same private network
 * (`network`), or this computer alone (`computer`). A link works only as far as that.
 */
export const Reach = z.enum(["internet", "network", "computer"]);
export type Reach = z.infer<typeof Reach>;

/** The links of one document or artifact that still work, newest first. */
export const PublishedLinks = z.object({ links: z.array(PublishedLink), reach: Reach });
export type PublishedLinks = z.infer<typeof PublishedLinks>;

/** A connected contact: another person's home this home sends to. */
export const Contact = z.object({ handle: z.string(), name: z.string() });
export type Contact = z.infer<typeof Contact>;

/** Sends a copy of a document or an artifact to a connected contact's home. */
export const SendToContact = z.object({ kind: SharedKind, id: z.string(), handle: z.string() });
export type SendToContact = z.infer<typeof SendToContact>;

// ── Secrets ─────────────────────────────────────────────────────────────────

/**
 * A key, token or password the person gave the home, as the settings list it: what uses it and
 * when it was set. Never its value.
 */
export const SecretEntry = z.object({
  /** The secret's name in the home, e.g. `connection.<id>.key`. */
  name: z.string(),
  /** What uses it. */
  kind: z.enum(["gateway", "account", "connection", "channel", "outside"]),
  /** The name of what uses it: the gateway, the connection, the channel, the outside agent. */
  label: z.string(),
  setAt: z.string(),
});
export type SecretEntry = z.infer<typeof SecretEntry>;

// ── Folders ─────────────────────────────────────────────────────────────────

/**
 * A folder of the home's computer the agents may use. The files stay where they are: the
 * home reads them in place and copies nothing.
 */
export const Folder = z.object({
  id: z.string(),
  /** How the agents and the person name it: the folder's own name, made unique. */
  name: z.string(),
  path: z.string(),
  /** `write`: agents may also change files, and ask before each change. */
  access: z.enum(["read", "write"]),
  createdAt: z.string(),
});
export type Folder = z.infer<typeof Folder>;

export const ConnectFolder = z.object({
  path: z.string().min(1),
  access: z.enum(["read", "write"]),
  /** The chat it was connected from: its agent is told and answers there. */
  conversationId: z.string().optional(),
});
export type ConnectFolder = z.infer<typeof ConnectFolder>;

/** What a folder holds, shown before it is connected. Counting stops at `FOLDER_PREVIEW_LIMIT` files. */
export const FolderPreview = z.object({
  path: z.string(),
  name: z.string(),
  files: z.number(),
  folders: z.number(),
  bytes: z.number(),
  /** The folder holds more than was counted. */
  more: z.boolean(),
});
export type FolderPreview = z.infer<typeof FolderPreview>;

/** The folders inside a path, for a path field that completes what is typed. */
export const FolderListing = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
});
export type FolderListing = z.infer<typeof FolderListing>;

// ── The person's avatar ─────────────────────────────────────────────────────

/**
 * How the person looks as a pixel figure. Every trait is one of a few named values, so a
 * model can read them off a selfie and a device can draw the figure without a picture.
 */
export const Avatar = z.object({
  skin: z.enum(["light", "fair", "medium", "tan", "brown", "dark"]),
  hair: z.object({
    style: z.enum([
      "bald",
      "buzz",
      "short",
      "side",
      "quiff",
      "curtains",
      "spiky",
      "mohawk",
      "curly",
      "afro",
      "bob",
      "long",
      "ponytail",
      "bun",
      "pigtails",
    ]),
    color: z.enum(["black", "brown", "chestnut", "blond", "red", "grey", "white", "blue", "pink"]),
  }),
  glasses: z.enum(["none", "round", "square", "shades"]),
  beard: z.enum(["none", "stubble", "moustache", "goatee", "full"]),
  hat: z.object({
    style: z.enum(["none", "cap", "beanie", "brim"]),
    color: z.enum(GARMENT_COLORS),
  }),
  top: z.object({
    style: z.enum(["tank", "tee", "sweater", "stripes", "shirt", "hoodie", "jacket"]),
    color: z.enum(GARMENT_COLORS),
  }),
  bottom: z.object({
    style: z.enum(["trousers", "wide", "shorts", "skirt", "longskirt"]),
    color: z.enum(GARMENT_COLORS),
  }),
  shoes: z.object({
    style: z.enum(["sneakers", "boots", "flats"]),
    color: z.enum(GARMENT_COLORS),
  }),
  accessory: z.object({
    style: z.enum(["none", "scarf", "tie", "headphones", "backpack", "earrings"]),
    color: z.enum(GARMENT_COLORS),
  }),
});
export type Avatar = z.infer<typeof Avatar>;

/** What a selfie became: the figure, and which model looked at the picture, and where. */
export const AvatarFromSelfie = z.object({
  avatar: Avatar,
  model: z.string(),
  where: z.string(),
});
export type AvatarFromSelfie = z.infer<typeof AvatarFromSelfie>;

// ── Home, devices, models ───────────────────────────────────────────────────

export const HomeInfo = z.object({
  protocol: z.number(),
  version: z.string(),
  /** The person's name as the agent uses it. */
  name: z.string(),
  /** `name@host` once the home has a public address. */
  handle: z.string().optional(),
  /** Ed25519 public key, base64url. */
  publicKey: z.string(),
});
export type HomeInfo = z.infer<typeof HomeInfo>;

export const Push = z.object({
  token: z.string(),
  environment: z.enum(["development", "production"]),
  /** Bundle id the token belongs to. */
  topic: z.string(),
});
export type Push = z.infer<typeof Push>;

export const PairRequest = z.object({
  code: z.string(),
  name: z.string(),
  kind: DeviceKind,
  push: Push.optional(),
});
export type PairRequest = z.infer<typeof PairRequest>;

/**
 * Something a device keeps and its own agent works on: a calendar, the reminders, the
 * contacts, a folder connected on the device, a service signed in on the device. The home knows only that it is there and what
 * the device's agent can do with it, never what it holds.
 */
export const DeviceResource = z.object({
  id: z.string(),
  kind: z.enum(["calendar", "reminders", "contacts", "folder", "connection"]),
  name: z.string(),
  /** `change`: the device's agent may also change it, after the person said yes on the device. */
  can: z.array(z.enum(["read", "change"])),
});
export type DeviceResource = z.infer<typeof DeviceResource>;

/**
 * Which of the person's agents may hand questions to a device, as the person said on the device.
 * An agent in neither list may ask; the device then asks the person first.
 */
export const DeviceAgents = z.object({
  allowed: z.array(z.string()).max(500),
  refused: z.array(z.string()).max(500),
});
export type DeviceAgents = z.infer<typeof DeviceAgents>;

export const Device = z.object({
  id: z.string(),
  name: z.string(),
  kind: DeviceKind,
  createdAt: z.string(),
  seenAt: z.string(),
  /** What the device offers its agents. Missing: the device has an agent of its own for none. */
  resources: z.array(DeviceResource).optional(),
  agents: DeviceAgents.optional(),
});
export type Device = z.infer<typeof Device>;

/** What a device says it offers, after each change on it. */
export const DeviceResources = z.object({
  resources: z.array(DeviceResource).max(200),
  agents: DeviceAgents.optional(),
});
export type DeviceResources = z.infer<typeof DeviceResources>;

/**
 * A question or a task one of the person's agents hands to the agent on a device. The device's
 * agent works on what the device keeps and sends back only the answer.
 */
export const Handoff = z.object({
  id: z.string(),
  deviceId: z.string(),
  agentId: z.string(),
  /** The name of the agent that asks, as the device shows it. */
  agentName: z.string(),
  conversationId: z.string(),
  text: z.string(),
  /** `declined`: the person did not let the agent ask this device, or said no to the task. */
  state: z.enum(["open", "answered", "declined"]),
  answer: z.string().optional(),
  /** Files the device sent with its answer, after the person said yes on the device. */
  files: z.array(FileRef).optional(),
  createdAt: z.string(),
  answeredAt: z.string().optional(),
});
export type Handoff = z.infer<typeof Handoff>;

export const AnswerHandoff = z.object({
  text: z.string().max(8000),
  /** Ids of files uploaded with `POST /v1/files`. */
  files: z.array(z.string()).max(10).optional(),
  declined: z.boolean().optional(),
});
export type AnswerHandoff = z.infer<typeof AnswerHandoff>;

export const PairResponse = z.object({ token: z.string(), device: Device, home: HomeInfo });
export type PairResponse = z.infer<typeof PairResponse>;

export const UpdateDevice = z.object({
  name: z.string().optional(),
  push: Push.nullable().optional(),
  /** Hours, local to the device, in which only `needs_you` is pushed. */
  quiet: z.object({ from: z.number(), to: z.number(), timezone: z.string() }).nullable().optional(),
});
export type UpdateDevice = z.infer<typeof UpdateDevice>;

export const ModelSource = z.object({
  id: z.string(),
  /** `subscription` is a signed-in app on a computer (Claude, Codex, Gemini). */
  kind: z.enum(["ollama", "subscription", "gateway"]),
  label: z.string(),
  /** Device name of the computer it runs on, or "the cloud" for a gateway. */
  where: z.string(),
  online: z.boolean(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  /**
   * The id of the service outside the person's own computers that reads what this source is
   * given (`ModelService`). Absent for a model on the person's own computers, such as Ollama.
   */
  service: z.string().optional(),
});
export type ModelSource = z.infer<typeof ModelSource>;

/**
 * A company whose models read what the person writes when the home uses them: Anthropic for
 * Claude, OpenAI for Codex, a gateway such as OpenRouter. The home sends nothing a device
 * gave it to a service in use until the person said yes to it.
 */
export const ModelService = z.object({
  /** "anthropic", "openai", "openrouter", "vercel", or a gateway's own id. */
  id: z.string(),
  /** The company, e.g. "Anthropic". */
  label: z.string(),
  /** The sources that send to it, e.g. ["Claude"]. */
  sources: z.array(z.string()),
  /** Whether the home would use one of its models now. */
  inUse: z.boolean(),
  /** When the person said yes, and on which device. Absent while there is no yes. */
  agreed: z.object({ at: z.string(), by: z.string() }).optional(),
});
export type ModelService = z.infer<typeof ModelService>;

export const Models = z.object({
  sources: z.array(ModelSource),
  /** Model refs `source:model` in the order the home tries them. Empty: the home picks. */
  order: z.array(z.string()),
  /** The model the next message would use. */
  current: z.string().optional(),
  /** The services in use and those the person said yes to. An older home sends none. */
  services: z.array(ModelService).default([]),
});
export type Models = z.infer<typeof Models>;

/** The services in use that wait for the person's yes. */
export const waitingForYes = (models: Pick<Models, "services">): ModelService[] =>
  models.services.filter((service) => service.inUse && !service.agreed);

/** What a device sends when the person said yes to services: their ids. */
export const AgreeToServices = z.object({ services: z.array(z.string()).min(1).max(20) });
export type AgreeToServices = z.infer<typeof AgreeToServices>;

// ── Setup ───────────────────────────────────────────────────────────────────

/**
 * One check of the setup: a model source answering a test call, or what the home has around
 * it (its address, its data folder, the connected folders, push, what it can do).
 * `absent`: not on this computer, nothing wrong. `untested`: no test call yet.
 */
export const SetupCheck = z.object({
  id: z.string(),
  kind: z.enum(["model", "address", "data", "folders", "push", "capability"]),
  label: z.string(),
  state: z.enum(["ok", "warning", "problem", "absent", "untested", "testing"]),
  /** What was found, in one sentence the person can act on. */
  said: z.string(),
  /** What to do about it, in one sentence. */
  todo: z.string().optional(),
  /** A command to run in a terminal on the home's computer, when that is the way. */
  command: z.string().optional(),
  /** For a model: the source and the model that was asked. */
  source: z.string().optional(),
  model: z.string().optional(),
  /** When the test call ran. */
  at: z.string().optional(),
});
export type SetupCheck = z.infer<typeof SetupCheck>;

export const Setup = z.object({
  /** The person went through the first start, or used the home before there was one. */
  done: z.boolean(),
  /** The person's name; `confirmed` once they said it, not only the computer's account. */
  name: z.object({ value: z.string(), confirmed: z.boolean() }),
  /** A model source answered its last test call. */
  working: z.boolean(),
  /** The home has a model it would ask, tested or not. */
  hasModel: z.boolean(),
  /** The home runs on wizards.bot: its models come from the account, not from this computer. */
  hosted: z.boolean().optional(),
  models: z.array(SetupCheck),
  home: z.array(SetupCheck),
  capabilities: z.array(SetupCheck),
});
export type Setup = z.infer<typeof Setup>;

export const ChangeSetup = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  done: z.boolean().optional(),
  /** The language the person reads; what the Bot Server writes for them is in it. */
  lang: z.enum(["en", "de"]).optional(),
});
export type ChangeSetup = z.infer<typeof ChangeSetup>;

/** Test calls again: all sources, or one. */
export const TestSetup = z.object({ source: z.string().optional() });
export type TestSetup = z.infer<typeof TestSetup>;

/** A gateway whose key card the home puts into the main agent's chat. */
export const SetupGateway = z.object({
  provider: z.enum(["openrouter", "vercel", "openai", "anthropic"]),
});
export type SetupGateway = z.infer<typeof SetupGateway>;

// ── Events ──────────────────────────────────────────────────────────────────

export const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.created"), message: Message }),
  /** Appends `text` to the text part at `part`. Not replayed after a reconnect. */
  z.object({
    type: z.literal("message.delta"),
    conversationId: z.string(),
    messageId: z.string(),
    part: z.number(),
    text: z.string(),
  }),
  z.object({ type: z.literal("message.updated"), message: Message }),
  z.object({ type: z.literal("card.updated"), card: Card }),
  z.object({ type: z.literal("agent.updated"), agent: Agent }),
  z.object({ type: z.literal("agent.removed"), agentId: z.string() }),
  z.object({ type: z.literal("document.updated"), document: DocumentMeta }),
  z.object({ type: z.literal("artifact.updated"), artifact: ArtifactMeta }),
  z.object({ type: z.literal("models.updated"), models: Models }),
  z.object({ type: z.literal("folders.updated"), folders: z.array(Folder) }),
  z.object({ type: z.literal("avatar.updated"), avatar: Avatar.nullable() }),
  /** The person's devices with what each offers, after a device said what it offers. */
  z.object({ type: z.literal("devices.updated"), devices: z.array(Device) }),
  /** Sent only to the device the hand-off is for. */
  z.object({ type: z.literal("handoff.updated"), handoff: Handoff }),
  /** A check of the setup changed: a test call started or ended. */
  z.object({ type: z.literal("setup.updated"), setup: Setup }),
  /** The device missed events: load agents, items and open conversations again. */
  z.object({ type: z.literal("reset") }),
]);
export type Event = z.infer<typeof Event>;

export const ErrorBody = z.object({
  error: z.string(),
  message: z.string(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
