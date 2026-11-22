import assert from "node:assert/strict";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { test } from "node:test";
import type { Card } from "@wizards-bot/protocol";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import type { ChannelContext, Incoming } from "./channels.ts";
import {
  email,
  emailAdapter,
  endpoint,
  incomingMail,
  type MailThread,
  outgoingMail,
  replyText,
} from "./email.ts";

const OWN = "agent@example.com";

const mail = (headers: string[], body: string) => simpleParser([...headers, "", body].join("\r\n"));

const context: ChannelContext = { receive: () => {}, publicUrl: undefined, log: () => {} };

test("a plain mail stays as it is", () => {
  assert.equal(
    replyText("Book the table for four.\r\n\r\nAt eight, if they have it.\r\n"),
    "Book the table for four.\n\nAt eight, if they have it.",
  );
});

test("an answer above the quoted mail keeps only the answer", () => {
  const text = [
    "Yes, send it.",
    "",
    "On Tue, 3 Nov 2026 at 10:12, wizards.bot <agent@example.com> wrote:",
    "",
    "> Shall I send the mail to Anna?",
    ">",
    "> 1: Send   2: Not now",
  ].join("\n");
  assert.equal(replyText(text), "Yes, send it.");
});

test("the line above the quote may be broken in two", () => {
  const text = [
    "2",
    "",
    "On Tue, 3 Nov 2026 at 10:12, wizards.bot with a long name <agent@example.com>",
    "wrote:",
    "> Shall I send the mail to Anna?",
  ].join("\n");
  assert.equal(replyText(text), "2");
  // The same without marks before the quoted lines.
  assert.equal(replyText(text.replace("> ", "")), "2");
});

test("an answer below the quoted mail stays", () => {
  const text = [
    "Am 03.11.2026 um 10:12 schrieb wizards.bot <agent@example.com>:",
    "> Soll ich die Mail an Anna senden?",
    "> Antworte mit der Zahl.",
    "",
    "Ja, aber erst morgen früh.",
  ].join("\n");
  assert.equal(replyText(text), "Ja, aber erst morgen früh.");
});

test("a quote without marks ends the text", () => {
  const outlook = [
    "Not now, I call her first.",
    "",
    "From: wizards.bot <agent@example.com>",
    "Sent: Tuesday, 3 November 2026 10:12",
    "To: Mara <mara@example.com>",
    "Subject: Send the mail to Anna?",
    "",
    "Shall I send the mail to Anna?",
  ].join("\n");
  assert.equal(replyText(outlook), "Not now, I call her first.");

  const original = [
    "Mach das.",
    "",
    "-----Ursprüngliche Nachricht-----",
    "Von: wizards.bot",
    "Soll ich?",
  ].join("\n");
  assert.equal(replyText(original), "Mach das.");

  const apple = [
    "Do it.",
    "",
    "On 3 Nov 2026, at 10:12, wizards.bot <agent@example.com> wrote:",
    "",
    "Shall I?",
  ].join("\n");
  assert.equal(replyText(apple), "Do it.");
});

test("the signature is cut off", () => {
  assert.equal(
    replyText("Call the dentist.\n\n-- \nMara Example\n+49 30 1234567"),
    "Call the dentist.",
  );
  assert.equal(replyText("Call the dentist.\n\nSent from my iPhone"), "Call the dentist.");
  assert.equal(
    replyText("Ruf beim Zahnarzt an.\n\nGesendet von meinem iPhone\n\n> alt"),
    "Ruf beim Zahnarzt an.",
  );
  // A sentence that only starts like the line of a mail program stays.
  assert.equal(
    replyText("From: is the field I mean.\nChange it."),
    "From: is the field I mean.\nChange it.",
  );
});

test("a new mail is heard with its subject and remembers its thread", async () => {
  const parsed = await mail(
    [
      "From: Mara Example <Mara@Example.com>",
      `To: ${OWN}`,
      "Subject: Dentist",
      "Message-ID: <m1@example.com>",
      "Content-Type: text/plain; charset=utf-8",
    ],
    "Find me an appointment next week.\r\n\r\n-- \r\nMara",
  );
  const incoming = incomingMail(parsed, OWN);
  assert.equal(incoming?.from, "mara@example.com");
  assert.equal(incoming?.text, "Dentist\n\nFind me an appointment next week.");
  assert.deepEqual(JSON.parse(incoming?.thread ?? ""), {
    messageId: "<m1@example.com>",
    subject: "Dentist",
    references: [],
  } satisfies MailThread);
});

