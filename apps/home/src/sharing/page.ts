import { createHash } from "node:crypto";
import { Marked } from "marked";
import { PAGE_POLICY } from "../artifacts/page.ts";

// The pages a published link shows to someone who is no device of the home: a document as
// plain HTML, an artifact as closed off as in the pane, and the home's own short pages for a
// password and for a link that opens nothing. None of them runs a script of the home, sets a
// cookie or loads anything from an address.

/**
 * The one style sheet of the home's own pages. It is allowed by its hash, so no other style
 * applies: not one a document's text brought along.
 */
const STYLE = `
:root { color-scheme: light dark; --paper: #fbfaf8; --ink: #26231f; --soft: #6f6a63; --line: #e6e2dc; --wash: #f2efea; --link: #b5481a; }
@media (prefers-color-scheme: dark) {
  :root { --paper: #1b1a18; --ink: #ece9e4; --soft: #a39d94; --line: #35322e; --wash: #262421; --link: #f0915c; }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; overflow-wrap: break-word; }
h1, h2, h3, h4 { line-height: 1.25; margin: 2em 0 0.6em; }
h1 { font-size: 1.9rem; margin-top: 0; }
h2 { font-size: 1.4rem; }
h3 { font-size: 1.15rem; }
h4 { font-size: 1rem; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1.1em; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.25em 0; }
li > ul, li > ol { margin-bottom: 0; }
a { color: var(--link); text-underline-offset: 0.15em; }
img { max-width: 100%; height: auto; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid var(--line); color: var(--soft); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2.2em 0; }
code { font: 0.875em/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: var(--wash); padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: var(--wash); padding: 0.9em 1.1em; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; font-size: 0.9375rem; }
th, td { padding: 0.45em 0.8em; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { font-weight: 600; }
input[type="checkbox"] { margin-right: 0.4em; }
.small { max-width: 24rem; padding-top: 18vh; }
.small h1 { font-size: 1.25rem; margin-bottom: 0.4em; }
.small p { color: var(--soft); }
.small .wrong { color: var(--link); }
form { display: flex; gap: 0.5rem; margin-top: 1.4rem; }
input[type="password"] { flex: 1; min-width: 0; height: 2.75rem; padding: 0 0.9rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
input[type="password"]:focus { outline: 2px solid var(--link); outline-offset: 1px; }
button { height: 2.75rem; padding: 0 1.2rem; border: 0; border-radius: 999px; background: var(--ink); color: var(--paper); font: inherit; font-weight: 500; }
@page { margin: 16mm; }
@media print {
  body { background: #fff; color: #000; font-size: 11pt; }
  main { max-width: none; padding: 0; }
  pre, blockquote, table, img, tr { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
}
`;

const STYLE_HASH = `'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`;

/** What every published page answers with: kept out of search, out of caches, no referrer. */
export const PUBLISHED_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * A published document: no script, no address to load from, pictures only when they are
 * written into the text. It gets an origin of its own; a link in it opens in a new tab.
 */
export const DOCUMENT_POLICY = [
  "sandbox allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  `style-src ${STYLE_HASH}`,
  "img-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * A published artifact: closed off as in the pane (an origin of its own, scripts, the print
 * dialog, no address on the network), and no page may frame it.
 */
export const ARTIFACT_POLICY = `sandbox allow-scripts allow-modals; ${PAGE_POLICY}; frame-ancestors 'none'`;

/** The home's own short pages. The one for a password sends its form back to its own address. */
export const PLAIN_POLICY = [
  "default-src 'none'",
  `style-src ${STYLE_HASH}`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  );

/** A link leads to the web or writes an email. Anything else stays text. */
const LEADS_OUT = /^(https?:\/\/|mailto:)/i;
/** A picture written into the text itself. */
const PICTURE_IN_TEXT = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;

/**
 * Markdown as HTML with nothing in it that the text did not say in Markdown: HTML written
 * into the text is shown as text, a link leads to the web or stays text, and a picture
 * is shown only when it is part of the text.
 */
const markdown = new Marked({
  gfm: true,
  // A line break in the text is a line break on the page, as in the pane.
  breaks: true,
  renderer: {
    html({ text, block }) {
      if (/^\s*<!--[\s\S]*-->\s*$/.test(text)) return "";
      return block ? `<p>${escapeHtml(text.trim())}</p>\n` : escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const address = href.trim();
      if (!LEADS_OUT.test(address)) return text;
      const named = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(address)}"${named} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
    },
    image({ href, text }) {
      return PICTURE_IN_TEXT.test(href.trim())
        ? `<img src="${escapeHtml(href.trim())}" alt="${escapeHtml(text)}">`
        : escapeHtml(text);
    },
  },
});

