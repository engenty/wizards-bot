import {
  fits,
  type InstalledModel,
  SERVERS,
  type ServerId,
} from "@engenty/model-providers/servers";

// Which of Ollama's and LM Studio's models the home offers, asks first and pulls. Talking to the
// two is `@engenty/model-providers`.

/** Whether a source's id or kind is a server on a computer that runs open models. */
export const isServer = (id: string): id is ServerId => Object.hasOwn(SERVERS, id);

/**
 * A model larger than this share of the computer's memory leaves too little for everything
 * else that runs there: the computer swaps, and an answer takes minutes. A little over half: an
 * 18 GB model runs on a computer with 32 GB, as it does in practice, and a 20 GB one does not.
 */
export const MEMORY_SHARE = 0.55;

/**
 * Models with tools the setup offers to pull, largest first, with their size on disk. The setup
 * offers the largest that fits the computer (`MEMORY_SHARE`).
 */
export const SUGGESTED: readonly { model: string; size: number }[] = [
  { model: "qwen3:14b", size: 9.3e9 },
  { model: "qwen3:8b", size: 5.2e9 },
  { model: "qwen3:4b", size: 2.5e9 },
  { model: "qwen3:1.7b", size: 1.4e9 },
];

/** The model to pull on a computer with `memory` bytes: the largest that leaves it room. */
export function suggestedModel(memory: number): { model: string; size: number } {
  return (
    SUGGESTED.find((entry) => fits(entry, memory, MEMORY_SHARE)) ??
    (SUGGESTED[SUGGESTED.length - 1] as { model: string; size: number })
  );
}

/** Whether an address is this computer's own. */
export function onThisComputer(url: string): boolean {
  return URL.canParse(url) && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
}

/**
 * The models of the server at `url` that write text, in the order a home prefers them: those
 * that take tools first, then the largest that leaves the computer room, then the smallest of
 * those that do not. Empty when it does not answer. `memory` is what the computer it runs
 * on has, in bytes, when that is known.
 */
export async function chatModels(
  url: string,
  memory = Number.POSITIVE_INFINITY,
  doFetch?: typeof fetch,
  server: ServerId = "ollama",
): Promise<InstalledModel[]> {
  const leavesRoom = (model: InstalledModel) => fits(model, memory, MEMORY_SHARE);
  const models = await SERVERS[server].models(url, doFetch ? { fetch: doFetch } : {});
  return models
    .filter((model) => model.completion)
    .sort(
      (a, b) =>
        Number(b.tools) - Number(a.tools) ||
        Number(leavesRoom(b)) - Number(leavesRoom(a)) ||
        (leavesRoom(a) ? b.size - a.size : a.size - b.size),
    );
}
