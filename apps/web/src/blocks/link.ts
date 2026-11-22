/**
 * The address a link in a document may open: a web address or one that writes an email. A
 * document is text an agent wrote, so nothing else is followed, and never a script.
 */
export function opens(href: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : null;
}