/** A document's Markdown as the HTML a published page shows. */
export function renderMarkdown(text: string): string {
  return markdown.parse(text, { async: false });
}

const head = (title: string, lang: Lang): string =>
  `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>`;

/** The page of a published document. Its title is the heading unless the text brings one. */
export function documentPage(input: { title: string; content: string; lang: Lang }): string {
  const body = renderMarkdown(input.content);
  const heading = /^\s*<h1[\s>]/.test(body) ? "" : `<h1>${escapeHtml(input.title)}</h1>\n`;
  return `${head(input.title, input.lang)}
<body>
<main>
${heading}${body}</main>
</body>
</html>
`;
}

// ── The home's own pages ────────────────────────────────────────────────────

export type Lang = "en" | "de";

/** German for a reader whose browser asks for German first, English for everyone else. */
export const langOf = (acceptLanguage: string | undefined): Lang =>
  /^\s*de\b/i.test(acceptLanguage ?? "") ? "de" : "en";

const TEXTS = {
  en: {
    nothing: "This link opens nothing.",
    nothingHint: "Check that you have the whole link.",
    gone: "This link does not work any more.",
    goneHint: "Ask the person who sent it for a new one.",
    ask: "This link needs a password",
    askHint: "The person who sent you the link has it.",
    password: "Password",
    open: "Open",
    wrong: "This password is not right. Try again.",
    slow: "Too many wrong passwords. Wait ten minutes, then try again.",
  },
  de: {
    nothing: "Dieser Link öffnet nichts.",
    nothingHint: "Prüfe, ob du den ganzen Link hast.",
    gone: "Dieser Link funktioniert nicht mehr.",
    goneHint: "Frag die Person, die ihn dir geschickt hat, nach einem neuen.",
    ask: "Dieser Link braucht ein Passwort",
    askHint: "Die Person, die dir den Link geschickt hat, kennt es.",
    password: "Passwort",
    open: "Öffnen",
    wrong: "Dieses Passwort stimmt nicht. Versuch es noch einmal.",
    slow: "Zu viele falsche Passwörter. Warte zehn Minuten und versuch es dann noch einmal.",
  },
} as const;

/** A link that opens nothing (`nothing`) or no longer does (`gone`). It names nothing of the home. */
export function closedPage(which: "nothing" | "gone", lang: Lang): string {
  const text = TEXTS[lang];
  return `${head("wizards.bot", lang)}
<body>
<main class="small">
<h1>${text[which]}</h1>
<p>${text[`${which}Hint`]}</p>
</main>
</body>
</html>
`;
}

const INVITE = {
  en: {
    how: "Give this link to your agent in wizards.bot. It shows you what the invite is for, asks you, and joins.",
    once: "The link works once.",
    app: "Open in the wizards.bot app",
  },
  de: {
    how: "Gib diesen Link deinem Agenten in wizards.bot. Er zeigt dir, wofür die Einladung ist, fragt dich und tritt bei.",
    once: "Der Link gilt einmal.",
    app: "In der wizards.bot-App öffnen",
  },
} as const;

/**
 * An invite as someone sees it who opened its link in a browser: who invites to what, and
 * what to do with the link. On a phone with the app, the link below hands it to the app. It
 * names nothing else of the home.
 */
export function invitePage(input: { title: string; link: string; lang: Lang }): string {
  const text = INVITE[input.lang];
  return `${head("wizards.bot", input.lang)}
<body>
<main class="small">
<h1>${escapeHtml(input.title)}</h1>
<p>${text.how}</p>
<p><code>${escapeHtml(input.link)}</code></p>
<p><a href="wizardsbot://invite?link=${encodeURIComponent(input.link)}">${text.app}</a></p>
<p>${text.once}</p>
</main>
</body>
</html>
`;
}

/** Asks for a link's password. It says nothing about what the link shows. */
export function passwordPage(lang: Lang, problem?: "wrong" | "slow"): string {
  const text = TEXTS[lang];
  const form =
    problem === "slow"
      ? ""
      : `<form method="post" autocomplete="off">
<input type="password" name="password" aria-label="${text.password}" placeholder="${text.password}" maxlength="200" required autofocus>
<button type="submit">${text.open}</button>
</form>`;
  return `${head("wizards.bot", lang)}
<body>
<main class="small">
<h1>${text.ask}</h1>
<p${problem ? ' class="wrong" role="alert"' : ""}>${text[problem ?? "askHint"]}</p>
${form}
</main>
</body>
</html>
`;
}
