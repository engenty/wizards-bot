import type { ModelService, ModelSource } from "@wizards-bot/protocol";
import type { Db } from "../store/db.ts";

/** The company behind a subscription client or a gateway preset, by its id. */
const KNOWN: Record<string, { id: string; label: string }> = {
  claude: { id: "anthropic", label: "Anthropic" },
  anthropic: { id: "anthropic", label: "Anthropic" },
  codex: { id: "openai", label: "OpenAI" },
  openai: { id: "openai", label: "OpenAI" },
  openrouter: { id: "openrouter", label: "OpenRouter" },
  vercel: { id: "vercel", label: "Vercel" },
};

/**
 * The service outside the person's own computers that a source sends what it reads to. Ollama
 * runs on a computer of the person and has none. A linked computer's source keeps its own id
 * after the `/`.
 */
export function serviceOf(
  source: Pick<ModelSource, "id" | "kind" | "label">,
): { id: string; label: string } | undefined {
  if (source.kind === "ollama") return undefined;
  const own = source.id.slice(source.id.lastIndexOf("/") + 1);
  return KNOWN[own] ?? { id: own, label: source.label };
}

type Agreed = Record<string, { at: string; by: string }>;

const KEY = "models.agreed";

/** The services the person said yes to, kept by the home: one yes counts for all devices. */
export function agreed(db: Db): Agreed {
  return JSON.parse(db.meta(KEY) ?? "{}") as Agreed;
}

export function agree(db: Db, ids: string[], by: string): void {
  const at = new Date().toISOString();
  const all = agreed(db);
  for (const id of ids) all[id] = { at, by };
  db.setMeta(KEY, JSON.stringify(all));
}

/** Takes a yes back: a device asks again before the next message goes to that service. */
export function takeBack(db: Db, id: string): void {
  const all = agreed(db);
  delete all[id];
  db.setMeta(KEY, JSON.stringify(all));
}

/**
 * Every service a source sends to, with whether the home would use it now (`used` holds the
 * source ids of the model refs it tries), and every service the person said yes to.
 */
export function services(sources: ModelSource[], used: string[], yes: Agreed): ModelService[] {
  const found = new Map<string, ModelService>();
  for (const source of sources) {
    const service = serviceOf(source);
    if (!service) continue;
    const entry = found.get(service.id) ?? { ...service, sources: [], inUse: false };
    if (!entry.sources.includes(source.label)) entry.sources.push(source.label);
    if (used.includes(source.id)) entry.inUse = true;
    found.set(service.id, entry);
  }
  for (const [id, at] of Object.entries(yes)) {
    const entry = found.get(id) ?? { id, label: KNOWN[id]?.label ?? id, sources: [], inUse: false };
    found.set(id, { ...entry, agreed: at });
  }
  return [...found.values()];
}