test("an answer is heard without its subject and without the quote", async () => {
  const parsed = await mail(
    [
      "From: mara@example.com",
      "Subject: Re: Dentist",
      "Message-ID: <m3@example.com>",
      "In-Reply-To: <m2@example.com>",
      "References: <m1@example.com> <m2@example.com>",
    ],
    "1\r\n\r\nOn Tue, 3 Nov 2026 at 10:12, wizards.bot <agent@example.com> wrote:\r\n> Tuesday at nine?\r\n> 1: Book it   2: Not now",
  );
  const incoming = incomingMail(parsed, OWN);
  assert.equal(incoming?.text, "1");
  assert.deepEqual(JSON.parse(incoming?.thread ?? ""), {
    messageId: "<m3@example.com>",
    subject: "Re: Dentist",
    references: ["<m1@example.com>", "<m2@example.com>"],
  });
});

test("a mail in HTML only is heard as text", async () => {
  const parsed = await mail(
    ["From: mara@example.com", "Subject: Re: Dentist", "Content-Type: text/html; charset=utf-8"],
    "<p>Book it for <b>Tuesday</b>.</p>",
  );
  assert.equal(incomingMail(parsed, OWN)?.text, "Book it for Tuesday.");
});

test("a forwarded mail is heard whole", async () => {
  const parsed = await mail(
    ["From: mara@example.com", "Subject: Fwd: Invoice 118"],
    "Pay this one.\r\n\r\n---------- Forwarded message ---------\r\nFrom: Shop <shop@example.com>\r\nDate: Mon, 2 Nov 2026\r\n\r\nYour invoice is 40 euros.",
  );
  const text = incomingMail(parsed, OWN)?.text ?? "";
  assert.match(text, /^Fwd: Invoice 118\n\nPay this one\./);
  assert.match(text, /Your invoice is 40 euros\.$/);
});

test("the agent's own mail, automatic answers and empty mails are dropped", async () => {
  const own = await mail(
    ["From: wizards.bot <AGENT@example.com>", "Subject: Dentist"],
    "Tuesday at nine?",
  );
  assert.equal(incomingMail(own, OWN), undefined);

  const away = await mail(
    ["From: mara@example.com", "Subject: Out of office", "Auto-Submitted: auto-replied"],
    "I am back on Monday.",
  );
  assert.equal(incomingMail(away, OWN), undefined);

  const empty = await mail(
    ["From: mara@example.com", "Subject: Re: Dentist"],
    "> Tuesday at nine?",
  );
  assert.equal(incomingMail(empty, OWN), undefined);

  const typed = await mail(
    ["From: mara@example.com", "Subject: Dentist", "Auto-Submitted: no"],
    "Book it.",
  );
  assert.equal(incomingMail(typed, OWN)?.text, "Dentist\n\nBook it.");
});

const card: Card = {
  id: "crd_1",
  kind: "approval",
  level: "needs_you",
  state: "open",
  title: "Book Tuesday at nine?",
  actions: [
    { id: "book", label: "Book it", style: "primary" },
    { id: "cancel", label: "Not now", style: "plain" },
  ],
  agentId: "agt_1",
  conversationId: "cnv_1",
  messageId: "msg_1",
  createdAt: "2026-11-21T10:00:00.000Z",
};

