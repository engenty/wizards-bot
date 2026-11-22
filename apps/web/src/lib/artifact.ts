/**
 * Whether the address of an artifact's page still opens it, with a minute to spare. The
 * address carries `until`, the second its key stops working.
 */
export function pageOpens(page: string, now: number): boolean {
  const until = Number(new URLSearchParams(page.split("?")[1] ?? "").get("until"));
  return until > 0 && until * 1000 - now > 60_000;
}
