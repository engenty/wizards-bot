import { join } from "node:path";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";

/** Messages of a conversation an agent reads as they are. */
export const LAST_MESSAGES = 40;

/**
 * Mastra's side of the home: its own libSQL file beside the home's database, the memory
 * that keeps each conversation as a thread (thread id = conversation id, resource = the
 * agent), tool calls and their results included, and the instance the agents run in.
 */
export class HomeMastra {
  readonly storage: LibSQLStore;
  readonly memory: Memory;
  /** Where the home's agents are registered, so that signals reach them. */
  readonly instance: Mastra;

  constructor(dataDir: string) {
    this.storage = new LibSQLStore({ id: "home", url: `file:${join(dataDir, "mastra.db")}` });
    this.memory = new Memory({ storage: this.storage, options: { lastMessages: LAST_MESSAGES } });
    this.instance = new Mastra({ storage: this.storage, logger: false });
  }

  /**
   * Writes a message into a conversation's thread that no agent run produced: what a phone
   * wrote with its own model while the home was out of reach.
   */
  async append(input: {
    conversationId: string;
    agentId: string;
    role: "user" | "assistant";
    text: string;
    id: string;
    createdAt: Date;
  }): Promise<void> {
    const thread = await this.memory.getThreadById({ threadId: input.conversationId });
    if (!thread) {
      await this.memory.createThread({ threadId: input.conversationId, resourceId: input.agentId });
    }
    await this.memory.saveMessages({
      messages: [
        {
          id: input.id,
          role: input.role,
          createdAt: input.createdAt,
          threadId: input.conversationId,
          resourceId: input.agentId,
          content: { format: 2, parts: [{ type: "text", text: input.text }] },
        },
      ],
    });
  }

  /** Forgets a conversation, when its agent is removed. */
  async forget(conversationId: string): Promise<void> {
    await this.memory.deleteThread(conversationId).catch(() => {});
  }

  close(): void {
    void this.storage.close().catch(() => {});
  }
}