test("an answer goes into the thread of the mail it answers", async () => {
  const thread: MailThread = {
    messageId: "<m3@example.com>",
    subject: "Dentist",
    references: ["<m1@example.com>", "<m2@example.com>"],
  };
  const message = outgoingMail(OWN, "mara@example.com", {
    text: "The dentist has time on Tuesday.",
    cards: [card],
    thread: JSON.stringify(thread),
  });
  assert.deepEqual(message, {
    from: OWN,
    to: "mara@example.com",
    subject: "Re: Dentist",
    text: "The dentist has time on Tuesday.\n\nBook Tuesday at nine?\n1: Book it   2: Not now\nReply with the number.",
    inReplyTo: "<m3@example.com>",
    references: ["<m1@example.com>", "<m2@example.com>", "<m3@example.com>"],
  });

  // The headers as a mail server gets them.
  const sent = await createTransport({ streamTransport: true, buffer: true }).sendMail(message);
  const source = (sent.message as Buffer).toString("utf8");
  assert.match(source, /^Subject: Re: Dentist$/m);
  assert.match(source, /^In-Reply-To: <m3@example\.com>$/m);
  assert.match(source, /^References: <m1@example\.com> <m2@example\.com> <m3@example\.com>$/m);
  assert.match(source, /^Content-Type: text\/plain/m);

  const again = outgoingMail(OWN, "mara@example.com", {
    text: "Booked.",
    cards: [],
    thread: JSON.stringify({ ...thread, subject: "AW: Dentist" }),
  });
  assert.equal(again.subject, "AW: Dentist");
});

test("a mail the agent starts takes its first line as the subject", () => {
  const message = outgoingMail(OWN, "mara@example.com", {
    text: "## Your **week**\n\nThree things are open.",
    cards: [],
  });
  assert.deepEqual(message, {
    from: OWN,
    to: "mara@example.com",
    subject: "Your week",
    text: "## Your **week**\n\nThree things are open.",
  });

  const long = outgoingMail(OWN, "mara@example.com", {
    text: "word ".repeat(40),
    cards: [],
    thread: "not json",
  });
  assert.equal(long.subject.length, 70);
  assert.ok(long.subject.endsWith("…"));
  assert.equal("inReplyTo" in long, false);
});

test("a server name may carry its port", () => {
  assert.deepEqual(endpoint("imap.example.com", 993), { host: "imap.example.com", port: 993 });
  assert.deepEqual(endpoint(" smtp.example.com:587 ", 465), {
    host: "smtp.example.com",
    port: 587,
  });
  assert.deepEqual(endpoint("", 465), { host: "", port: 465 });
});

test("start says in plain words what is missing or out of reach", async () => {
  const settings = {
    address: OWN,
    password: "secret",
    imap: "imap.example.com",
    smtp: "smtp.example.com",
  };
  await assert.rejects(email.start({ ...settings, address: "agent" }, context), {
    message: "The email address is missing or has no @",
  });
  await assert.rejects(email.start({ ...settings, password: "" }, context), {
    message: "The password is missing",
  });
  await assert.rejects(email.start({ ...settings, imap: "" }, context), {
    message: "The IMAP server is missing",
  });

  // A port on this computer where nothing listens.
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    email.start({ ...settings, smtp: `127.0.0.1:${port}`, imap: `127.0.0.1:${port}` }, context),
    /^Error: 127\.0\.0\.1 does not answer: /,
  );
});

// ── The mailbox itself, against mail servers on this computer ───────────────

interface Stored {
  uid: number;
  seen: boolean;
  source: string;
}

interface FakeMail {
  /** `host:port` of the IMAP and of the SMTP server. */
  imap: string;
  smtp: string;
  mails: Stored[];
  /** What the SMTP server took. */
  sent: { from: string; to: string; source: string }[];
  /** How often someone signed in over IMAP. */
  logins: number;
  /** The server that refuses the password. */
  refuses: "imap" | "smtp" | undefined;
  /** Puts a mail into the inbox and tells whoever has it open. */
  deliver(headers: string[], body: string): void;
  /** Cuts every open IMAP connection. */
  drop(): void;
  close(): Promise<void>;
}

