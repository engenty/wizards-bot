import { useQueryClient } from "@tanstack/react-query";
import type {
  VaultActivity,
  VaultImported,
  VaultInput,
  VaultItem,
  VaultSecret,
} from "@wizards-bot/protocol";
import { ChevronLeft, CreditCard, Download, KeyRound, NotebookText, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useAgents, useVault } from "../lib/queries";
import { Button, cn, Dialog, IconButton, Input } from "../ui";
import { Menu } from "../ui/Menu";

type Kind = VaultItem["kind"];

const ICONS: Record<Kind, typeof KeyRound> = {
  login: KeyRound,
  card: CreditCard,
  note: NotebookText,
};

/** One way to add something on the Vault, as a tile. */
function Tile({
  icon,
  title,
  hint,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex min-h-24 items-center gap-4 rounded-2xl border border-border-soft bg-card p-4 text-left text-ink transition hover:border-ink-4 active:scale-[0.99] sm:p-5"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-ink-2 [&_svg]:size-[1.125rem]">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-[0.9375rem]">{title}</span>
        <span className="mt-1 block text-[0.8125rem] text-ink-3 leading-snug">{hint}</span>
      </span>
    </button>
  );
}

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

function ActivityLine({ entry, agent }: { entry: VaultActivity; agent: string | undefined }) {
  return (
    <li className="flex items-baseline gap-3 px-4 py-2.5 text-[0.8125rem]">
      <span className="w-36 shrink-0 text-ink-3">{new Date(entry.at).toLocaleString()}</span>
      <span className="min-w-0 flex-1">
        {entry.action === "import" ? (
          // An import is logged with how many passwords it brought.
          <span className="font-medium">
            {t("vault.act.imported", { n: Number.parseInt(entry.label, 10) || 0 })}
          </span>
        ) : (
          <>
            <span className={cn("font-medium", entry.action === "refused" && "text-rose")}>
              {t(`vault.act.${entry.action}`)}
            </span>{" "}
            {entry.label}
          </>
        )}
        {entry.origin ? <span className="text-ink-3"> · {new URL(entry.origin).host}</span> : null}
        <span className="text-ink-3"> · {agent ?? t("vault.you")}</span>
        {entry.reason ? <span className="block text-ink-3">{entry.reason}</span> : null}
      </span>
    </li>
  );
}

type Open =
  | { kind: "form"; itemKind: Kind; item?: VaultItem }
  | { kind: "import" }
  | { kind: "item"; item: VaultItem }
  | null;

/**
 * The Vault: the person's website logins, payment cards and notes, sealed on the Bot Server. The
 * person adds, imports, shows and changes them here; the agents sign in with a login only
 * after the person said yes in the chat, and never see its password.
 */
export function VaultPage({ onAgents }: { onAgents?: () => void }) {
  const vault = useVault();
  const agents = useAgents();
  const [open, setOpen] = useState<Open>(null);
  const items = vault.data?.items ?? [];
  const count = (kind: Kind) => items.filter((i) => i.kind === kind).length;
  const agentName = (id: string | null) =>
    id ? (agents.data?.find((a) => a.id === id)?.name ?? "—") : undefined;
  const add = (itemKind: Kind) => setOpen({ kind: "form", itemKind });
  const sections: Kind[] = ["login", "card", "note"];
  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-10 sm:px-8 sm:pt-10">
        <header className="flex items-center gap-2">
          {onAgents ? (
            <IconButton label={t("agents.show")} onClick={onAgents} className="-ml-1.5">
              <ChevronLeft className="size-5" />
            </IconButton>
          ) : null}
          <h1 className="min-w-0 flex-1 font-display font-semibold text-[1.75rem] leading-tight">
            {t("vault.title")}
          </h1>
          <Menu
            label={t("vault.add")}
            items={[
              { icon: <KeyRound />, label: t("vault.add.login"), onSelect: () => add("login") },
              { icon: <CreditCard />, label: t("vault.add.card"), onSelect: () => add("card") },
              { icon: <NotebookText />, label: t("vault.add.note"), onSelect: () => add("note") },
              null,
              {
                icon: <Download />,
                label: t("vault.add.import"),
                onSelect: () => setOpen({ kind: "import" }),
              },
            ]}
            className="flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 font-medium text-[0.875rem] text-primary-foreground transition hover:brightness-[1.06]"
          >
            <Plus className="size-4" />
            {t("vault.add")}
          </Menu>
        </header>
        {vault.data ? (
          <p className="mt-4 text-[1.125rem] text-ink-2">
            {items.length
              ? t("vault.summary", {
                  logins: count("login"),
                  cards: count("card"),
                  notes: count("note"),
                })
              : t("vault.summary.none")}
          </p>
        ) : null}
        <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))] gap-3">
          <Tile
            icon={<Download />}
            title={t("vault.add.import")}
            hint={t("vault.tile.import")}
            onSelect={() => setOpen({ kind: "import" })}
          />
          <Tile
            icon={<KeyRound />}
            title={t("vault.tile.login.title")}
            hint={t("vault.tile.login")}
            onSelect={() => add("login")}
          />
          <Tile
            icon={<CreditCard />}
            title={t("vault.tile.card.title")}
            hint={t("vault.tile.card")}
            onSelect={() => add("card")}
          />
        </div>
        {sections.map((kind) => {
          const listed = items.filter((i) => i.kind === kind);
          if (!listed.length) return null;
          const Icon = ICONS[kind];
          return (
            <section key={kind} className="mt-7">
              <h2 className="mb-2 font-medium text-[0.8125rem] text-ink-3">
                {t(`vault.section.${kind}`)}
              </h2>
              <ul className="divide-y divide-border-soft overflow-hidden rounded-2xl border border-border-soft bg-card">
                {listed.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setOpen({ kind: "item", item })}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-ink transition hover:bg-accent/60"
                    >
                      <Icon className="size-4 shrink-0 text-ink-3" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-[0.9375rem]">
                          {item.label}
                        </span>
                        <span className="block truncate text-[0.8125rem] text-ink-3">
                          {[item.origin ? new URL(item.origin).host : null, item.detail]
                            .filter(Boolean)
                            .join(" · ")}
                          {item.authenticator ? ` · ${t("vault.authenticator")}` : ""}
                        </span>
                      </span>
                      {item.readable ? null : (
                        <span className="shrink-0 text-[0.75rem] text-rose">
                          {t("vault.unreadable")}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <p className="mt-5 text-[0.8125rem] text-ink-3 leading-relaxed">{t("vault.how")}</p>
        <section className="mt-7">
          <h2 className="mb-2 font-medium text-[0.8125rem] text-ink-3">{t("vault.activity")}</h2>
          {vault.data?.activity.length ? (
            <ul className="divide-y divide-border-soft overflow-hidden rounded-2xl border border-border-soft bg-card">
              {vault.data.activity.map((entry) => (
                <ActivityLine key={entry.id} entry={entry} agent={agentName(entry.agentId)} />
              ))}
            </ul>
          ) : (
            <p className="text-[0.8125rem] text-ink-3">{t("vault.activity.none")}</p>
          )}
        </section>
        {vault.error ? (
          <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
            {vault.error.message}
          </p>
        ) : null}
      </div>
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
    </div>
  );
}
