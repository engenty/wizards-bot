import { DEFAULT_AVATAR } from "@wizards-bot/avatar";
import type { Agent, Avatar } from "@wizards-bot/protocol";
import { LogOut, Plus, Search, Settings, Smile } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { lang, t } from "../lib/i18n";
import { useHome, useThisDevice } from "../lib/queries";
import { when } from "../lib/time";
import { LangSwitch, ThemeSwitch } from "../setup/Frame";
import { cn, IconButton } from "../ui";
import { Menu } from "../ui/Menu";
import { StackedAvatar } from "../ui/StackedAvatar";
import { Face } from "./Face";

/**
 * Which Bot Server this is, as the person knows it: its host where it has a name of its own
 * (`ada.wizards.bot`), "Your Bot Server" where it is reached at an address of the network.
 */
export function botServerName(host = location.hostname, full = location.host): string {
  const numeric = /^[\d.]+$/.test(host) || host.includes(":") || host === "localhost";
  return numeric ? t("you.botServer") : full;
}

/** The main agent first, then whoever was written with last. */
function inOrder(agents: Agent[]): Agent[] {
  return [...agents].sort(
    (a, b) => Number(b.main) - Number(a.main) || b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** What an agent's line says below its name. */
function lineOf(agent: Agent): string {
  if (agent.state === "working") {
    return `${t("agents.working")}…`;
  }
  if (agent.preview) {
    return agent.preview;
  }
  return agent.origin === "shared" && agent.from
    ? t("agents.shared", { from: agent.from })
    : agent.about;
}

/**
 * What waits at an agent: cards that need the person come before messages not read. The chat
 * that is open has nothing unread.
 */
function waitingAt(agent: Agent, current: boolean): { n: number; label: string; needs: boolean } {
  if (agent.open) {
    return { n: agent.open, label: t("needs.count", { n: agent.open }), needs: true };
  }
  const unread = current ? 0 : agent.unread;
  return { n: unread, label: unread ? t("agents.unread", { n: unread }) : "", needs: false };
}

function Count({ n, label, needs }: { n: number; label: string; needs: boolean }) {
  return (
    <span
      title={label}
      className={cn(
        "enter-pop grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 font-medium text-[0.6875rem] tabular-nums",
        needs ? "bg-ember-tint text-ember-strong" : "bg-ember text-white",
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** An agent in the open list: figure, name and time, and one line of what was said last. */
function Row({ agent, current, onPick }: { agent: Agent; current: boolean; onPick: () => void }) {
  const waiting = waitingAt(agent, current);
  const now = useMinute();
  const time = agent.preview ? when(agent.updatedAt, now, lang) : "";
  return (
    <li>
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        onClick={onPick}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition active:scale-[0.985]",
          current ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <Face agent={agent} size={40} animated={false} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[0.9375rem]",
                waiting.n ? "font-semibold" : "font-medium",
              )}
            >
              {agent.name}
            </span>
            {time ? <span className="shrink-0 text-[0.75rem] text-ink-3">{time}</span> : null}
          </span>
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[0.8125rem]",
                agent.state === "working" ? "text-moss" : waiting.n ? "text-ink-2" : "text-ink-3",
              )}
            >
              {lineOf(agent)}
            </span>
            {waiting.n ? <Count {...waiting} /> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

/** An agent in the narrow column: its figure, with a dot when something waits there. */
function Figure({
  agent,
  current,
  onPick,
}: {
  agent: Agent;
  current: boolean;
  onPick: () => void;
}) {
  const waiting = waitingAt(agent, current);
  const label = [agent.name, waiting.label].filter(Boolean).join(", ");
  return (
    <li>
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-current={current ? "true" : undefined}
        onClick={onPick}
        className={cn(
          "relative grid size-12 place-items-center rounded-xl transition active:scale-95",
          current ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <Face agent={agent} size={36} animated={false} />
        {waiting.n || agent.state === "working" ? (
          <span
            className={cn(
              "enter-pop absolute top-1.5 right-1.5 size-2.5 rounded-full ring-2 ring-paper",
              waiting.n ? "bg-ember" : "bg-moss",
            )}
          />
        ) : null}
      </button>
    </li>
  );
}

/**
 * The agents of the home, as a messenger lists its chats, and the settings below them. `rail`:
 * a narrow column of figures, where the window has no room for the list or the person closed
 * it.
 */
export function Sidebar({
  agents,
  current,
  avatar,
  rail,
  onPick,
  onSearch,
  onNew,
  onSettings,
  onAvatar,
  onSignOut,
}: {
  agents: Agent[];
  current: Agent;
  /** The person's avatar; null: none made yet. */
  avatar: Avatar | null;
  rail?: boolean;
  onPick: (agent: Agent) => void;
  /** Opens the search (⌘K). */
  onSearch: () => void;
  /** Asks the main Wizard for a new bot. */
  onNew: () => void;
  onSettings: () => void;
  onAvatar: () => void;
  onSignOut: () => void;
}) {
  const home = useHome();
  const me = useThisDevice();
  const listed = inOrder(agents);
  // In a group home the admin is named, and the Bot Server is the team's.
  const admin = home.data?.group ? me.data?.admin : undefined;
  const name = admin?.name ?? home.data?.name;
  const where = admin ? `${home.data?.group?.name} · ${botServerName()}` : botServerName();
  const you = <StackedAvatar avatar={avatar ?? DEFAULT_AVATAR} size={1} view="head" follows />;
  /** The person's own things: their avatar, and signing this browser out. */
  const userMenu = {
    label: name ?? t("you.label"),
    head: (
      <>
        <p className="truncate font-medium text-[0.875rem]">{name}</p>
        <p className="truncate text-[0.75rem] text-ink-3">{where}</p>
        {/* The theme and the language, each on a line of its own, as in engenty wizards' menu. */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[0.875rem]">{t("theme.label")}</span>
          <ThemeSwitch />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[0.875rem]">{t("lang.label")}</span>
          <LangSwitch />
        </div>
      </>
    ),
    items: [
      {
        icon: <Smile />,
        label: t(avatar ? "avatar.title" : "avatar.make"),
        onSelect: onAvatar,
      },
      null,
      { icon: <LogOut />, label: t("agents.signOut"), onSelect: onSignOut },
    ],
  };
  const gear = (
    <IconButton label={t("settings.title")} onClick={onSettings}>
      <Settings className="size-[1.125rem]" />
    </IconButton>
  );
  if (rail) {
    return (
      <nav
        aria-label={t("agents.title")}
        className="enter-fade flex h-full w-16 shrink-0 flex-col items-center gap-1 bg-paper pt-[max(0.625rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <Menu
          {...userMenu}
          className="grid size-12 place-items-center rounded-xl transition hover:bg-accent/60"
        >
          {you}
        </Menu>
        <IconButton label={`${t("search.label")} (⌘K)`} onClick={onSearch}>
          <Search className="size-[1.125rem]" />
        </IconButton>
        <IconButton label={t("agents.new")} onClick={onNew}>
          <Plus className="size-[1.125rem]" />
        </IconButton>
        <ul className="mt-1 flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
          {listed.map((agent) => (
            <Figure
              key={agent.id}
              agent={agent}
              current={agent.id === current.id}
              onPick={() => onPick(agent)}
            />
          ))}
        </ul>
        {gear}
      </nav>
    );
  }
  return (
    <nav
      aria-label={t("agents.title")}
      className="enter-fade flex h-full w-full flex-col bg-paper pt-[max(0.625rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex items-center gap-1 pr-2 pb-1 pl-2">
        <Menu
          {...userMenu}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl p-1 text-left transition hover:bg-accent/60"
        >
          <span className="flex shrink-0 justify-center">{you}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium text-[0.9375rem]">{name}</span>
            <span className="truncate text-[0.8125rem] text-ink-3">{where}</span>
          </span>
        </Menu>
        <IconButton label={t("agents.new")} onClick={onNew}>
          <Plus className="size-[1.125rem]" />
        </IconButton>
        <IconButton label={`${t("search.label")} (⌘K)`} onClick={onSearch}>
          <Search className="size-[1.125rem]" />
        </IconButton>
      </div>
      <h2 className="px-4 pt-2 pb-1 font-medium text-[0.75rem] text-ink-3 uppercase tracking-wide">
        {t("agents.title")}
      </h2>
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {listed.map((agent) => (
          <Row
            key={agent.id}
            agent={agent}
            current={agent.id === current.id}
            onPick={() => onPick(agent)}
          />
        ))}
      </ul>
      <div className="flex px-2 pt-1.5">{gear}</div>
    </nav>
  );
}

/**
 * The open list of agents over the chat, from the left edge: where the window has no room beside
 * it. On a phone it fills the screen, one level above the chat, which leads back to it.
 */
export function SidebarDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (open && !el?.open) {
      el?.showModal();
    } else if (!open && el?.open) {
      el.close();
    }
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes a dialog; a click beside it is the pointer's way
    <dialog
      ref={ref}
      aria-label={t("agents.title")}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) {
          onClose();
        }
      }}
      className="drawer m-0 h-dvh max-h-none w-[min(20rem,calc(100%-3rem))] max-w-none bg-paper max-sm:w-full max-sm:shadow-none p-0 text-ink shadow-overlay backdrop:bg-[oklch(20%_0.01_60/0.28)] backdrop:backdrop-blur-[2px]"
    >
      {children}
    </dialog>
  );
}

/** The time, renewed every minute, so "vor 3 min" counts on. */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
