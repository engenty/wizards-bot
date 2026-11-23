import { FillRefused } from "@engenty/browser";
import {
  authenticatorCode,
  authenticatorKey,
  fits,
  OriginRefused,
  parsePasswordCsv,
  redactor,
  siteOrigin,
} from "@engenty/vault";
import type {
  VaultActivity,
  VaultImported,
  VaultInput,
  VaultItem,
  VaultSecret,
  VaultView,
} from "@wizards-bot/protocol";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { newId, now } from "../ids.ts";

// The Vault: the person's website logins (with an authenticator key, when they have one),
// payment cards and notes. Each is sealed with the home's key from `Secrets`, bound to its
// record and what it is. The person adds, imports, reveals and changes them on the Vault page.
// An agent uses a login only through `vault_sign_in` and `vault_code`: it sees the login's
// name, its website and two letters of the user name; the home types the password and the
// code into the page itself, on the login's own website only, after the person said yes on a
// card. Every use, reveal and change is in the activity.

type Kind = VaultItem["kind"];

interface Row {
  id: string;
  kind: Kind;
  label: string;
  origin: string | null;
  hint: string;
  sealed: string;
  created_at: string;
  updated_at: string;
}

interface Login {
  username: string;
  password: string;
  authenticator?: string;
}
interface Card {
  holder: string;
  number: string;
  expiry: string;
  code?: string;
}
interface Note {
  text: string;
}
type Secret = Login | Card | Note;

export class VaultRefused extends Error {}

/** How long a yes to a login also covers its authenticator code in the same conversation. */
const YES_LASTS_MS = 10 * 60_000;
/** Entries of the activity the page shows. */
const ACTIVITY = 200;

const brandOf = (number: string): string =>
  /^4/.test(number)
    ? "Visa"
    : /^(5[1-5]|2[2-7])/.test(number)
      ? "Mastercard"
      : /^3[47]/.test(number)
        ? "American Express"
        : "Card";

