import { useQueryClient } from "@tanstack/react-query";
import type { Agent, Event, Message, SearchHit } from "@wizards-bot/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AgentPane } from "./chat/AgentPane";
import { OpenArtifact } from "./chat/AppView";
import { ArtifactPane } from "./chat/ArtifactPane";
import { AvatarDialog } from "./chat/AvatarDialog";
import { Chat } from "./chat/Chat";
import { ConsentDialog } from "./chat/ConsentDialog";
import { DocumentPane } from "./chat/DocumentPane";
import { FolderDialog } from "./chat/FolderDialog";
import { FolderPane } from "./chat/FolderPane";
import { ItemsDialog } from "./chat/ItemsDialog";
import { NewBotDialog } from "./chat/NewBotDialog";
import { SearchDialog } from "./chat/SearchDialog";
import { type Asker, SettingsDialog } from "./chat/SettingsDialog";
import { Sidebar, SidebarDrawer } from "./chat/Sidebar";
import { Engenty } from "./engenty/Engenty";
import { api } from "./lib/api";
import { withConsent } from "./lib/consent";
import { applyEvent } from "./lib/events";
import { t } from "./lib/i18n";
import { keys } from "./lib/keys";
import {
  CHAT_MIN,
  PANE_MIN,
  SIDEBAR,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  sidebar,
  sidebarFits,
  split,
} from "./lib/layout";
import { toMac } from "./lib/mac";
import { useLingering } from "./lib/motion";
import { noticesOf, notify } from "./lib/notify";
import { useAgents, useAvatar, useItems, useSetup } from "./lib/queries";
import { setDeviceToken } from "./lib/session";
import { useStored } from "./lib/stored";
import { useEvents, useLink } from "./lib/stream";
import { uuid } from "./lib/uuid";
import { SetupView } from "./setup/SetupView";
import { needsSetup } from "./setup/steps";
import { cn } from "./ui";

const AGENT_KEY = "wizards.agent";

/** The dialog that is open over the chat. */
type Open = "settings" | "items" | "folder" | "avatar" | "search" | "new";

/** The agent whose chat was open last, kept per browser. */
function lastAgent(): string | null {
  try {
    return localStorage.getItem(AGENT_KEY);
  } catch {
    return null;
  }
}

