import { useQueryClient } from "@tanstack/react-query";
import type {
  VaultActivity,
  VaultImported,
  VaultInput,
  VaultItem,
  VaultSecret,
} from "@wizards-bot/protocol";
import { CreditCard, Download, KeyRound, NotebookText, Plus, Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useAgents, useVault } from "../lib/queries";
import { Button, cn, Dialog, Input } from "../ui";
import { Menu } from "../ui/Menu";

type Kind = VaultItem["kind"];

const ICONS: Record<Kind, typeof KeyRound> = {
  login: KeyRound,
  card: CreditCard,
  note: NotebookText,
};

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
    <label className="mt-3.5 block first:mt-0">
      <span className="mb-1 block font-medium text-[0.8125rem]">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[0.75rem] text-ink-3">{hint}</span> : null}
    </label>
  );
}

/** Adds a login, a card or a note, or changes one. Secret fields start empty: empty keeps them. */
function ItemForm({ kind, item, onClose }: { kind: Kind; item?: VaultItem; onClose: () => void }) {
  const client = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({
    label: item?.label ?? "",
    origin: item?.origin ?? "",
    username: item?.kind === "login" ? item.detail : "",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (name: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [name]: e.target.value }));
  const editing = Boolean(item);
  const keep = editing ? t("vault.form.keep") : undefined;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = values;
    const body: VaultInput =
      kind === "login"
        ? {
            kind,
            label: v.label ?? "",
            origin: v.origin ?? "",
            username: v.username ?? "",
            ...(v.password ? { password: v.password } : {}),
            ...(v.authenticator ? { authenticator: v.authenticator } : {}),
          }
        : kind === "card"
          ? {
              kind,
              label: v.label ?? "",
              holder: v.holder ?? "",
              expiry: v.expiry ?? "",
              ...(v.number ? { number: v.number } : {}),
              ...(v.code ? { code: v.code } : {}),
            }
          : { kind, label: v.label ?? "", ...(v.text !== undefined ? { text: v.text } : {}) };
    try {
      await (item ? api.put(`/v1/vault/${item.id}`, body) : api.post("/v1/vault", body));
      await client.invalidateQueries({ queryKey: keys.vault() });
      onClose();
    } catch (err) {
      // What was typed into a secret field is not kept after a failed save.
      setValues((v) => ({ ...v, password: "", authenticator: "", number: "", code: "" }));
      setProblem((err as Error).message);
    }
  };
  const title = item ? t("vault.form.edit", { name: item.label }) : t(`vault.form.new.${kind}`);
  return (
    <Dialog open onClose={onClose} title={title}>
      <form onSubmit={save} autoComplete="off">
        <Field label={t("vault.form.name")}>
          <Input
            className="h-10"
            data-autofocus
            required
            value={values.label}
            onChange={set("label")}
            placeholder={t(`vault.form.namePlaceholder.${kind}`)}
          />
        </Field>
        {kind === "login" ? (
          <>
            <Field label={t("vault.form.website")}>
              <Input
                className="h-10"
                required
                value={values.origin}
                onChange={set("origin")}
                placeholder="example.com"
              />
            </Field>
            <Field label={t("vault.form.username")}>
              <Input
                className="h-10"
                value={values.username}
                onChange={set("username")}
                autoComplete="off"
              />
            </Field>
            <Field label={t("vault.form.password")} hint={keep}>
              <Input
                className="h-10"
                type="password"
                required={!editing}
                value={values.password ?? ""}
                onChange={set("password")}
                autoComplete="new-password"
              />
            </Field>
            <Field
              label={t("vault.form.authenticator")}
              hint={keep ?? t("vault.form.authenticatorHint")}
            >
              <Input
                className="h-10"
                type="password"
                value={values.authenticator ?? ""}
                onChange={set("authenticator")}
                autoComplete="off"
              />
            </Field>
          </>
        ) : kind === "card" ? (
          <>
            <Field label={t("vault.form.holder")}>
              <Input
                className="h-10"
                required
                value={values.holder ?? ""}
                onChange={set("holder")}
              />
            </Field>
            <Field label={t("vault.form.number")} hint={keep}>
              <Input
                className="h-10"
                type="password"
                inputMode="numeric"
                required={!editing}
                value={values.number ?? ""}
                onChange={set("number")}
                autoComplete="off"
              />
            </Field>
            <Field label={t("vault.form.expiry")}>
              <Input
                className="h-10"
                required
                value={values.expiry ?? ""}
                onChange={set("expiry")}
                placeholder="MM/YY"
              />
            </Field>
            <Field label={t("vault.form.code")} hint={keep}>
              <Input
                className="h-10"
                type="password"
                inputMode="numeric"
                value={values.code ?? ""}
                onChange={set("code")}
                autoComplete="off"
              />
            </Field>
          </>
        ) : (
          <Field label={t("vault.form.text")} hint={keep}>
            <textarea
              value={values.text ?? ""}
              onChange={set("text")}
              rows={6}
              className="block w-full rounded-lg border border-input bg-card px-3.5 py-2 text-[0.9375rem] outline-none transition focus:border-focus focus:ring-4 focus:ring-focus-glow"
            />
          </Field>
        )}
        {problem ? (
          <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
            {problem}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit">{t("vault.form.save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A password manager's CSV export: the browser reads the file, the home parses it. */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [result, setResult] = useState<VaultImported | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      const imported = await api.post<VaultImported>("/v1/vault/import", {
        csv: await file.text(),
      });
      setResult(imported);
      await client.invalidateQueries({ queryKey: keys.vault() });
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={t("vault.import.title")}>
      <div>
        <p className="text-[0.9375rem] text-ink-2 leading-relaxed">{t("vault.import.text")}</p>
        <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-full bg-primary px-4 py-2 font-medium text-[0.875rem] text-primary-foreground">
          <Download className="size-4" />
          {busy ? t("vault.import.busy") : t("vault.import.choose")}
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </label>
        {result ? (
          <div role="status" className="mt-4 text-[0.9375rem]">
            <p className="font-medium">
              {t("vault.import.done", { added: result.added, updated: result.updated })}
            </p>
            {result.unreadable ? (
              <p className="text-ink-3">{t("vault.import.unreadable", { n: result.unreadable })}</p>
            ) : null}
            {result.badKeys ? (
              <p className="text-ink-3">{t("vault.import.badKeys", { n: result.badKeys })}</p>
            ) : null}
          </div>
        ) : null}
        {problem ? (
          <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
            {problem}
          </p>
        ) : null}
        <p className="mt-4 text-[0.8125rem] text-ink-3">{t("vault.import.delete")}</p>
        <div className="mt-6 flex justify-end">
          <Button variant={result ? "primary" : "ghost"} onClick={onClose}>
            {result ? t("vault.import.close") : t("common.cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** A value of an item, once shown, with a way to copy it. */
function SecretLine({ label, value }: { label: string; value: string | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="flex items-center gap-2 py-2">
      <span className="w-36 shrink-0 text-[0.8125rem] text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[0.875rem]">{value}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? t("vault.copied") : t("vault.copy")}
      </Button>
    </div>
  );
}

/** One item: what it is, its values once shown, and the ways to change or delete it. */
function ItemDialog({
  item,
  onEdit,
  onClose,
}: {
  item: VaultItem;
  onEdit: () => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [secret, setSecret] = useState<VaultSecret | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reveal = () =>
    api
      .post<VaultSecret>(`/v1/vault/${item.id}/reveal`, {})
      .then(setSecret, (err: Error) => setProblem(err.message));
  const remove = () =>
    api.del(`/v1/vault/${item.id}`).then(
      async () => {
        await client.invalidateQueries({ queryKey: keys.vault() });
        onClose();
      },
      (err: Error) => setProblem(err.message),
    );
  return (
    <Dialog open onClose={onClose} title={item.label}>
      <div>
        <p className="text-[0.875rem] text-ink-2">
          {t(`vault.kind.${item.kind}`)}
          {item.origin ? ` · ${item.origin}` : ""}
          {item.detail ? ` · ${item.detail}` : ""}
        </p>
        {secret ? (
          <div className="mt-3 divide-y divide-border-soft rounded-xl border border-border-soft px-3">
            <SecretLine label={t("vault.form.username")} value={secret.username} />
            <SecretLine label={t("vault.form.password")} value={secret.password} />
            <SecretLine label={t("vault.code")} value={secret.code} />
            <SecretLine label={t("vault.form.holder")} value={secret.holder} />
            <SecretLine label={t("vault.form.number")} value={secret.number} />
            <SecretLine label={t("vault.form.expiry")} value={secret.expiry} />
            <SecretLine label={t("vault.form.code")} value={secret.cardCode} />
            <SecretLine label={t("vault.form.text")} value={secret.text} />
          </div>
        ) : item.readable ? (
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void reveal()}>
            {t("vault.reveal")}
          </Button>
        ) : (
          <p className="mt-3 text-[0.875rem] text-rose">{t("vault.unreadable")}</p>
        )}
        <p className="mt-2 text-[0.75rem] text-ink-3">{t("vault.revealNote")}</p>
        {problem ? (
          <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
            {problem}
          </p>
        ) : null}
        {asking ? (
          <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
            <p className="min-w-48 flex-1 text-[0.875rem]">
              {t("vault.deleteAsk", { name: item.label })}
            </p>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              {t("vault.delete")}
            </Button>
          </div>
        ) : (
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="danger" onClick={() => setAsking(true)}>
              {t("vault.delete")}
            </Button>
            {item.readable ? (
              <Button variant="secondary" onClick={onEdit}>
                {t("vault.edit")}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** One use of the Vault, on one line: when, what, which item and who. */
function ActivityLine({ entry, agent }: { entry: VaultActivity; agent: string | undefined }) {
  return (
    <li className="flex items-baseline gap-3 py-1.5 text-[0.8125rem]">
      <span className="w-28 shrink-0 text-ink-3 tabular-nums">
        {new Date(entry.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
      </span>
      <span className="min-w-0 flex-1">
        {entry.action === "import" ? (
          // An import is logged with how many passwords it brought.
          t("vault.act.imported", { n: Number.parseInt(entry.label, 10) || 0 })
        ) : (
          <>
            <span className={cn(entry.action === "refused" && "text-rose")}>
              {t(`vault.act.${entry.action}`)}
            </span>{" "}
            <span className="font-medium">{entry.label}</span>
          </>
        )}
        <span className="text-ink-3"> · {agent ?? t("vault.you")}</span>
        {entry.reason ? <span className="block truncate text-ink-3">{entry.reason}</span> : null}
      </span>
    </li>
  );
}

type Open =
  | { kind: "form"; itemKind: Kind; item?: VaultItem }
  | { kind: "import" }
  | { kind: "item"; item: VaultItem }
  | null;

/** A way into the Vault above its tabs: a card of the same size as its neighbour. */
const DOOR =
  "flex w-full min-w-0 items-center gap-3 rounded-xl border border-border-soft bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/40";
const DOOR_ICON = "grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-ink-2";

/** The two tabs of the Vault: what it keeps, and what was done with it. */
type Tab = "items" | "activity";

/** What a row says under its name: the website and the user name, or the card's holder. */
function line(item: VaultItem) {
  return [item.origin ? new URL(item.origin).host : null, item.detail].filter(Boolean).join(" · ");
}

/**
 * The Vault, as a page of the settings: the person's passwords (with their authenticator keys),
 * payment cards and notes, sealed with the Bot Server's key, in one list (an icon tells them
 * apart, a search finds one once the list is long), and beside it the activity. The agents sign
 * in with a password only after the person said yes in the chat, and never see it.
 */
export function VaultSettings() {
  const vault = useVault();
  const agents = useAgents();
  const [open, setOpen] = useState<Open>(null);
  const [tab, setTab] = useState<Tab>("items");
  const [query, setQuery] = useState("");
  const items = [...(vault.data?.items ?? [])].sort((a, b) => a.label.localeCompare(b.label));
  const words = query.trim().toLowerCase();
  const listed = words
    ? items.filter((i) => `${i.label} ${line(i)}`.toLowerCase().includes(words))
    : items;
  const agentName = (id: string | null) =>
    id ? (agents.data?.find((a) => a.id === id)?.name ?? "—") : undefined;
  const add = (itemKind: Kind) => setOpen({ kind: "form", itemKind });
  const activity = vault.data?.activity ?? [];
  return (
    <>
      {/* Two ways in, side by side and the same size; they scroll away with the list. */}
      <div className="mb-1 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setOpen({ kind: "import" })} className={DOOR}>
          <span className={DOOR_ICON}>
            <Download className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-[0.875rem]">
              {t("vault.door.import")}
            </span>
            <span className="block truncate text-[0.75rem] text-ink-3">
              {t("vault.door.importHint")}
            </span>
          </span>
        </button>
        <Menu
          label={t("vault.door.add")}
          items={[
            { icon: <KeyRound />, label: t("vault.add.login"), onSelect: () => add("login") },
            { icon: <CreditCard />, label: t("vault.add.card"), onSelect: () => add("card") },
            { icon: <NotebookText />, label: t("vault.add.note"), onSelect: () => add("note") },
          ]}
          className={DOOR}
        >
          <span className={DOOR_ICON}>
            <Plus className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-[0.875rem]">
              {t("vault.door.add")}
            </span>
            <span className="block truncate text-[0.75rem] text-ink-3">
              {t("vault.door.addHint")}
            </span>
          </span>
        </Menu>
      </div>
      {/* The tabs and the search stay in view while a long list scrolls. */}
      <div className="sticky -top-3 z-10 -mx-5 bg-card px-5 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <div
            role="tablist"
            aria-label={t("vault.title")}
            className="inline-flex min-w-0 items-center overflow-x-auto rounded-full bg-paper-2 p-0.5 ring-1 ring-border-soft"
          >
            {(["items", "activity"] as const).map((one) => (
              <button
                key={one}
                type="button"
                role="tab"
                aria-selected={one === tab}
                onClick={() => setTab(one)}
                className={cn(
                  "h-7 shrink-0 rounded-full px-3 text-[0.8125rem] transition",
                  one === tab
                    ? "bg-card font-medium text-ink shadow-sm"
                    : "text-ink-3 hover:text-ink",
                )}
              >
                {t(one === "items" ? "vault.tab.items" : "vault.activity")}
                <span className="ml-1.5 text-ink-4 tabular-nums">
                  {one === "items" ? items.length : activity.length}
                </span>
              </button>
            ))}
          </div>
        </div>
        {tab === "items" && items.length > 6 ? (
          <label className="mt-2 flex h-8 items-center gap-2 rounded-lg bg-paper-2 px-2.5 ring-1 ring-border-soft">
            <Search className="size-3.5 shrink-0 text-ink-3" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("vault.search")}
              aria-label={t("vault.search")}
              className="min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none placeholder:text-ink-4"
            />
          </label>
        ) : null}
      </div>
      {tab === "activity" ? (
        activity.length ? (
          <ul className="mt-1 divide-y divide-border-soft">
            {activity.map((entry) => (
              <ActivityLine key={entry.id} entry={entry} agent={agentName(entry.agentId)} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[0.875rem] text-ink-2">{t("vault.activity.none")}</p>
        )
      ) : (
        <>
          {listed.length ? (
            <ul className="mt-1 divide-y divide-border-soft">
              {listed.map((item) => {
                const Icon = ICONS[item.kind];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setOpen({ kind: "item", item })}
                      className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-accent/60"
                    >
                      <Icon className="size-4 shrink-0 text-ink-3" />
                      <span className="min-w-0 flex-1 truncate text-[0.875rem]">
                        <span className="font-medium">{item.label}</span>
                        {line(item) ? <span className="text-ink-3"> · {line(item)}</span> : null}
                      </span>
                      {item.authenticator ? (
                        <span className="shrink-0 text-[0.75rem] text-ink-3">
                          {t("vault.authenticator")}
                        </span>
                      ) : null}
                      {item.readable ? null : (
                        <span className="shrink-0 text-[0.75rem] text-rose">
                          {t("vault.unreadable")}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : vault.data ? (
            <p className="mt-3 text-[0.875rem] text-ink-2">
              {words ? t("vault.noMatch") : t("vault.empty")}
            </p>
          ) : null}
          <p className="mt-4 text-[0.8125rem] text-ink-3 leading-relaxed">{t("vault.how")}</p>
        </>
      )}
      {vault.error ? (
        <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
          {vault.error.message}
        </p>
      ) : null}
      {open?.kind === "form" ? (
        <ItemForm kind={open.itemKind} item={open.item} onClose={() => setOpen(null)} />
      ) : open?.kind === "import" ? (
        <ImportDialog onClose={() => setOpen(null)} />
      ) : open?.kind === "item" ? (
        <ItemDialog
          item={open.item}
          onEdit={() => setOpen({ kind: "form", itemKind: open.item.kind, item: open.item })}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