function luhn(number: string): boolean {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let digit = Number(number[number.length - 1 - i]);
    if (i % 2) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Two letters of a user name and dots: enough for a model to tell two logins apart. */
const hintOf = (username: string): string => (username ? `${username.slice(0, 2)}•••` : "");

export class Vault {
  private readonly home: Home;
  /** Per conversation: the values entered on a page, kept out of everything the model reads. */
  private readonly entered = new Map<string, Set<string>>();
  /** Per conversation: the login the person said yes to, and when. */
  private readonly yes = new Map<string, { itemId: string; origin: string; at: number }>();

  constructor(home: Home) {
    this.home = home;
    home.addTools((context) => this.tools(context));
  }

  // ── Records ───────────────────────────────────────────────────────────────

  private rows(): Row[] {
    return this.home.db.all<Row>("select * from vault_item order by kind, lower(label)");
  }

  private row(id: string): Row | undefined {
    return this.home.db.get<Row>("select * from vault_item where id = ?", id);
  }

  private open<T extends Secret>(row: Row): T {
    return JSON.parse(this.home.secrets.unseal(["vault", row.id, row.kind], row.sealed)) as T;
  }

  private sealFor(id: string, kind: Kind, secret: Secret): string {
    return this.home.secrets.seal(["vault", id, kind], JSON.stringify(secret));
  }

  private readable(row: Row): Secret | undefined {
    try {
      return this.open(row);
    } catch {
      return undefined;
    }
  }

  private itemOf(row: Row): VaultItem {
    const secret = this.readable(row);
    const detail =
      row.kind === "login"
        ? ((secret as Login | undefined)?.username ?? "")
        : row.kind === "card"
          ? row.hint
          : "";
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      ...(row.origin ? { origin: row.origin } : {}),
      detail,
      ...(row.kind === "login" && (secret as Login | undefined)?.authenticator
        ? { authenticator: true }
        : {}),
      readable: secret !== undefined,
      updatedAt: row.updated_at,
    };
  }

  view(): VaultView {
    const activity = this.home.db.all<{
      id: string;
      item_id: string | null;
      label: string;
      action: VaultActivity["action"];
      origin: string | null;
      agent_id: string | null;
      reason: string | null;
      at: string;
    }>(`select * from vault_activity order by at desc limit ${ACTIVITY}`);
    return {
      items: this.rows().map((row) => this.itemOf(row)),
      activity: activity.map((a) => ({
        id: a.id,
        itemId: a.item_id,
        label: a.label,
        action: a.action,
        origin: a.origin,
        agentId: a.agent_id,
        reason: a.reason,
        at: a.at,
      })),
    };
  }

  private log(entry: Omit<VaultActivity, "id" | "at">): void {
    this.home.db.run(
      "insert into vault_activity (id, item_id, label, action, origin, agent_id, reason, at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      newId("vac"),
      entry.itemId,
      entry.label,
      entry.action,
      entry.origin,
      entry.agentId,
      entry.reason,
      now(),
    );
    this.home.events.emit({ type: "vault.updated", vault: this.view() });
  }

  /** Adds an item, or changes one; an empty secret field keeps what was kept. */
  save(input: VaultInput, id?: string): VaultItem {
    const existing = id ? this.row(id) : undefined;
    if (id && !existing) throw new VaultRefused("This item is not in the Vault any more.");
    if (existing && existing.kind !== input.kind)
      throw new VaultRefused("An item keeps its kind. Add a new one instead.");
    const before = existing ? this.readable(existing) : undefined;
    if (existing && !before)
      throw new VaultRefused(
        "The home can't open this item with its key. Delete it and add it again.",
      );
    const label = input.label.trim();
    if (!label) throw new VaultRefused("Give it a name you will recognise.");
    let origin: string | null = null;
    let hint = "";
    let secret: Secret;
    if (input.kind === "login") {
      origin = siteOrigin(input.origin);
      const was = before as Login | undefined;
      const password = input.password || was?.password;
      if (!password) throw new VaultRefused("Enter the password.");
      let authenticator = was?.authenticator;
      if (input.authenticator?.trim()) {
        authenticator = authenticatorKey(input.authenticator);
        if (!authenticator)
          throw new VaultRefused(
            "This is no authenticator key. Paste the setup key or the otpauth:// link the website shows beside its QR code.",
          );
      }
      secret = {
        username: input.username.trim(),
        password,
        ...(authenticator ? { authenticator } : {}),
      };
      hint = hintOf(input.username.trim());
    } else if (input.kind === "card") {
      const was = before as Card | undefined;
      const number = input.number?.replace(/[\s-]/g, "") || was?.number;
      if (!number || !/^\d{12,19}$/.test(number) || !luhn(number))
        throw new VaultRefused("This card number is not valid.");
      const expiry = input.expiry.trim();
      if (!/^(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/.test(expiry))
        throw new VaultRefused("Enter the expiry date as MM/YY.");
      const code = input.code?.trim() || was?.code;
      if (code && !/^\d{3,4}$/.test(code))
        throw new VaultRefused("The security code has three or four digits.");
      secret = { holder: input.holder.trim(), number, expiry, ...(code ? { code } : {}) };
      hint = `${brandOf(number)} ·· ${number.slice(-4)} · ${expiry.replace(/\s/g, "")}`;
    } else {
      const text = input.text ?? (before as Note | undefined)?.text ?? "";
      secret = { text };
    }
    const itemId = existing?.id ?? newId("vlt");
    const at = now();
    this.home.db.run(
      "insert into vault_item (id, kind, label, origin, hint, sealed, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do update set label = excluded.label, origin = excluded.origin, hint = excluded.hint, sealed = excluded.sealed, updated_at = excluded.updated_at",
      itemId,
      input.kind,
      label,
      origin,
      hint,
      this.sealFor(itemId, input.kind, secret),
      existing?.created_at ?? at,
      at,
    );
    this.log({
      itemId,
      label,
      action: existing ? "update" : "create",
      origin,
      agentId: null,
      reason: null,
    });
    return this.itemOf(this.row(itemId) as Row);
  }

  remove(id: string): boolean {
    const row = this.row(id);
    if (!row) return false;
    this.home.db.run("delete from vault_item where id = ?", id);
    this.log({
      itemId: id,
      label: row.label,
      action: "delete",
      origin: row.origin,
      agentId: null,
      reason: null,
    });
    return true;
  }

  /** The item's secret fields, for the person on a device. Every reveal is in the activity. */
  reveal(id: string): VaultSecret {
    const row = this.row(id);
    if (!row) throw new VaultRefused("This item is not in the Vault any more.");
    const secret = this.readable(row);
    if (!secret) throw new VaultRefused("The home can't open this item with its key.");
    this.log({
      itemId: id,
      label: row.label,
      action: "reveal",
      origin: row.origin,
      agentId: null,
      reason: null,
    });
    if (row.kind === "login") {
      const login = secret as Login;
      return {
        username: login.username,
        password: login.password,
        ...(login.authenticator ? { code: authenticatorCode(login.authenticator) } : {}),
      };
    }
    if (row.kind === "card") {
      const card = secret as Card;
      return {
        holder: card.holder,
        number: card.number,
        expiry: card.expiry,
        ...(card.code ? { cardCode: card.code } : {}),
      };
    }
    return { text: (secret as Note).text };
  }

  /**
   * Imports the logins of a password manager's CSV export. A login for the same website and
   * user name is replaced; one that has no authenticator key gets the export's.
   */
  import(csv: string): VaultImported {
    const { logins, unreadable, badKeys } = parsePasswordCsv(csv);
    let added = 0;
    let updated = 0;
    const kept = this.rows().filter((row) => row.kind === "login");
    for (const login of logins) {
      const same = kept.find((row) => {
        if (row.origin !== login.origin) return false;
        const secret = this.readable(row) as Login | undefined;
        return secret?.username === login.username;
      });
      this.home.db.transaction(() => {
        this.save(
          {
            kind: "login",
            label: same?.label ?? login.label,
            origin: login.origin,
            username: login.username,
            password: login.password,
            ...(login.authenticator ? { authenticator: login.authenticator } : {}),
          },
          same?.id,
        );
      });
      if (same) updated++;
      else added++;
    }
    this.log({
      itemId: null,
      label: String(added + updated),
      action: "import",
      origin: null,
      agentId: null,
      reason: null,
    });
    return { added, updated, unreadable, badKeys };
  }

  // ── What a model reads ────────────────────────────────────────────────────

  /** The text with every value the Vault entered in this conversation's browser replaced. */
  redact(conversationId: string, text: string): string {
    const values = this.entered.get(conversationId);
    if (!values?.size) return text;
    return redactor(values).text(text);
  }

  private remember(conversationId: string, ...values: string[]): void {
    const set = this.entered.get(conversationId) ?? new Set<string>();
    for (const value of values) if (value) set.add(value);
    this.entered.set(conversationId, set);
  }

  /** The logins that fit a page, as a model reads them. */
  private fitting(pageUrl: string): Row[] {
    return this.rows().filter(
      (row) => row.kind === "login" && row.origin && fits(row.origin, pageUrl),
    );
  }

  private describe(row: Row): string {
    return `"${row.label}" (${row.origin}, user ${row.hint || "none"})`;
  }

  tools(context: TurnContext): Tool[] {
    const { conversationId, agent } = context;
    const pages = this.home.browser.pages;
    return [
      defineTool({
        name: "vault_logins",
        description:
          "The saved logins that fit the page open in your browser: name, website and two letters of the user name. Never a password.",
        input: z.object({}),
        label: () => "Vault: logins",
        run: async () => {
          const url = await pages.url(conversationId);
          const rows = this.fitting(url);
          if (!rows.length)
            return `No saved login fits ${new URL(url).origin}. Ask the person to add one in the Vault, or to sign in themselves.`;
          return rows.map((row) => this.describe(row)).join("\n");
        },
      }),
      defineTool({
        name: "vault_sign_in",
        description:
          "Sign in on the page open in your browser with a saved login. Give the refs of the user name field, the password field and the button from your last snapshot. The person says yes first on a card; then the home enters the login privately: you never see the password. Afterwards take a new snapshot.",
        input: z.object({
          login: z.string().optional().describe("The login's name, when more than one fits."),
          usernameRef: z.string().optional().describe("Ref of the user name or email field."),
          passwordRef: z.string().describe("Ref of the password field."),
          submitRef: z.string().optional().describe("Ref of the sign-in button."),
          why: z.string().describe("One sentence for the person: why you sign in here."),
        }),
        label: () => "Vault: signing in",
        asks: true,
        run: async (input, call) => {
          const url = await pages.url(conversationId);
          const origin = new URL(url).origin;
          const kept = call.answer?.kept as { itemId: string; origin: string } | undefined;
          if (!(call.answer && kept)) {
            const rows = this.fitting(url);
            const named = input.login
              ? rows.filter((row) => row.label.toLowerCase() === input.login?.toLowerCase())
              : rows;
            if (!rows.length) {
              this.log({
                itemId: null,
                label: origin,
                action: "refused",
                origin,
                agentId: agent.id,
                reason: "No saved login fits this website.",
              });
              return `No saved login fits ${origin}. Ask the person to add one in the Vault.`;
            }
            if (named.length !== 1)
              return `Name the login to use:\n${rows.map((row) => this.describe(row)).join("\n")}`;
            const row = named[0] as Row;
            return call.ask(
              {
                kind: "approval",
                level: "needs_you",
                title: `Sign in to ${new URL(origin).host} as ${row.hint || row.label}?`,
                body: `${input.why}\n\nThe login **${row.label}** is entered on **${origin}** without the agent seeing the password.`,
                actions: [
                  { id: "once", label: "Sign in", style: "primary" },
                  { id: "deny", label: "Don't", style: "plain" },
                ],
              },
              { itemId: row.id, origin },
            );
          }
          if (call.answer.action !== "once") {
            const row = this.row(kept.itemId);
            this.log({
              itemId: kept.itemId,
              label: row?.label ?? "",
              action: "refused",
              origin: kept.origin,
              agentId: agent.id,
              reason: "The person said no.",
            });
            return "The person said no. Don't sign in another way.";
          }
          const row = this.row(kept.itemId);
          if (!row) return "That login is not in the Vault any more.";
          // The page may have moved on while the card waited: enter only where the yes was for.
          if (origin !== kept.origin || !row.origin || !fits(row.origin, url)) {
            this.log({
              itemId: row.id,
              label: row.label,
              action: "refused",
              origin,
              agentId: agent.id,
              reason: "The page is on another website now.",
            });
            return `The page is on ${origin} now, not ${kept.origin}. Nothing was entered.`;
          }
          const login = this.readable(row) as Login | undefined;
          if (!login) return "The home can't open this login with its key.";
          try {
            this.remember(conversationId, login.password, login.username);
            if (input.usernameRef && login.username)
              await pages.fillPrivately(conversationId, input.usernameRef, login.username, origin);
            await pages.fillPrivately(conversationId, input.passwordRef, login.password, origin);
            if (input.submitRef) await pages.click(conversationId, input.submitRef);
          } catch (error) {
            const reason =
              error instanceof FillRefused
                ? `${error.message} Nothing more was entered.`
                : "The page did not take the login.";
            this.log({
              itemId: row.id,
              label: row.label,
              action: "refused",
              origin,
              agentId: agent.id,
              reason,
            });
            return `${reason} Take a new snapshot and try again.`;
          }
          this.yes.set(conversationId, { itemId: row.id, origin, at: Date.now() });
          this.log({
            itemId: row.id,
            label: row.label,
            action: "sign_in",
            origin,
            agentId: agent.id,
            reason: input.why,
          });
          return `The login "${row.label}" was entered privately${input.submitRef ? " and sent" : ""}. Take a new snapshot to see the page.`;
        },
      }),
      defineTool({
        name: "vault_code",
        description:
          "Enter the current code of the authenticator kept with the login you just signed in with, into the code field by its ref. The home makes the code and enters it; you never see it.",
        input: z.object({
          codeRef: z.string().describe("Ref of the code field."),
          submitRef: z.string().optional().describe("Ref of the button that sends the code."),
        }),
        label: () => "Vault: entering the code",
        run: async (input) => {
          const yes = this.yes.get(conversationId);
          if (!yes || Date.now() - yes.at > YES_LASTS_MS)
            return "Sign in with vault_sign_in first: a code goes only with the login the person said yes to.";
          const row = this.row(yes.itemId);
          const login = row ? (this.readable(row) as Login | undefined) : undefined;
          if (!(row && login?.authenticator))
            return "This login has no authenticator key. Ask the person for the code.";
          const url = await pages.url(conversationId);
          const origin = new URL(url).origin;
          if (!row.origin || !fits(row.origin, url))
            return `The page is on ${origin}, not the login's website. Nothing was entered.`;
          try {
            const code = authenticatorCode(login.authenticator);
            this.remember(conversationId, code);
            await pages.fillPrivately(conversationId, input.codeRef, code, origin);
            if (input.submitRef) await pages.click(conversationId, input.submitRef);
          } catch (error) {
            return `${error instanceof FillRefused ? error.message : "The page did not take the code."} Take a new snapshot.`;
          }
          this.yes.delete(conversationId);
          this.log({
            itemId: row.id,
            label: row.label,
            action: "code",
            origin,
            agentId: agent.id,
            reason: null,
          });
          return "The code was entered privately. Take a new snapshot to see the page.";
        },
      }),
    ];
  }
}

export { OriginRefused };
