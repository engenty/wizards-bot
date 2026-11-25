// The numbers and lists a device needs at run time. They stand apart from the shapes, so a
// web page can import them without the schema library.

/** Most files one message carries. */
export const FILES_PER_MESSAGE = 10;
/** Largest file the home takes, in bytes: 15 MB as computers count them. */
export const FILE_LIMIT = 15 * 1024 * 1024;
/** Where counting a folder stops before it is connected. */
export const FOLDER_PREVIEW_LIMIT = 5000;

/** The `action` of an answer to a question that is a message of the person. */
export const REPLY_ACTION = "reply";
/** The `action` of an answer that comes from a card's view rather than one of its actions. */
export const VIEW_ANSWER = "view";
/** The most a view's answer may weigh, in bytes of its JSON: the form's values. */
export const VIEW_STATE_LIMIT = 64 * 1024;
/** The value of a form's field where the person says they don't know. */
export const UNSURE = "unsure";

/** How long a published link can work. `always`: until it is taken back. */
export const LINK_LASTS = ["hour", "day", "week", "month", "always"] as const;
/** Fewest characters of a published link's password. */
export const LINK_PASSWORD_MIN = 4;

/** Most agents in one room. */
export const ROOM_AGENTS = 6;
/** Messages agents may write in a room after a person's message, before a person has to write again. */
export const ROOM_AGENT_TURNS = 8;
/** Longest message a room takes, in characters. */
export const ROOM_MESSAGE_LIMIT = 20_000;

/** The colours a figure's clothes come in. */
export const GARMENT_COLORS = [
  "white",
  "black",
  "grey",
  "navy",
  "blue",
  "teal",
  "green",
  "olive",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
  "brown",
  "beige",
] as const;
