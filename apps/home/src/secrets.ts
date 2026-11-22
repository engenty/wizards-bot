import type { SecretEntry } from "@wizards-bot/protocol";
import type { Home } from "./home.ts";

/**
 * The secrets the person gave the home, as the settings list them: what uses each one and when
 * it was set. Never a value. The home's own secrets (the push key, the key of published pages)
 * are not the person's and are left out, and so is a secret whose user is gone.
 */
export function secretEntries(home: Home): SecretEntry[] {
  const gateways = new Map(home.models.gateways().map((g) => [g.id, g.label]));
  const connections = new Map(home.connections.list().map((c) => [c.id, c.name]));
  const agentName = (id: string) =>
    home.db.get<{ name: string }>("select name from agent where id = ?", id)?.name;
  const entries: SecretEntry[] = [];
  for (const { name, updatedAt } of home.secrets.list()) {
    const [kind = "", id = ""] = name.split(".");
    const label =
      name === "account.gateway"
        ? "wizards.bot"
        : kind === "gateway"
          ? gateways.get(id)
          : kind === "connection"
            ? connections.get(id)
            : kind === "channel"
              ? home.channels.labelOf(id)
              : kind === "outside"
                ? agentName(id)
                : undefined;
    if (label === undefined) continue;
    entries.push({
      name,
      kind: name === "account.gateway" ? "account" : (kind as SecretEntry["kind"]),
      label,
      setAt: updatedAt,
    });
  }
  return entries;
}
