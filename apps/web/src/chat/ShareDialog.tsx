import { useQueryClient } from "@tanstack/react-query";
import type { Contact, PublishedLink, PublishedLinks, SharedKind } from "@wizards-bot/protocol";
import { Check, ChevronDown, Copy, Link, Link2Off, Lock, Share, Share2 } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useContacts, useLinks } from "../lib/queries";
import {
  canShare,
  copyText,
  documentFile,
  download,
  endsAt,
  LINK_LASTS,
  LINK_PASSWORD_MIN,
  pageFile,
  passwordFits,
  printPage,
  shareOut,
  showsEarlier,
} from "../lib/share";
import { Button, cn, Dialog, IconButton, Input, Select } from "../ui";

/** What is shared: a document or an artifact as the pane shows it. */
interface Shared {
  kind: SharedKind;
  id: string;
  title: string;
  /** The version the pane shows. */
  version: number;
  /** A document's text: as a file it is its Markdown. */
  content?: string;
  /** Where the home serves an artifact's page: as a file it is that page, complete in itself. */
  page?: string;
  /** Prints what the pane shows: an artifact prints itself in its frame. */
  print?: () => void;
}

/** The button in a pane's header that opens the dialog for sharing what the pane shows. */
export function ShareButton(shared: Shared) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label={t("share.open")} onClick={() => setOpen(true)}>
        <Share className="size-4" />
      </IconButton>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("share.title", { title: shared.title })}
      >
        <Sharing {...shared} close={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

/** What the person can keep: a PDF through the print dialog, the Markdown, the page as HTML. */
type Format = "pdf" | "md" | "html";
const FORMAT_NAMES: Record<Format, string> = { pdf: "PDF", md: "Markdown", html: "HTML" };

const label = "mb-2 font-medium text-[0.8125rem] text-ink-3";
const small = "text-[0.8125rem] text-ink-3";

/**
 * The ways out of the home for one document or artifact: a link anyone can open, with the
 * links that still work, and a copy to a contact or as a file. How long a link works and its
 * password stay folded away until the person opens them. What the person does here they do
 * themselves, so nothing asks again.
 */
function Sharing({
  kind,
  id,
  title,
  version,
  content,
  page,
  print,
  close,
}: Shared & { close: () => void }) {
  const client = useQueryClient();
  const contacts = useContacts(true);
  const links = useLinks(kind, id, true);
  const [lasts, setLasts] = useState<(typeof LINK_LASTS)[number]>("week");
  const [password, setPassword] = useState("");
  const [choosing, setChoosing] = useState(false);
  /** What is under way: a contact's handle, a link's id, a format or "publish". */
  const [busy, setBusy] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Contact | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** The link published last in this dialog. */
  const [made, setMade] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /** Runs one step and shows what the home said when it did not work. */
  const run = async (what: string, step: () => Promise<void>) => {
    setBusy(what);
    setProblem(null);
    try {
      await step();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const setLinks = (change: (links: PublishedLink[]) => PublishedLink[]) =>
    client.setQueryData<PublishedLinks>(keys.links(kind, id), (kept) =>
      kept ? { ...kept, links: change(kept.links) } : kept,
    );

  const copy = async (link: PublishedLink) => {
    await copyText(link.url);
    setCopied(link.id);
  };
  const send = (contact: Contact) =>
    run(contact.handle, async () => {
      await api.post("/v1/send", { kind, id, handle: contact.handle });
      setSentTo(contact);
    });
  /** The page as the home serves it: a document as its published page, an artifact as itself. */
  const pageOf = async () =>
    (await api.open(kind === "document" ? `/v1/documents/${id}/page` : (page ?? ""))).blob();
  const save = (format: Format) =>
    run(format, async () => {
      if (format === "md") {
        download(documentFile({ title, content: content ?? "" }));
      } else if (format === "html") {
        // Fetched as bytes for the file. It is never put into this page.
        download(pageFile(title, await pageOf()));
      } else if (kind === "artifact") {
        // The print dialog is the browser's: this one is closed first.
        close();
        print?.();
      } else {
        const html = await (await pageOf()).text();
        close();
        printPage(html);
      }
    });
  const publish = () =>
    run("publish", async () => {
      const link = await api.post<PublishedLink>("/v1/links", {
        kind,
        id,
        lasts,
        ...(password ? { password } : {}),
      });
      setLinks((kept) => [link, ...kept]);
      setMade(link.id);
      setPassword("");
      setChoosing(false);
      // The new link is what the person came for: it is on the clipboard where the browser lets it.
      await copy(link).catch(() => undefined);
    });
  const takeBack = (link: PublishedLink) =>
    run(link.id, async () => {
      await api.del(`/v1/links/${link.id}`);
      setLinks((kept) => kept.filter((other) => other.id !== link.id));
    });

  const formats: Format[] =
    kind === "document" ? ["pdf", "md", "html"] : print ? ["pdf", "html"] : ["html"];
  const reach = links.data?.reach;
  const short = !passwordFits(password);
  const chosen = `${t(`share.lasts.${lasts}` as Key)} · ${t(password ? "share.withPassword" : "share.noPassword")}`;
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className={label}>{t("share.link")}</h3>
        {links.data?.links.length ? (
          <ul className="enter-fade mb-3 divide-y divide-border-soft">
            {links.data.links.map((link) => {
              const Icon = link.password ? Lock : Link;
              const ends = link.expiresAt
                ? t("share.until", { when: endsAt(link.expiresAt, new Date(), lang) })
                : t("share.noEnd");
              return (
                <li key={link.id} className="flex items-center gap-1 py-1">
                  <Icon className="mr-2 size-4 shrink-0 text-ink-3" />
                  <p className="min-w-0 flex-1 truncate text-[0.875rem]">
                    {ends}
                    {link.password ? (
                      <span className="sr-only"> · {t("share.withPassword")}</span>
                    ) : null}
                    {showsEarlier(link, version) ? (
                      <span className="text-ink-3"> · {t("share.earlier")}</span>
                    ) : null}
                  </p>
                  <IconButton
                    label={t(copied === link.id ? "share.copied" : "share.copy")}
                    onClick={() => void copy(link).catch(() => undefined)}
                  >
                    {copied === link.id ? (
                      <Check className="size-4 text-moss" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </IconButton>
                  {canShare(navigator, { url: link.url }) ? (
                    <IconButton
                      label={t("share.shareLink")}
                      onClick={() => void shareOut(navigator, { title, url: link.url })}
                    >
                      <Share2 className="size-4" />
                    </IconButton>
                  ) : null}
                  <IconButton
                    label={t("share.takeBack")}
                    disabled={busy === link.id}
                    onClick={() => void takeBack(link)}
                  >
                    <Link2Off className="size-4" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            size="sm"
            variant={links.data?.links.length ? "secondary" : "primary"}
            busy={busy === "publish"}
            disabled={short}
            onClick={() => void publish()}
          >
            {t("share.publish")}
          </Button>
          <button
            type="button"
            aria-expanded={choosing}
            onClick={() => setChoosing(!choosing)}
            className={cn(small, "inline-flex items-center gap-1 transition hover:text-ink")}
          >
            {chosen}
            <ChevronDown className={cn("size-3.5 transition", choosing && "rotate-180")} />
          </button>
        </div>
        {choosing ? (
          <div className="enter-fade mt-3 grid gap-2 sm:grid-cols-2">
            <Select
              label={t("share.lasts")}
              value={lasts}
              onChange={(value) => setLasts(value as typeof lasts)}
              options={LINK_LASTS.map((value) => ({
                value,
                label: t(`share.lasts.${value}` as Key),
              }))}
            />
            <Input
              type="password"
              // A new password, not the one the browser keeps for the home.
              autoComplete="new-password"
              aria-label={t("share.password")}
              placeholder={t("share.password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-9 text-[0.8125rem] coarse:h-11"
            />
          </div>
        ) : null}
        {short ? (
          <p className={cn(small, "mt-2")}>{t("share.passwordShort", { n: LINK_PASSWORD_MIN })}</p>
        ) : null}
        {made && copied === made ? (
          <p role="status" className={cn(small, "enter-fade mt-2 flex items-center gap-1.5")}>
            <Check className="size-3.5 shrink-0 text-moss" />
            {t("share.madeCopied")}
          </p>
        ) : null}
        <p className={cn(small, "mt-2 leading-relaxed")}>
          {t("share.hint")}
          {reach && reach !== "internet" ? ` ${t(`share.reach.${reach}` as Key)}` : null}
        </p>
      </section>

      {contacts.data?.length ? (
        <section>
          <h3 className={label}>{t("share.sendCopy")}</h3>
          <div className="flex flex-wrap gap-2">
            {contacts.data?.map((contact) => (
              <Button
                key={contact.handle}
                variant="secondary"
                size="sm"
                title={contact.handle}
                busy={busy === contact.handle}
                onClick={() => void send(contact)}
              >
                {contact.name}
              </Button>
            ))}
          </div>
          {sentTo ? (
            <p role="status" className={cn(small, "enter-fade mt-2 flex items-center gap-1.5")}>
              <Check className="size-3.5 shrink-0 text-moss" />
              {t("share.sent", { name: sentTo.name })}
            </p>
          ) : null}
        </section>
      ) : null}

      <section>
        <h3 className={label}>{t("share.download")}</h3>
        <div className="flex flex-wrap gap-2">
          {formats.map((format) => (
            <Button
              key={format}
              variant="secondary"
              size="sm"
              busy={busy === format}
              onClick={() => void save(format)}
            >
              {FORMAT_NAMES[format]}
            </Button>
          ))}
        </div>
      </section>

      {problem || links.error ? (
        <p
          role="alert"
          className="enter-rise rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose"
        >
          {problem ?? links.error?.message}
        </p>
      ) : null}
    </div>
  );
}
