import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * The host of a connection's view (MCP Apps). The home serves it closed off, at
 * `/v1/artifacts/:id/host?until&key`, and a device frames it as it frames any artifact's page.
 * It frames the view (`/v1/artifacts/:id/page`, same key), hands it the call it shows and relays
 * what the view asks: the same connection's tools, what it tells the agent and a message as the
 * person go to the home with the artifact's key; a link and the view's height go to the frame
 * around this page (the web app), or to the iOS app's `app` script message handler.
 */

const here = new URL(window.location.href);
const base = here.pathname.replace(/\/host$/, "");
const route = (path: string) => `${base}/${path}${here.search}`;
/** `inline` in the chat, the whole pane otherwise. */
const inline = here.searchParams.get("mode") === "inline";

type Outward = { type: "open-link"; url: string } | { type: "size"; height: number };

/** Tells the device: the frame around this page, or the iOS app. */
function tell(message: Outward): void {
  const ios = (
    window as unknown as {
      webkit?: { messageHandlers?: { app?: { postMessage(value: unknown): void } } };
    }
  ).webkit?.messageHandlers?.app;
  if (ios) ios.postMessage(message);
  else if (window.parent !== window)
    window.parent.postMessage({ source: "wizards-app", ...message }, "*");
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(route(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function problem(text: string): void {
  document.body.replaceChildren(Object.assign(document.createElement("p"), { textContent: text }));
}

async function start(): Promise<void> {
  const answered = await fetch(route("app/call")).catch(() => undefined);
  if (!answered?.ok) return problem("This view is not open any more. Open it from the chat again.");
  const call = (await answered.json()) as {
    title?: string;
    tool: string;
    input: Record<string, unknown>;
    result: Record<string, unknown>;
  };
  document.title = call.title ?? "View";

  const frame = document.createElement("iframe");
  frame.title = call.title ?? "View";
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.src = route("page");
  document.body.append(frame);
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  const view = frame.contentWindow;
  if (!view) return problem("The view could not be shown.");

  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const bridge = new AppBridge(
    null,
    { name: "wizards.bot", version: "1" },
    { openLinks: {}, serverTools: {}, logging: {} },
    {
      hostContext: {
        theme: dark ? "dark" : "light",
        displayMode: inline ? "inline" : "fullscreen",
        availableDisplayModes: ["inline", "fullscreen"],
        locale: navigator.language,
        containerDimensions: inline
          ? { width: window.innerWidth, maxHeight: 420 }
          : { width: window.innerWidth, height: window.innerHeight },
      },
    },
  );
  bridge.oncalltool = async (params) => {
    const response = await post("app/tool", {
      name: params.name,
      arguments: params.arguments ?? {},
    });
    if (!response.ok)
      return { content: [{ type: "text", text: "The tool could not be used." }], isError: true };
    return response.json();
  };
  bridge.onopenlink = async ({ url }) => {
    if (/^https?:\/\//i.test(url)) tell({ type: "open-link", url });
    return {};
  };
  bridge.onmessage = async (params) => {
    const text = (params.content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
    if (text) await post("app/message", { text });
    return {};
  };
  bridge.onupdatemodelcontext = async (params) => {
    const text = (params.content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
    if (text) await post("app/context", { text: text.slice(0, 4000) });
    return {};
  };
  bridge.onsizechange = ({ height }) => {
    if (typeof height === "number") tell({ type: "size", height });
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    // The pane is the whole view; in the chat the device opens it there.
    if (mode === "fullscreen" && inline) tell({ type: "open-link", url: "wizards-app:pane" });
    return { mode: inline ? "inline" : "fullscreen" };
  };
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: call.input });
    void bridge.sendToolResult(call.result as never);
  };
  await bridge.connect(new PostMessageTransport(view, view));
}

void start();