/** An IMAP and an SMTP server that know just the commands the adapter's libraries send. */
async function fakeMail(): Promise<FakeMail> {
  const open = new Set<Socket>();
  const watching = new Set<Socket>();
  const lines = (socket: Socket, handle: (line: string) => void): void => {
    let buffer = "";
    open.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      open.delete(socket);
      watching.delete(socket);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        handle(line);
      }
    });
  };

  const state: FakeMail = {
    imap: "",
    smtp: "",
    mails: [],
    sent: [],
    logins: 0,
    refuses: undefined,
    deliver(headers, body) {
      const source = [...headers, "", body].join("\r\n");
      state.mails.push({ uid: state.mails.length + 1, seen: false, source });
      for (const socket of watching) socket.write(`* ${state.mails.length} EXISTS\r\n`);
    },
    drop() {
      for (const socket of watching) socket.destroy();
    },
    async close() {
      for (const socket of open) socket.destroy();
      await Promise.all(
        [imap, smtp].map((server) => new Promise((resolve) => server.close(resolve))),
      );
    },
  };

  const imap = createServer((socket) => {
    let idle: string | undefined;
    const write = (...answers: string[]): void =>
      void socket.write(answers.map((answer) => `${answer}\r\n`).join(""));
    write("* OK IMAP4rev1 ready");
    lines(socket, (line) => {
      if (idle && line.toUpperCase() === "DONE") {
        write(`${idle} OK IDLE ended`);
        idle = undefined;
        return;
      }
      const [, tag = "*", command = "", rest = ""] = /^(\S+) (UID \S+|\S+) ?(.*)$/.exec(line) ?? [];
      // The uids a command names: `1`, `1,3` or `2:4`.
      const named = (): Stored[] => {
        const uids = new Set<number>();
        for (const part of (rest.split(" ")[0] ?? "").split(",")) {
          const [from, to = from] = part.split(":").map(Number);
          for (let uid = from ?? 0; uid <= (to ?? 0); uid++) uids.add(uid);
        }
        return state.mails.filter((stored) => uids.has(stored.uid));
      };
      switch (command.toUpperCase()) {
        case "CAPABILITY":
          return write("* CAPABILITY IMAP4rev1 IDLE", `${tag} OK`);
        case "LOGIN":
          if (state.refuses === "imap")
            return write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
          state.logins++;
          return write(`${tag} OK`);
        case "LIST":
          return write(`* LIST (\\HasNoChildren) "/" ${rest.split(" ")[1] ?? '""'}`, `${tag} OK`);
        case "SELECT":
          watching.add(socket);
          return write(
            `* ${state.mails.length} EXISTS`,
            "* 0 RECENT",
            "* FLAGS (\\Seen)",
            "* OK [PERMANENTFLAGS (\\Seen)]",
            "* OK [UIDVALIDITY 1]",
            `* OK [UIDNEXT ${state.mails.length + 1}]`,
            `${tag} OK [READ-WRITE]`,
          );
        case "UID SEARCH": {
          const unseen = state.mails.filter((stored) => !stored.seen).map((stored) => stored.uid);
          return write(`* SEARCH ${unseen.join(" ")}`.trimEnd(), `${tag} OK`);
        }
        case "UID FETCH":
          for (const stored of named()) {
            const length = Buffer.byteLength(stored.source);
            write(
              `* ${stored.uid} FETCH (UID ${stored.uid} BODY[]<0> {${length}}\r\n${stored.source})`,
            );
          }
          return write(`${tag} OK`);
        case "UID STORE":
          for (const stored of named()) {
            stored.seen = true;
            write(`* ${stored.uid} FETCH (UID ${stored.uid} FLAGS (\\Seen))`);
          }
          return write(`${tag} OK`);
        case "IDLE":
          idle = tag;
          return write("+ idling");
        case "NOOP":
          return write(`${tag} OK`);
        case "LOGOUT":
          write("* BYE", `${tag} OK`);
          return void socket.end();
        default:
          return write(`${tag} BAD ${command} is not known here`);
      }
    });
  });

  const smtp = createServer((socket) => {
    let from = "";
    let to = "";
    let data: string[] | undefined;
    const write = (answer: string): void => void socket.write(`${answer}\r\n`);
    write("220 mail.test ESMTP");
    lines(socket, (line) => {
      if (data) {
        if (line !== ".") return void data.push(line);
        state.sent.push({ from, to, source: data.join("\n") });
        data = undefined;
        return write("250 Taken");
      }
      const verb = line.split(/[ :]/)[0]?.toUpperCase();
      if (verb === "EHLO") return void socket.write("250-mail.test\r\n250 AUTH PLAIN\r\n");
      if (verb === "AUTH")
        return write(state.refuses === "smtp" ? "535 Invalid credentials" : "235 Welcome");
      if (verb === "MAIL") from = /<(.*)>/.exec(line)?.[1] ?? "";
      if (verb === "RCPT") to = /<(.*)>/.exec(line)?.[1] ?? "";
      if (verb === "DATA") {
        data = [];
        return write("354 Go on");
      }
      if (verb === "QUIT") {
        write("221 Bye");
        return void socket.end();
      }
      write("250 OK");
    });
  });

  for (const server of [imap, smtp]) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }
  state.imap = `127.0.0.1:${(imap.address() as AddressInfo).port}`;
  state.smtp = `127.0.0.1:${(smtp.address() as AddressInfo).port}`;
  return state;
}

