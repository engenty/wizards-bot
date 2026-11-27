import type { CallOptions, StreamPart } from "@engenty/model-providers/ollama";
import type { ModelSource } from "@wizards-bot/protocol";
import type { ClientEvent, ClientTurn } from "../models/client-model.ts";

// What a home and a linked computer of the same person say to each other over one
// WebSocket. The computer dials out, so it needs no address of its own. The home asks it
// for one answer of a model (the home steps, the computer's model writes) or for a whole
// turn of an installed client.

/** A model call as it travels: everything but the signal that stops it. */
export type RelayedCall = Omit<CallOptions, "abortSignal" | "headers">;

export type ToComputer =
  | { t: "model.stream"; id: string; source: string; model: string; options: RelayedCall }
  | {
      t: "client.run";
      id: string;
      source: string;
      turn: Omit<ClientTurn, "signal">;
    }
  | { t: "cancel"; id: string };

export type ToHome =
  | { t: "sources"; sources: ModelSource[] }
  | { t: "model.part"; id: string; part: StreamPart }
  | { t: "model.end"; id: string }
  | { t: "client.event"; id: string; event: ClientEvent }
  | { t: "client.done"; id: string }
  | { t: "error"; id: string; message: string };
