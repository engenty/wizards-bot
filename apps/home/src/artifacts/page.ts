import { D3_VERSION, d3Source, hasLibrary, importMap, LIB_PREFIX, THREE_VERSION } from "./libs.ts";

// An artifact is a page an agent wrote, so the home treats it as a stranger's page. It is
// served with a policy that gives it no address to ask: not the home's routes, not the
// network. What it shows is what is written in it.

/**
 * What a page may load, as the browser enforces it. No directive names an address: not one on
 * the network, and not the home. The libraries stand in the page itself (`contained` below);
 * `data:` in `script-src` is for the modules of the import map, whose address is their text.
 */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' data:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The policy as a response header. `sandbox` without `allow-same-origin` gives the page an
 * origin of its own, also when it is opened in a tab: it reads no storage and no cookie of
 * the home's web app. `allow-modals` is there for the print dialog. The home's own page frames
 * it, and with it the studio whose page shows the home's inside itself: a browser asks every
 * page above a frame.
 */
export const pageHeaderPolicy = (studio?: string): string =>
  `sandbox allow-scripts allow-modals; ${PAGE_POLICY}; frame-ancestors 'self'${studio ? ` ${studio}` : ""}`;

/**
 * The home's own styles. On the screen every rule sits in `:where()`, so any rule of the
 * page wins. On paper the rules that keep a chart whole are `!important`.
 */
const STYLE = `
:root { color-scheme: light; }
:where(*, *::before, *::after) { box-sizing: border-box; }
:where(html) { -webkit-text-size-adjust: 100%; }
:where(body) { margin: 0; padding: 24px; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1c1e; background: #fff; }
:where(svg[viewBox], img, canvas, video) { max-width: 100%; }
:where(svg[viewBox], img) { height: auto; }
:where(.sheet) { max-width: 182mm; margin: 0 auto; }
#artifact-note { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 2147483647; padding: 8px 12px; border: 1px solid #f0d2a0; border-radius: 8px; background: #fff4e5; color: #5f3b00; font: 13px/1.4 system-ui, sans-serif; }
@page { size: A4; margin: 14mm; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { max-width: none !important; margin: 0 !important; }
  .no-print, #artifact-note { display: none !important; }
  .page-break { break-before: page; }
  svg, canvas, img, video { max-width: 100% !important; }
  svg[viewBox], canvas, img { height: auto !important; max-height: 269mm; }
  svg, canvas, img, figure, table, pre, blockquote, tr, li { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
  * { animation-duration: 0s !important; transition-duration: 0s !important; }
}
`;

/**
 * The home's own script, first on the page. It prints when the frame around the page asks,
 * gives an SVG that has a pixel size and no viewBox a viewBox so it scales to the pane and
 * the paper, and says in one line when a script stopped or the page asked for something it
 * may not load. The same line goes to the frame around the page.
 */
const SCRIPT = String.raw`
(() => {
  const tell = (type, message) => {
    if (parent !== window) parent.postMessage({ source: "wizards-artifact", type, message }, "*");
  };
  addEventListener("message", (event) => {
    if (event.source === parent && event.data && event.data.type === "artifact.print") print();
  });

  const FITTED = "data-fitted";
  const PIXELS = /^\d+(\.\d+)?(px)?$/;
  const fit = () => {
    for (const svg of document.querySelectorAll("svg")) {
      if (svg.ownerSVGElement) continue;
      const box = svg.getAttribute("viewBox");
      const ours = svg.getAttribute(FITTED);
      // A viewBox the page set itself is the page's.
      if (box !== null && box !== ours) {
        if (ours !== null) svg.removeAttribute(FITTED);
        continue;
      }
      const width = svg.getAttribute("width") || "";
      const height = svg.getAttribute("height") || "";
      if (!PIXELS.test(width) || !PIXELS.test(height)) continue;
      const next = "0 0 " + parseFloat(width) + " " + parseFloat(height);
      if (next === box) continue;
      svg.setAttribute(FITTED, next);
      svg.setAttribute("viewBox", next);
    }
  };
  let waiting = false;
  const later = () => {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(() => {
      waiting = false;
      fit();
    });
  };
  new MutationObserver(later).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["width", "height"],
  });
  addEventListener("DOMContentLoaded", fit);
  addEventListener("load", fit);
  addEventListener("beforeprint", fit);

  const said = new Set();
  const note = (text) => {
    // The policy stands twice, in the header and in the page, and each reports.
    if (said.has(text)) return;
    said.add(text);
    tell("artifact.problem", text);
    const show = () => {
      let box = document.getElementById("artifact-note");
      if (!box) {
        box = document.createElement("div");
        box.id = "artifact-note";
        document.body.append(box);
      }
      if (box.childElementCount >= 3) return;
      const line = document.createElement("div");
      line.textContent = text;
      box.append(line);
    };
    if (document.body) show();
    else addEventListener("DOMContentLoaded", show);
  };
  addEventListener("error", (event) => {
    if (event.message) note("A script on this page stopped: " + event.message);
  });
  addEventListener("unhandledrejection", (event) => {
    const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
    note("A script on this page stopped: " + reason);
  });
  document.addEventListener("securitypolicyviolation", (event) => {
    note("This page asked for " + (event.blockedURI || "something it may not use") + ". An artifact loads nothing from outside itself.");
  });
})();
`;

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  );