/** Waits until `look` finds something. */
async function until<T>(look: () => T | undefined | false | null, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = look();
    if (found) return found;
    if (Date.now() > end) throw new Error("Waited too long.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the mailbox is read, watched, found again and answered", async () => {
  const fake = await fakeMail();
  const received: Incoming[] = [];
  const logs: string[] = [];
  const hears: ChannelContext = {
    receive: (incoming) => received.push(incoming),
    publicUrl: undefined,
    log: (line) => logs.push(line),
  };
  const settings = { address: OWN, password: "secret", imap: fake.imap, smtp: fake.smtp };
  const adapter = emailAdapter({ plain: true, retry: 10 });

  // A mail that came while the home was off.
  fake.deliver(
    ["From: Mara <mara@example.com>", "Subject: Hello", "Message-ID: <m1@example.com>"],
    "claim 4821",
  );
  let stop = (): void => {};
  try {
    stop = await adapter.start(settings, hears);
    assert.deepEqual(
      received.map((incoming) => [incoming.from, incoming.text]),
      [["mara@example.com", "Hello\n\nclaim 4821"]],
    );
    assert.equal(fake.mails[0]?.seen, true);

    // A mail that arrives while the home waits in the inbox.
    fake.deliver(
      ["From: mara@example.com", "Subject: Dentist", "Message-ID: <m2@example.com>"],
      "Find an appointment.",
    );
    await until(() => received.length === 2);
    assert.equal(received[1]?.text, "Dentist\n\nFind an appointment.");
    await until(() => fake.mails[1]?.seen);

    // The agent's own mail is marked as seen and not heard.
    fake.deliver([`From: ${OWN}`, "Subject: Re: Dentist"], "Tuesday at nine?");
    await until(() => fake.mails[2]?.seen);
    assert.equal(received.length, 2);

    // The connection breaks. What arrives until the home is back is heard then.
    fake.drop();
    fake.deliver(
      [
        "From: mara@example.com",
        "Subject: Re: Dentist",
        "Message-ID: <m4@example.com>",
        "References: <m2@example.com>",
      ],
      "1\r\n\r\n> Tuesday at nine?",
    );
    await until(() => received.length === 3);
    assert.equal(received[2]?.text, "1");
    assert.equal(fake.logins, 2);
    assert.deepEqual(logs, []);

    await adapter.send(settings, "mara@example.com", {
      text: "Booked.",
      cards: [],
      thread: received[2]?.thread,
    });
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]?.from, OWN);
    assert.equal(fake.sent[0]?.to, "mara@example.com");
    assert.match(fake.sent[0]?.source ?? "", /^Subject: Re: Dentist$/m);
    assert.match(fake.sent[0]?.source ?? "", /^In-Reply-To: <m4@example\.com>$/m);
    assert.match(fake.sent[0]?.source ?? "", /^References: <m2@example\.com> <m4@example\.com>$/m);
    assert.match(fake.sent[0]?.source ?? "", /^Booked\.$/m);
    // After the stop the home leaves the mailbox and does not come back.
    stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fake.logins, 2);
  } finally {
    stop();
    await fake.close();
  }
});

test("start says which mail server refuses the password", async () => {
  const fake = await fakeMail();
  const settings = { address: OWN, password: "wrong", imap: fake.imap, smtp: fake.smtp };
  const adapter = emailAdapter({ plain: true, retry: 10 });
  const refused =
    "127.0.0.1 did not accept the address and the password. Many providers want an app password here";
  try {
    fake.refuses = "smtp";
    await assert.rejects(adapter.start(settings, context), { message: refused });
    assert.equal(fake.logins, 0);

    fake.refuses = "imap";
    await assert.rejects(adapter.start(settings, context), { message: refused });
    // A refused start does not keep trying.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fake.logins, 0);
  } finally {
    await fake.close();
  }
});
