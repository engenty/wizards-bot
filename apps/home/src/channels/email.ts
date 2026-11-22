import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import { type ChannelAdapter, cardsAsText, type Incoming, type Outgoing } from "./channels.ts";

// Email over IMAP and SMTP: the agent has a mailbox of its own. The home waits in the inbox
// with IMAP IDLE, so the server says when a mail arrives, and answers over SMTP.

const IMAP_PORT = 993;
const SMTP_PORT = 465;
/** Enough of a mail to hold its text. Large attachments are not loaded. */
const SOURCE_LIMIT = 1024 * 1024;
const SUBJECT_LIMIT = 70;
const DAY = 24 * 60 * 60 * 1000;
const LONGEST_WAIT = 60_000;

const SETUP = `Your agent gets its own mailbox. You write to its address, and it answers by email.

1. Create a mailbox for the agent at your email provider.
2. Find the names of the provider's IMAP and SMTP servers. They are in its help pages, often as \`imap.example.com\` and \`smtp.example.com\`.
3. If the provider wants an app password for mail programs, create one and use it as the password.
4. Enter the four values here.

The Bot Server uses port 993 for IMAP and port 465 for SMTP. For another port, write it after the name, as in \`smtp.example.com:587\`.

The Bot Server marks every new mail in this inbox as read, so use a mailbox that only the agent has.`;

export interface EmailOptions {
  /** Talks to the mail servers without TLS. Only tests do that, with servers on this computer. */
  plain?: boolean;
  /** The first wait before a new try to connect, in milliseconds. It doubles up to a minute. */
  retry?: number;
}

interface Endpoint {
  host: string;
  port: number;
}

interface Account {
  address: string;
  password: string;
  imap: Endpoint;
  smtp: Endpoint;
}

/** What an answer needs to land in the same thread of the person's mail program. */
export interface MailThread {
  messageId: string;
  subject: string;
  /** The Message-IDs the mail itself referred to, oldest first. */
  references: string[];
}

/** A server name with an optional port, as in `mail.example.com:587`. */
export function endpoint(value: string, port: number): Endpoint {
  const match = /^(.+?)(?::(\d+))?$/.exec(value.trim());
  return { host: match?.[1] ?? "", port: match?.[2] ? Number(match[2]) : port };
}

function accountOf(settings: Record<string, string>): Account {
  const account = {
    address: (settings.address ?? "").toLowerCase(),
    password: settings.password ?? "",
    imap: endpoint(settings.imap ?? "", IMAP_PORT),
    smtp: endpoint(settings.smtp ?? "", SMTP_PORT),
  };
  if (!account.address.includes("@")) throw new Error("The email address is missing or has no @");
  if (!account.password) throw new Error("The password is missing");
  if (!account.imap.host) throw new Error("The IMAP server is missing");
  if (!account.smtp.host) throw new Error("The SMTP server is missing");
  return account;
}

// Port 993 and port 465 speak TLS from the first byte. Every other port has to switch to
// TLS before the password is sent.
function mailbox(account: Account, plain: boolean): ImapFlow {
  const secure = !plain && account.imap.port === IMAP_PORT;
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure,
    ...(secure ? {} : { doSTARTTLS: !plain }),
    auth: { user: account.address, pass: account.password },
    logger: false,
  });
}

function postbox(account: Account, plain: boolean) {
  const secure = !plain && account.smtp.port === SMTP_PORT;
  return createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure,
    requireTLS: !plain && !secure,
    ignoreTLS: plain,
    auth: { user: account.address, pass: account.password },
  });
}

/** Why a mail server did not let the home in, in words for the person. */
function refusal(host: string, error: unknown): string {
  const failure = error as { authenticationFailed?: boolean; code?: string; message?: string };
  if (failure.authenticationFailed || failure.code === "EAUTH") {
    return `${host} did not accept the address and the password. Many providers want an app password here`;
  }
  return `${host} does not answer: ${failure.message ?? String(error)}`;
}