const onResize = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};
const onVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/** The width an element has, as it changes. 0 before it is measured. */
function useWidth(ref: React.RefObject<HTMLElement | null>, key: unknown): number {
  const [width, setWidth] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` says the element is another one now
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, key]);
  return width;
}

/**
 * The line between two columns: the list and the chat, or the chat and what stands beside it.
 * The person drags it (the whole page shows the resize cursor and selects no text meanwhile),
 * or moves it with the arrow keys, Shift for larger steps; a double click gives the width back
 * to the app. After engenty wizards' splitter (apps/web/src/studio/EditorPage.tsx).
 */
function Divider({
  chat,
  least = CHAT_MIN,
  most,
  label = t("split.resize"),
  onChange,
  onReset,
  onDragging,
}: {
  /** The width of the column at the line's left. */
  chat: number;
  /** The narrowest it can get. */
  least?: number;
  /** The widest it can get. */
  most: number;
  label?: string;
  onChange: (chat: number) => void;
  onReset: () => void;
  /** True while a drag goes on, so the columns follow without their easing. */
  onDragging?: (dragging: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = chat;
    const move = (ev: PointerEvent) => onChange(startWidth + ev.clientX - startX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      setDragging(false);
      onDragging?.(false);
    };
    setDragging(true);
    onDragging?.(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a line the person moves is a separator with a value, which <hr> is not
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={least}
      aria-valuemax={most}
      aria-valuenow={Math.round(chat)}
      tabIndex={0}
      title={label}
      style={{ left: chat - 6 }}
      className="group absolute inset-y-0 z-10 w-3 cursor-col-resize touch-none outline-none"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const to = {
          ArrowLeft: chat - step,
          ArrowRight: chat + step,
          Home: least,
          End: most,
        }[e.key];
        if (to !== undefined) {
          e.preventDefault();
          onChange(to);
        } else if (e.key === "Enter") {
          onReset();
        }
      }}
    >
      {/* The line lights up under the pointer; the grip in its middle shows it can be moved. */}
      <span
        className={cn(
          "-translate-x-1/2 absolute inset-y-0 left-1/2 w-px transition group-hover:bg-ember/60 group-focus-visible:bg-ember",
          dragging && "bg-ember",
        )}
      />
      <span
        className={cn(
          "-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 h-8 w-1 rounded-full bg-ink-4/25 transition-all group-hover:bg-ember/70 group-focus-visible:bg-ember",
          dragging && "h-12 bg-ember",
        )}
      />
    </div>
  );
}

/**
 * The app of a paired browser: the agents at the left, the chat with one of them, and a
 * document or an artifact beside it. On a narrow window the agents open over the chat, and so
 * does the document.
 */
export function Home() {
  const client = useQueryClient();
  const link = useLink();
  const agents = useAgents();
  const items = useItems();
  const avatar = useAvatar();
  const setup = useSetup();
  const [agentId, setAgentId] = useState(lastAgent);
  const [documentId, setDocumentId] = useState<string | null>(null);
  // An artifact opens where a document opens, and so does what there is to know about the
  // agent: one of the three stands beside the chat.
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [about, setAbout] = useState(false);
  // A connected folder in the file browser, at a place inside it.
  const [folderView, setFolderView] = useState<{ id: string; path: string } | null>(null);
  const [reference, setReference] = useState<{ text: string; at: number }>();
  const [dialog, setDialog] = useState<Open | null>(null);
  /** The chat the folder dialog was opened from; none from the settings. */
  const [folderFrom, setFolderFrom] = useState<string>();
  // A dialog that gives way to another one also reports that it closed: only the one that is
  // open closes anything.
  const close = useMemo(() => {
    const only = (name: Open) => () => setDialog((open) => (open === name ? null : open));
    return {
      settings: only("settings"),
      items: only("items"),
      folder: only("folder"),
      avatar: only("avatar"),
    };
  }, []);

  // The list of agents: open where the window has room and the person did not close it.
  const windowWidth = useSyncExternalStore(onResize, () => window.innerWidth);
  const [collapsed, setCollapsed] = useStored("wizards.agents.closed", false);
  // The open list's width, as the person dragged it; the app's own until then.
  const [listChosen, setListChosen] = useStored<number | null>("wizards.agents.width", null);
  const listWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, listChosen ?? SIDEBAR));
  const [resizingList, setResizingList] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const pane = Boolean(documentId || artifactId || about || folderView);
  const side = sidebar(windowWidth, pane, collapsed);
  // ⌘K (Ctrl+K) opens the search, wherever the focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !(e.shiftKey || e.altKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog((open) => (open === "search" ? null : "search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (side === "open") {
      setDrawer(false);
    }
  }, [side]);

  // The chat and what stands beside it share what the list of agents leaves.
  const main = useRef<HTMLDivElement>(null);
  const agent = agents.data?.find((a) => a.id === agentId) ?? agents.data?.[0];
  // The column is measured once it stands: after the setup, which stands in its place first.
  const inSetup = Boolean(setup.data && needsSetup(setup.data));
  const width = useWidth(main, Boolean(agent) && !inSetup);
  const [chosen, setChosen] = useStored<number | null>("wizards.chat.width", null);
  // What stands beside the chat stays for its way out after it was closed.
  const standing = useLingering(
    documentId
      ? `document:${documentId}`
      : artifactId
        ? `artifact:${artifactId}`
        : folderView
          ? `folder:${folderView.id}`
          : about
            ? "agent:about"
            : null,
    180,
  );
  const parts = standing.value ? split(width, chosen) : null;
  const beside = parts && parts !== "over" ? parts : null;

  // While the page is not in front, a card that waits and a finished answer are told.
  const onEvent = useCallback(
    (event: Event) => {
      const all = client.getQueryData<Agent[]>(keys.agents()) ?? [];
      notify(noticesOf(event, (id) => all.find((a) => a.id === id)?.name ?? "wizards.bot"));
    },
    [client],
  );
  useEvents(client, onEvent);

  const waiting = items.data?.length ?? 0;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) wizards.bot` : "wizards.bot";
    void toMac({ type: "waiting", count: waiting });
  }, [waiting]);

  // What the agent wrote into the chat that is open and in front is read.
  const visible = useSyncExternalStore(onVisibility, () => document.visibilityState === "visible");
  const unread = agent && agent.state !== "working" ? agent.unread : 0;
  const conversationId = agent?.conversationId;
  useEffect(() => {
    if (visible && unread && conversationId) {
      void api.post(`/v1/conversations/${conversationId}/read`).catch(() => undefined);
    }
  }, [visible, unread, conversationId]);

  // A home nobody set up, or one without a model, opens on its setup instead of the chat.
  if (inSetup && setup.data) {
    return (
      <>
        <SetupView setup={setup.data} />
        <ConsentDialog />
      </>
    );
  }

  // The agent picked last, or the main agent when that one is gone.
  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <Engenty kind="round" size={56} />
        {link === "away" || agents.error ? (
          <p role="status" className="max-w-xs text-[0.875rem] text-ink-3">
            {link === "away" ? t("home.away") : agents.error?.message}
          </p>
        ) : null}
      </div>
    );
  }

  const pick = (picked: Agent) => {
    setAgentId(picked.id);
    try {
      localStorage.setItem(AGENT_KEY, picked.id);
    } catch {
      // The pick lasts for this visit then.
    }
    setDocumentId(null);
    setArtifactId(null);
    setAbout(false);
    setFolderView(null);
    setDialog(null);
    setDrawer(false);
  };
  const signOut = async () => {
    await api.del("/v1/device").catch(() => undefined);
    setDeviceToken(null);
  };
  const settings = () => {
    setDrawer(false);
    setDialog("settings");
  };
  // What the settings hand the main agent: it is said in its chat, and that chat is shown.
  const mainAgent = agents.data?.find((a) => a.main);
  const asker: Asker | undefined = mainAgent && {
    name: mainAgent.name,
    ask: async (text) => {
      const { message } = await withConsent(
        () =>
          api.post<{ message: Message }>(`/v1/conversations/${mainAgent.conversationId}/messages`, {
            text,
            clientId: uuid(),
          }),
        (models) => client.setQueryData(keys.models(), models),
      );
      applyEvent(client, { type: "message.created", message });
      pick(mainAgent);
    },
  };
  // Where the list fits, it opens beside the chat and stays; where not, over the chat.
  const openList = () => (sidebarFits(windowWidth, pane) ? setCollapsed(false) : setDrawer(true));
  const list = (rail: boolean) => (
    <Sidebar
      agents={agents.data ?? []}
      current={agent}
      avatar={avatar.data ?? null}
      rail={rail}
      onPick={pick}
      onSearch={() => {
        setDrawer(false);
        setDialog("search");
      }}
      onNew={() => {
        setDrawer(false);
        setDialog("new");
      }}
      onSettings={settings}
      onAvatar={() => {
        setDrawer(false);
        setDialog("avatar");
      }}
      onSignOut={() => void signOut()}
    />
  );

  const [paneKind, paneId] = (standing.value ?? "").split(/:(.*)/);
  const paneProps = { over: !beside, leaving: standing.leaving };

  return (
    <div className="relative flex h-full">
      <div
        className={cn(
          "side-slot h-full shrink-0 overflow-hidden bg-paper",
          side === "none" ? "w-0" : "border-border-soft border-r",
          side === "rail" && "w-16",
        )}
        // While the edge is dragged the list follows the pointer at once: the slot's easing
        // (app.css, outside Tailwind's layers) is switched off right on the element.
        style={
          side === "open"
            ? { width: listWidth, ...(resizingList ? { transition: "none" } : {}) }
            : undefined
        }
      >
        {side === "open" ? (
          <div className="h-full" style={{ width: listWidth }}>
            {list(false)}
          </div>
        ) : side === "rail" ? (
          list(true)
        ) : null}
      </div>
      {side === "open" ? (
        <Divider
          chat={listWidth}
          least={SIDEBAR_MIN}
          most={SIDEBAR_MAX}
          label={t("agents.resize")}
          onChange={(width) =>
            setListChosen(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width))))
          }
          onReset={() => setListChosen(null)}
          onDragging={setResizingList}
        />
      ) : null}
      <SidebarDrawer open={drawer} onClose={() => setDrawer(false)}>
        {side === "open" ? null : list(false)}
      </SidebarDrawer>
      <div ref={main} className="relative flex h-full min-w-0 flex-1">
        {/* The chat on a lighter ground than the list beside it. */}
        <div className="h-full min-w-0 flex-1 bg-card">
          <OpenArtifact.Provider value={artifactId}>
            <Chat
              agent={agent}
              items={items.data ?? []}
              link={link}
              onAgents={side === "none" ? () => setDrawer(true) : undefined}
              onList={side === "rail" ? openList : undefined}
              onHideList={side === "open" ? () => setCollapsed(true) : undefined}
              onAgent={() => {
                setDocumentId(null);
                setArtifactId(null);
                setFolderView(null);
                setAbout((open) => !open);
              }}
              unread={(agents.data ?? []).some((a) => a.id !== agent.id && (a.unread || a.open))}
              onItems={() => setDialog("items")}
              onDocument={(id) => {
                setArtifactId(null);
                setAbout(false);
                setFolderView(null);
                setDocumentId(id);
              }}
              onArtifact={(id) => {
                setDocumentId(null);
                setAbout(false);
                setFolderView(null);
                setArtifactId(id);
              }}
              reference={reference}
              onFolder={() => {
                setFolderFrom(agent.conversationId);
                setDialog("folder");
              }}
            />
          </OpenArtifact.Provider>
        </div>
        {beside && !standing.leaving ? (
          <Divider
            chat={beside.chat}
            most={width - PANE_MIN}
            onChange={(chat) => setChosen(Math.min(Math.max(chat, CHAT_MIN), width - PANE_MIN))}
            onReset={() => setChosen(null)}
          />
        ) : null}
        {paneId ? (
          // Beside the chat, a column that opens and closes; over it, the pane places itself.
          // The same elements either way, so a text being edited survives a turned tablet.
          <div
            className={beside ? "pane-slot h-full shrink-0 overflow-hidden" : "contents"}
            style={beside ? { width: beside.pane } : undefined}
            data-leaving={standing.leaving || undefined}
          >
            <div
              className={beside ? "h-full" : "contents"}
              style={beside ? { width: beside.pane } : undefined}
            >
              {paneKind === "document" ? (
                <DocumentPane
                  key={paneId}
                  id={paneId}
                  {...paneProps}
                  onClose={() => setDocumentId(null)}
                />
              ) : paneKind === "artifact" ? (
                <ArtifactPane
                  key={paneId}
                  id={paneId}
                  {...paneProps}
                  onClose={() => setArtifactId(null)}
                />
              ) : paneKind === "folder" ? (
                <FolderPane
                  key={paneId}
                  id={paneId}
                  start={folderView?.path ?? ""}
                  {...paneProps}
                  onAsk={(text) => setReference({ text, at: Date.now() })}
                  onClose={() => setFolderView(null)}
                />
              ) : (
                <AgentPane
                  key={agent.id}
                  agent={agent}
                  {...paneProps}
                  onFolder={() => {
                    setFolderFrom(agent.conversationId);
                    setDialog("folder");
                  }}
                  onOpenFolder={(id) => {
                    setAbout(false);
                    setFolderView({ id, path: "" });
                  }}
                  onClose={() => setAbout(false)}
                />
              )}
            </div>
          </div>
        ) : null}
      </div>
      <NewBotDialog open={dialog === "new"} onClose={() => setDialog(null)} asker={asker} />
      <SearchDialog
        open={dialog === "search"}
        onClose={() => setDialog(null)}
        agents={agents.data ?? []}
        asker={asker}
        onOpen={(hit: SearchHit) => {
          const found = (agents.data ?? []).find((a) => a.id === hit.agentId);
          if (found) pick(found);
          if (hit.kind === "document") setDocumentId(hit.id);
          if (hit.kind === "artifact") setArtifactId(hit.id);
        }}
      />
      <SettingsDialog
        open={dialog === "settings"}
        onFolder={() => {
          setFolderFrom(undefined);
          setDialog("folder");
        }}
        asker={asker}
        onClose={close.settings}
      />
      <ItemsDialog open={dialog === "items"} items={items.data ?? []} onClose={close.items} />
      <FolderDialog open={dialog === "folder"} conversationId={folderFrom} onClose={close.folder} />
      <AvatarDialog open={dialog === "avatar"} saved={avatar.data ?? null} onClose={close.avatar} />
      <ConsentDialog />
    </div>
  );
}
