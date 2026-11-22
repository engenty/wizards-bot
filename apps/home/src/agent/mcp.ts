import type { Draft } from "./draft.ts";
import { type Asking, inputSchemaOf, runTool, type Tool } from "./tool.ts";

interface Entry {
  tools: Tool[];
  /** The message the tools' activity lines go into. A call without tools has none. */
  draft?: Draft;
  /** How a tool of this turn asks the person. The client is told to end its turn. */
  asking?: Asking;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * The home's tools over MCP, for a client that steps by itself (Claude, Codex). Each turn
 * gets a token; it opens exactly that turn's tools and stops working when the turn ends.
 */
export class McpTurns {
  private readonly entries = new Map<string, Entry>();

  open(token: string, entry: Entry): void {
    this.entries.set(token, entry);
  }

  close(token: string): void {
    this.entries.delete(token);
  }

  /** Answers one JSON-RPC message. `undefined` for a notification, which gets no answer. */
  async handle(token: string, request: RpcRequest): Promise<unknown | undefined> {
    const entry = this.entries.get(token);
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code, message },
    });
    if (!entry) return fail(-32001, "This turn is over.");
    if (request.id === undefined || request.id === null) return undefined;
    switch (request.method) {
      case "initialize":
        return reply({
          protocolVersion: String(request.params?.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: {} },
          serverInfo: { name: "home", version: "1" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: entry.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: inputSchemaOf(tool),
          })),
        });
      case "tools/call": {
        const name = String(request.params?.name ?? "");
        const tool = entry.tools.find((candidate) => candidate.name === name);
        if (!tool)
          return reply({
            content: [{ type: "text", text: `Unknown tool ${name}.` }],
            isError: true,
          });
        if (!entry.draft)
          return reply({ content: [{ type: "text", text: "No tools here." }], isError: true });
        const { text, pictures, failed } = await runTool(
          tool,
          request.params?.arguments,
          entry.draft,
          entry.asking,
        );
        return reply({
          content: [
            { type: "text", text },
            ...pictures.map((picture) => ({
              type: "image",
              data: picture.base64,
              mimeType: picture.mime,
            })),
          ],
          ...(failed ? { isError: true } : {}),
        });
      }
      default:
        return fail(-32601, `Unknown method ${request.method}.`);
    }
  }
}