export function emailAdapter(options: EmailOptions = {}): ChannelAdapter {
  const plain = options.plain ?? false;
  const firstWait = options.retry ?? 1000;

  return {
    id: "email",
    label: "Email",
    setup: {
      body: SETUP,
      fields: [
        {
          id: "address",
          label: "Email address",
          type: "text",
          placeholder: "e.g. agent@example.com",
          required: true,
        },
        { id: "password", label: "Password", type: "secret", required: true },
        {
          id: "imap",
          label: "IMAP server",
          type: "text",
          placeholder: "e.g. imap.example.com",
          required: true,
        },
        {
          id: "smtp",
          label: "SMTP server",
          type: "text",
          placeholder: "e.g. smtp.example.com",
          required: true,
        },
      ],
    },

    async start(settings, context) {
      const account = accountOf(settings);
      const smtp = postbox(account, plain);
      try {
        await smtp.verify();
      } catch (error) {
        throw new Error(refusal(account.smtp.host, error));
      } finally {
        smtp.close();
      }

      let stopped = false;
      let current: ImapFlow | undefined;
      let timer: NodeJS.Timeout | undefined;
      let attempt = 0;
      let reading = false;
      let again = false;

      // Hands every unseen mail to the home, one reader at a time. A mail that arrives while
      // the reader works makes it look once more.
      const read = async (imap: ImapFlow): Promise<void> => {
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        try {
          do {
            again = false;
            // Older unseen mail is left alone, so a mailbox with a past keeps its unread marks.
            const since = new Date(Date.now() - DAY);
            const mails = await imap.fetchAll(
              { seen: false, since },
              { uid: true, source: { maxLength: SOURCE_LIMIT } },
              { uid: true },
            );
            for (const mail of mails) {
              const parsed = mail.source
                ? await simpleParser(mail.source).catch(() => undefined)
                : undefined;
              // Seen first: a mail that was handed over must not come a second time.
              await imap.messageFlagsAdd(String(mail.uid), ["\\Seen"], { uid: true });
              const incoming = parsed && incomingMail(parsed, account.address);
              if (incoming) context.receive(incoming);
            }
          } while (again && !stopped);
        } catch (error) {
          if (!stopped) context.log(`Could not read new mail: ${(error as Error).message}`);
        } finally {
          reading = false;
        }
      };

      const connect = async (): Promise<void> => {
        const imap = mailbox(account, plain);
        current = imap;
        // A close always follows an error, and the close starts the new try.
        imap.on("error", () => {});
        imap.on("close", () => {
          if (imap === current) retry();
        });
        await imap.connect();
        await imap.mailboxOpen("INBOX");
        if (stopped) return imap.close();
        attempt = 0;
        imap.on("exists", () => void read(imap));
        await read(imap);
      };

      const retry = (): void => {
        if (stopped || timer) return;
        const wait = Math.min(firstWait * 2 ** attempt++, LONGEST_WAIT);
        timer = setTimeout(() => {
          timer = undefined;
          if (stopped) return;
          connect().catch((error) => {
            context.log(`The mailbox is out of reach: ${(error as Error).message}`);
            retry();
          });
        }, wait);
      };

      try {
        await connect();
      } catch (error) {
        stopped = true;
        clearTimeout(timer);
        current?.close();
        throw new Error(refusal(account.imap.host, error));
      }

      return () => {
        stopped = true;
        clearTimeout(timer);
        current?.close();
      };
    },

    async send(settings, peer, out) {
      const account = accountOf(settings);
      const smtp = postbox(account, plain);
      try {
        await smtp.sendMail(outgoingMail(account.address, peer, out));
      } finally {
        smtp.close();
      }
    },
  };
}

export const email = emailAdapter();

/** A mail as the home hears it. Nothing for the agent's own mail, an automatic answer or an empty mail. */
export function incomingMail(mail: ParsedMail, own: string): Incoming | undefined {
  const from = mail.from?.value[0]?.address?.toLowerCase();
  if (!from || from === own.toLowerCase()) return undefined;
  // An out-of-office note or a bounce. An answer to it would start a loop.
  const automatic = mail.headers.get("auto-submitted");
  if (typeof automatic === "string" && automatic.trim().toLowerCase() !== "no") return undefined;

  const subject = (mail.subject ?? "").trim();
  // A forwarded mail is there to be read whole. In an answer only the new part counts.
  const forwarded = /^(fwd?|wg)\s*:/i.test(subject);
  const body = forwarded ? (mail.text ?? "").trim() : replyText(mail.text ?? "");
  const text = [isReply(subject) ? "" : subject, body].filter(Boolean).join("\n\n");
  if (!text) return undefined;
  const thread: MailThread = {
    messageId: mail.messageId ?? "",
    subject,
    references: [mail.references ?? []].flat(),
  };
  return { from, text, thread: JSON.stringify(thread) };
}

