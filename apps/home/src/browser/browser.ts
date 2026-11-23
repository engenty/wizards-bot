import { AgentPages } from "@engenty/browser";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";

// The agents' browser: `@engenty/browser` (shared with engenty wizards), one headless Chrome
// session per conversation. The home turns its tools into the person's agents' tools and runs
// every answer through the Vault's redactor, so a value the Vault entered on a page never
// reaches the model. `WIZARDS_BOT_CHROME` names a Chrome to start; `WIZARDS_BOT_BROWSER_HEADED=1`
// shows its window.

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
        run: async (input) =>
          this.home.vault.redact(threadId, JSON.stringify(await tool.run(threadId, input))),
      }),
    );
  }

  async stop(): Promise<void> {
    await this.pages.close();
  }
}