/** A script's text, safe inside a `<script>`: nothing in it ends the tag or opens a comment. */
const inScript = (text: string): string =>
  text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

/**
 * What the agent wrote, with its libraries inside: the tag that loads D3 holds D3, and
 * `modules` are the names the scripts import, for the import map.
 */
function contained(content: string): { content: string; modules: string[] } {
  const modules = new Set<string>();
  const filled = content.replace(SCRIPT_TAG, (tag, attributes: string, body: string) => {
    for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
      for (const [, specifier = ""] of body.matchAll(pattern)) modules.add(specifier);
    }
    for (const [, name, double, single, bare] of attributes.matchAll(ADDRESS)) {
      if (name?.toLowerCase() !== "src") continue;
      if ((double ?? single ?? bare ?? "").trim() === `${LIB_PREFIX}d3.js`) {
        return `<script>${inScript(d3Source())}</script>`;
      }
    }
    return tag;
  });
  return { content: filled, modules: [...modules] };
}

/**
 * The page the home serves for an artifact, in one piece: it loads nothing. The home's head
 * comes first, so its policy holds for everything the agent wrote, and nothing the agent
 * wrote can come before it. What the agent wrote follows as the body: a whole document works
 * too, since a browser folds a second `<html>`, `<head>` and `<body>` into the first.
 */
export function wrapPage(input: { title: string; content: string }): string {
  const { content, modules } = contained(input.content);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="content-security-policy" content="${PAGE_POLICY}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(input.title)}</title>
<style>${STYLE}</style>
<script type="importmap">${JSON.stringify(importMap(modules))}</script>
<script>${SCRIPT}</script>
</head>
<body>
${content}
</body>
</html>
`;
}

/** A small page of the home's own, for a link that opens no artifact. */
export function plainPage(text: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>wizards.bot</title><body style="font: 17px system-ui; margin: 20vh auto; max-width: 24rem; padding: 0 1.5rem"><p>${escapeHtml(text)}</p>`;
}

// ── Checking a page before it is kept ───────────────────────────────────────

const COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE_TAG = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
/** Tags that load something from an address. A plain link (`<a>`) loads nothing. */
const LOADING_TAG =
  /<(script|link|img|image|use|feImage|iframe|frame|embed|object|video|audio|source|track)\b([^>]*)>/gi;