/** The mail the home sends: plain text, in the thread of the mail it answers. */
export function outgoingMail(address: string, peer: string, out: Outgoing) {
  const text = [out.text, cardsAsText(out.cards)].filter(Boolean).join("\n\n");
  const thread = threadOf(out.thread);
  if (!thread?.messageId)
    return { from: address, to: peer, subject: thread?.subject || subjectOf(text), text };
  const subject = thread.subject || subjectOf(text);
  return {
    from: address,
    to: peer,
    subject: isReply(subject) ? subject : `Re: ${subject}`,
    text,
    inReplyTo: thread.messageId,
    references: [...thread.references, thread.messageId],
  };
}

const isReply = (subject: string): boolean => /^(re|aw|antw)\s*:/i.test(subject);

function threadOf(raw: string | undefined): MailThread | undefined {
  if (!raw) return undefined;
  try {
    const thread = JSON.parse(raw) as Partial<MailThread>;
    return {
      messageId: typeof thread.messageId === "string" ? thread.messageId : "",
      subject: typeof thread.subject === "string" ? thread.subject : "",
      references: Array.isArray(thread.references)
        ? thread.references.filter((id) => typeof id === "string")
        : [],
    };
  } catch {
    return undefined;
  }
}

/** A subject for a mail the agent starts: its first line, without Markdown marks. */
function subjectOf(text: string): string {
  const line = (text.split("\n").find((candidate) => candidate.trim()) ?? "")
    .replace(/^[#>\-*\s]+/, "")
    .replace(/[*_`]/g, "")
    .trim();
  if (!line) return "wizards.bot";
  return line.length > SUBJECT_LIMIT ? `${line.slice(0, SUBJECT_LIMIT - 1).trimEnd()}…` : line;
}

// ── The new part of an answer ───────────────────────────────────────────────

/** "On 3 Nov 2026, Anna wrote:" in the forms mail programs write it, English and German. */
const WROTE = /^(On\s.+\swrote|Am\s.+\sschrieb\s.+|.+\sschrieb\sam\s.+):$/i;
const WROTE_STARTS = /^(On|Am)\s/i;
/** A line that starts the mail below: Outlook's rule and "Original Message". */
const DIVIDER = /^(_{10,}|-{2,}\s*(Original Message|Ursprüngliche Nachricht)\s*-{2,})$/i;
/** Outlook's block of header lines above the quoted mail. */
const HEADER = /^(From|Von):\s/i;
const HEADER_NEXT = /^(Sent|Gesendet|Date|Datum|To|An):\s/i;
/** The line a phone or a mail program adds under every mail. */
const FOOTER =
  /^(Sent from my\s|Sent from Outlook|Get Outlook for\s|Gesendet von meinem\s|Von meinem\s.+\sgesendet)/i;

/**
 * What the person wrote in a mail, without the mail they answered and without the signature.
 * Mail programs quote in two ways: marked with `>` line by line, or as everything below a
 * line like "On … wrote:". Marked lines are taken out, so an answer written under the quote
 * stays. An unmarked quote ends the text.
 */
export function replyText(text: string): string {
  const kept: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trimStart().startsWith(">")) {
      kept.push(line);
      continue;
    }
    // The line that announces the quote goes with it. Some programs break it in two.
    while (kept.at(-1)?.trim() === "") kept.pop();
    const last = kept.at(-1)?.trim() ?? "";
    const both = `${kept.at(-2)?.trim() ?? ""} ${last}`;
    if (WROTE.test(last)) kept.pop();
    else if (WROTE_STARTS.test(both) && WROTE.test(both)) kept.splice(-2);
  }

  let end = kept.length;
  for (let index = 0; index < kept.length; index++) {
    const line = (kept[index] ?? "").trim();
    const next = (kept[index + 1] ?? "").trim();
    const quote =
      WROTE.test(line) ||
      (WROTE_STARTS.test(line) && WROTE.test(`${line} ${next}`)) ||
      DIVIDER.test(line) ||
      (HEADER.test(line) &&
        kept.slice(index + 1, index + 4).some((below) => HEADER_NEXT.test(below.trim())));
    // "-- " alone on a line starts a signature.
    if (quote || line === "--" || FOOTER.test(line)) {
      end = index;
      break;
    }
  }
  return kept
    .slice(0, end)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
