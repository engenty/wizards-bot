import type { PublishedLink } from "@wizards-bot/protocol";
import { LINK_LASTS, LINK_PASSWORD_MIN } from "@wizards-bot/protocol/limits";

export { LINK_LASTS, LINK_PASSWORD_MIN };

/** A title as the name of a file: nothing a file system refuses, not too long, never empty. */
export function fileName(title: string, ending: string): string {
  const name = title
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what a file name must not hold
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${name || "document"}.${ending}`;
}

/** A document's text as a Markdown file, named after its title. */
export function documentFile(document: { title: string; content: string }): File {
  return new File([document.content], fileName(document.title, "md"), { type: "text/markdown" });
}

/** An artifact's page, as the home serves it, as an HTML file named after its title. */
export function pageFile(title: string, page: Blob): File {
  return new File([page], fileName(title, "html"), { type: "text/html" });
}

/** Whether what is typed can be a link's password: nothing (no password), or long enough. */
export function passwordFits(password: string): boolean {
  return password.length === 0 || password.length >= LINK_PASSWORD_MIN;
}

/** Whether a link shows an earlier version than the one the person is looking at. */
export function showsEarlier(link: Pick<PublishedLink, "version">, version: number): boolean {
  return link.version < version;
}

/** When a link stops working, short enough for a row on a phone: "28 Nov, 10:43". */
export function endsAt(iso: string, now: Date, lang: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleString(lang, {
        day: "numeric",
        month: "short",
        ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** The part of a browser that hands something to another app. */
type Sharer = Partial<Pick<Navigator, "share" | "canShare">>;

/** Whether this browser's share sheet takes `data`: a link, or a file of this kind. */
export function canShare(sharer: Sharer, data: ShareData): boolean {
  if (typeof sharer.share !== "function") {
    return false;
  }
  // Without `canShare` a browser shares links and text only.
  return typeof sharer.canShare === "function" ? sharer.canShare(data) : !data.files?.length;
}

/**
 * Opens the browser's share sheet. `closed`: the person closed it without choosing.
 * `unavailable`: this browser has none for this, and the caller offers a download or a copy.
 */
export async function shareOut(
  sharer: Sharer,
  data: ShareData,
): Promise<"shared" | "closed" | "unavailable"> {
  if (!canShare(sharer, data)) {
    return "unavailable";
  }
  try {
    await sharer.share?.(data);
    return "shared";
  } catch (err) {
    return (err as Error)?.name === "AbortError" ? "closed" : "unavailable";
  }
}

/** Saves a file through the browser's own download. */
/**
 * Prints a page of the home through the browser's print dialog, where "Save as PDF" makes the
 * file. The page runs no script here: its frame may print and nothing else.
 */
export function printPage(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  frame.srcdoc = html;
  frame.addEventListener(
    "load",
    () => {
      const view = frame.contentWindow;
      view?.addEventListener("afterprint", () => frame.remove());
      view?.focus();
      view?.print();
      setTimeout(() => frame.remove(), 60_000);
    },
    { once: true },
  );
  document.body.append(frame);
}

export function download(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Puts a text on the clipboard. Where the browser offers no clipboard (a page on plain http,
 * e.g. the home at its address in the home's network), a selected field and the copy command
 * do it.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const done = document.execCommand("copy");
  field.remove();
  if (!done) {
    throw new Error("Copying did not work here.");
  }
}
