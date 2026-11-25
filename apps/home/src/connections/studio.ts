import { AsyncLocalStorage } from "node:async_hooks";
import { RequestContext } from "@mastra/core/request-context";
import type { MastraFetchLike } from "@mastra/mcp";
import type { Space } from "@wizards-bot/protocol";
import { z } from "zod";
import type { Home } from "../home.ts";

// The studio the team works in is a connection the home keeps by itself: the MCP endpoint the
// Manage-App names (docs/hosted.md, Contract 10). It has no key and no sign-in of its own. Every
// request to it carries a token of the person the turn is for, which the Manage-App gives the
// home for ten minutes (Contract 12). Mastra's MCP client takes a `fetch` for each server and
// hands it the request context of the tool call that makes the request; that is where the
// person comes from. Connecting and reading a view have no request context in Mastra: the home
// names the person around them (`as`).

/** The name of the studio's connection, as the agent reads it. */
export const STUDIO = "studio";

/** The key of the person a call is for, in the request context of a tool call. */
const PERSON = "person";
/** A token is asked for anew this long before it ends. */
const EARLY_MS = 60_000;

/** What the Manage-App answers: the token and when it ends. */
const Token = z.object({ token: z.string().min(1), expiresAt: z.iso.datetime({ offset: true }) });

/** The studio is not reached. The message is for the agent to read. */
export class StudioRefused extends Error {}

const NO_ANSWER = "The studio does not answer for you right now. Nothing was called.";
const NEEDS_PERSON =
  "The studio is used as the person who writes, and nobody wrote here: a task or an event started this. Nothing was called. Say that someone of the team has to ask for it in the chat.";
/** What the home itself says when the studio is not reached. */
export const STUDIO_SAYS = [NO_ANSWER, NEEDS_PERSON] as const;

export class Studio {
  private readonly home: Home;
  /** Each person's token while it lives; "" is the one person of a home that is no group's. */
  private readonly tokens = new Map<string, { token: string; until: number }>();
  /** The tokens being asked for, so that one person is asked for once at a time. */
  private readonly asking = new Map<string, Promise<string>>();
  /** The person of what Mastra's client does without a request context. */
  private readonly around = new AsyncLocalStorage<string | undefined>();

  constructor(home: Home) {
    this.home = home;
  }

  /** The request context of one tool call: who it is for. */
  context(person: string | undefined): RequestContext {
    return new RequestContext(person ? [[PERSON, person]] : []);
  }

  /** Runs what Mastra's client does without a request context as one person. */
  as<T>(person: string | undefined, run: () => Promise<T>): Promise<T> {
    return this.around.run(person, run);
  }

  /**
   * Throws where the studio cannot be used: a group home calls it as someone, and a turn nobody
   * wrote (a task, an event) is no one's.
   */
  needs(person: string | undefined): void {
    if (this.home.group.isGroup() && !person) throw new StudioRefused(NEEDS_PERSON);
  }

  /** How Mastra's client reaches the studio: each request with the token of its person. */
  readonly fetch: MastraFetchLike = async (url, init, requestContext) => {
    const person = (requestContext?.get(PERSON) as string | undefined) ?? this.around.getStore();
    this.needs(person);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${await this.token(person)}`);
    const response = await fetch(url, { ...init, headers });
    // The studio takes the token no more: the next request asks for a new one.
    if (response.status === 401) this.tokens.delete(person ?? "");
    return response;
  };

  /** The person's token for the studio, asked for once while it lives. */
  private token(person: string | undefined): Promise<string> {
    const who = person ?? "";
    const kept = this.tokens.get(who);
    if (kept && kept.until - EARLY_MS > Date.now()) return Promise.resolve(kept.token);
    const running = this.asking.get(who);
    if (running) return running;
    const asked = this.ask(person).finally(() => this.asking.delete(who));
    this.asking.set(who, asked);
    return asked;
  }

  private async ask(person: string | undefined): Promise<string> {
    const { config, models, hosted } = this.home;
    const key = models.accountKey();
    if (!config.manageUrl || !key) throw new StudioRefused(NO_ANSWER);
    let answer: unknown;
    try {
      const response = await hosted.fetch(`${config.manageUrl}/v1/homes/studio-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        // A home of one person names nobody: the Manage-App knows whose it is.
        body: JSON.stringify(person ? { person } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(String(response.status));
      answer = await response.json();
    } catch {
      throw new StudioRefused(NO_ANSWER);
    }
    const parsed = Token.safeParse(answer);
    if (!parsed.success) throw new StudioRefused(NO_ANSWER);
    const { token, expiresAt } = parsed.data;
    this.tokens.set(person ?? "", { token, until: Date.parse(expiresAt) });
    return token;
  }

  /** Forgets every token: the studio is another one, or gone. */
  forget(): void {
    this.tokens.clear();
  }
}

/**
 * A call's arguments with the space that is open in the studio, where the tool takes a space
 * and the arguments name none.
 */
export function inSpace(
  args: Record<string, unknown>,
  inputSchema: unknown,
  space: Space | undefined,
): Record<string, unknown> {
  if (!space || args.spaceId !== undefined) return args;
  const properties = (inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return properties && "spaceId" in properties ? { ...args, spaceId: space.id } : args;
}

/** What the agent reads about the studio's open space, in one line. */
export function spaceLine(space: Space | undefined): string {
  return space
    ? `[home] In the studio the space "${space.name.replace(/["\s]+/g, " ").trim()}" is open: the tools of ${STUDIO} work in it unless you name another space.`
    : `[home] No space of the studio is open here: before a tool of ${STUDIO} that works in a space, read \`list_spaces\`. With one space, use it; with several, ask which one.`;
}
