import { AgentPages } from "@engenty/browser";
import type { StepObject } from "@wizards-bot/protocol";
import { pageUrl } from "../agent/steps.ts";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";

// The agents' browser: `@engenty/browser` (shared with engenty wizards), one headless Chrome
// session per conversation. The home turns its tools into the person's agents' tools and runs
// every answer through the Vault's redactor, so a value the Vault entered on a page never
// reaches the model. `WIZARDS_BOT_CHROME` names a Chrome to start; `WIZARDS_BOT_BROWSER_HEADED=1`
// shows its window.

/** The page a tool's answer is from, where it says so. */
function pageOf(answer: string | undefined): StepObject | undefined {
  if (!answer) return;
  const { url, title } = JSON.parse(answer) as { url?: unknown; title?: unknown };
  const page = pageUrl(url);
  return page ? { url: page, ...(typeof title === "string" ? { name: title } : {}) } : undefined;
}

export class Browser {
  readonly pages: AgentPages;
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    this.pages = new AgentPages({
      executablePath: process.env.WIZARDS_BOT_CHROME || undefined,
      headless: process.env.WIZARDS_BOT_BROWSER_HEADED !== "1",
    });
    home.addTools((context) => this.tools(context));
  }

  tools(context: TurnContext): Tool[] {
    const threadId = context.conversationId;
    return this.pages.tools().map((tool) =>
      defineTool({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        label: () => tool.name.replace("browser_", "Browser: "),
        object: (input, answer) => {
          const url = pageUrl(input.url);
          return pageOf(answer) ?? (url ? { url } : undefined);
        },
        run: async (input) => {
          const result = await tool.run(threadId, input);
          const answer = this.home.vault.redact(threadId, JSON.stringify(result));
          // A page that did not open is a failed step; the model reads why.
          if (tool.name === "browser_open" && (result as { success?: boolean })?.success === false)
            throw new Error(answer);
          return answer;
        },
      }),
    );
  }

  async stop(): Promise<void> {
    await this.pages.close();
  }
}