const ADDRESS =
  /(?:^|\s)(src|href|xlink:href|data|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const STATIC_IMPORT = /\bimport\s*(?:[\w*${}\s,]+?\bfrom\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const STYLE_ADDRESS = /(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?([^"')\s]+)/gi;
const ASKS =
  /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|d3\.(?:json|csv|tsv|dsv|text|xml|html|svg|image|blob|buffer))\s*\(/g;

/** An address that is part of the page itself. */
const inPage = (address: string): boolean =>
  address === "" || /^(#|data:|blob:)/i.test(address.trim());

const libraryName = (address: string): string | undefined =>
  address.startsWith(LIB_PREFIX) ? address.slice(LIB_PREFIX.length) : undefined;

function scriptHint(address: string): string {
  if (/d3/i.test(address)) return `Load D3 with <script src="${LIB_PREFIX}d3.js"></script>.`;
  if (/three/i.test(address))
    return 'Use three.js in a <script type="module"> with `import * as THREE from "three"`.';
  return `The only libraries are D3 (${LIB_PREFIX}d3.js) and three.js (import "three").`;
}

function checkImport(specifier: string): string | undefined {
  if (specifier === "three") return undefined;
  const name = specifier.startsWith("three/addons/") ? specifier : libraryName(specifier);
  if (name !== undefined) {
    return hasLibrary(name) ? undefined : `A script imports "${specifier}", which is not there.`;
  }
  if (specifier === "d3" || specifier.startsWith("d3-")) {
    return `A script imports "${specifier}". D3 is not imported: load it with <script src="${LIB_PREFIX}d3.js"></script> and use the global \`d3\`.`;
  }
  return `A script imports "${specifier}". Only "three" and "three/addons/…" can be imported.`;
}

/**
 * Reads a page for what cannot work once it is closed off. `refused` is what leaves the
 * page broken (something loaded from an address); `notes` is what will fail while it runs.
 * Both are sentences for the agent, which then writes the page again.
 */
export function checkPage(html: string): { refused: string[]; notes: string[] } {
  const refused = new Set<string>();
  const notes = new Set<string>();
  const scripts: string[] = [];
  const styles: string[] = [];
  // What is inside a script or a style is not markup: a tag in a string loads nothing.
  const markup = html
    .replace(COMMENT, "")
    .replace(SCRIPT_TAG, (_tag, attributes: string, body: string) => {
      scripts.push(body);
      return `<script${attributes}>`;
    })
    .replace(STYLE_TAG, (_tag, body: string) => {
      styles.push(body);
      return "";
    });

  for (const [, tag = "", attributes = ""] of markup.matchAll(LOADING_TAG)) {
    const name = tag.toLowerCase();
    for (const [, , double, single, bare] of attributes.matchAll(ADDRESS)) {
      const address = (double ?? single ?? bare ?? "").trim();
      if (inPage(address)) continue;
      if (name === "script") {
        // The one library a tag loads is D3; three.js is imported.
        if (libraryName(address) === "d3.js") continue;
        refused.add(`<script> loads ${address}. ${scriptHint(address)}`);
      } else if (name === "link") {
        refused.add(
          `<link> loads ${address}. Put the styles into a <style>, and use the fonts the computer has.`,
        );
      } else {
        refused.add(
          `<${name}> loads ${address}. Put it into the page as a data: address, or draw it.`,
        );
      }
    }
  }
  for (const body of scripts) {
    for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
      for (const [, specifier = ""] of body.matchAll(pattern)) {
        const problem = checkImport(specifier);
        if (problem) refused.add(problem);
      }
    }
    for (const [, call = ""] of body.matchAll(ASKS)) {
      notes.add(
        `The page calls ${call}(): it cannot ask any address for data, so this fails. Put the data into the page.`,
      );
    }
  }
  for (const body of styles) {
    for (const [, address = ""] of body.matchAll(STYLE_ADDRESS)) {
      if (!inPage(address))
        refused.add(`A <style> loads ${address}. Nothing outside the page loads.`);
    }
  }
  return { refused: [...refused], notes: [...notes] };
}

// ── What an agent is told ───────────────────────────────────────────────────

/** When an artifact is the right answer, and how its page is written. Part of every agent's instructions. */
export function artifactRules(person: string): string {
  return [
    "Artifacts:",
    `- An artifact is one page you write with \`artifact_write\`. ${person} sees it beside the chat and can print it or save it as a PDF. Make one when the answer is better looked at than read: a chart, a diagram, a 3D scene, a report on one page, something to explore. A text ${person} reads and edits is a document. A short answer stays in the chat.`,
    "- The page is HTML with its own <style> and <script>, all in one piece. It is closed off: nothing loads from the internet, it cannot ask any address for data, and its links do not open. Put the data into the page.",
    "- It is read in a narrow pane and on a phone too: give nothing a fixed width, and let rows of boxes wrap.",
    `- Charts and diagrams are SVG drawn with D3 ${D3_VERSION}: \`<script src="${LIB_PREFIX}d3.js"></script>\` gives you the global \`d3\`. Give every <svg> a viewBox and no fixed width, so it fits the pane and the paper.`,
    `- 3D is three.js ${THREE_VERSION} in a \`<script type="module">\`: \`import * as THREE from "three"\` and \`import { OrbitControls } from "three/addons/controls/OrbitControls.js"\`. Make the renderer with \`preserveDrawingBuffer: true\` so the scene prints, and size it to its box when the window changes.`,
    '- A report is one A4 page: put it in `<main class="sheet">`, which is at most as wide as the paper, and keep it under 1000 px high. A title, the few numbers that matter, one or two charts, short text. Dark text on white, and colours that still read on paper.',
    '- The Bot Server adds the print layout (A4, margins, no chart cut off). Give what is only for the screen, such as buttons and sliders, `class="no-print"`. For a wide page, add `@page { size: A4 landscape; }`.',
    `- Label the axes and the units, and name where the data comes from. Write the page in the language ${person} writes in. In the chat, say in one sentence what the page shows.`,
  ].join("\n");
}
