import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { setClientFolders } from "@engenty/local-models/clients";
import { SERVERS, serversHere } from "@engenty/local-models/servers";
import { OFFERED_MODELS } from "@engenty/model-setup";
import {
  ClientSetup,
  LocalModels,
  setupRoutes,
  Terminals,
  Tested,
} from "@engenty/model-setup/server";
import type { Hono } from "hono";
import { z } from "zod";
import type { Home } from "../home.ts";
import { GATEWAY_PRESETS, type Gateway } from "../models/models.ts";
import { isServer, MEMORY_SHARE } from "../models/ollama.ts";
import { probeGateway } from "./probes.ts";
import { GATEWAY_MODELS } from "./setup.ts";
import { langOf, say } from "./words.ts";

// The setup of what the wizards think with is engenty wizards' own (@engenty/model-setup): the
// same clients, the same routes, the same page as its studio. The home's side of it: where its
// clients, its keys and its pick are kept, and its test call.

const PROVIDERS = Object.keys(GATEWAY_MODELS) as [string, ...string[]];

const Change = z.object({
  /** A source's id; `own`: own keys, which are picked with the first key that works. */
  source: z.string().max(80).optional(),
  /** With a server: the model the person chose of those it holds. */
  model: z.string().max(120).optional(),
  /** An empty key takes the stored one away. */
  keys: z.partialRecord(z.enum(PROVIDERS), z.literal("")).optional(),
});

/** What a process the setup starts gets of the home's own environment: nothing of the home's. */
function cleanEnv(path: string | undefined): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("WIZARDS_")),
  );
  // npm beside the Node that runs the home, for a client that comes from npm.
  return {
    ...env,
    PATH: [dirname(process.execPath), path ?? process.env.PATH ?? ""].join(delimiter),
  };
}

/** The routes of the shared setup for a home on the person's own computer. */
export function sharedSetup(home: Home): Hono {
  const { models, setup, config, db, events } = home;
  const folder = join(config.dataDir, "clients");
  // A client the setup installed is found there.
  setClientFolders(() => [process.platform === "win32" ? folder : join(folder, "bin")]);

  const told = async () => {
    events.emit({ type: "models.updated", models: models.view() });
    await setup.changed();
  };
  const stored = (id: string) => models.gateways().some((gateway) => gateway.id === id);

  /** The model of the server the person picked. */
  const pickedModel = () => {
    const source = models.picked()?.[0] ?? "";
    return isServer(source) ? (models.serverModel(source) ?? null) : null;
  };

  return setupRoutes({
    clients: new ClientSetup({
      // The home's own list, read at each use.
      get clients() {
        return setup.clients;
      },
      folder: () => folder,
      env: cleanEnv,
    }),
    terminals: new Terminals(),
    workDir: () => {
      const dir = join(config.dataDir, "setup");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    // The home keeps every test's outcome itself (setup.ts).
    tested: new Tested({ read: async () => [], write: async () => {} }),
    // The models to download are the package's own list: the home asks no one for it.
    servers: serversHere().map(
      (id) =>
        new LocalModels({
          server: SERVERS[id],
          url: () => models.serverUrl(id),
          offered: () => OFFERED_MODELS[id],
          share: MEMORY_SHARE,
          logs: () => join(config.dataDir, "setup"),
          memory: () => models.memory,
          changed: () => void models.refresh(true).then(told, () => {}),
        }),
    ),
    models: {
      source: () => models.picked()?.[0] ?? "",
      settings: () => ({
        source: models.picked()?.[0] ?? null,
        model: pickedModel(),
        keys: Object.fromEntries(PROVIDERS.map((id) => [id, stored(id)])),
      }),
      async save(_c, body) {
        const { source, model, keys } = Change.parse(body);
        for (const id of Object.keys(keys ?? {})) models.removeGateway(id);
        if (source && setup.clients.some((client) => client.id === source)) {
          models.pickSource(source);
        }
        // A model that is there: choosing it picks its server, the test call then loads it.
        if (source && isServer(source) && model) {
          await models.refresh(true);
          models.pickSource(source);
          models.setOrder([`${source}:${model}`]);
          setup.forget(source);
        }
        await told();
      },
      classes: ["text"],
      async test() {
        const source = models.picked()?.[0];
        if (!source) throw new Error("Pick what your wizards think with first.");
        const view = await setup.test(source);
        const check = view.models.find((row) => row.id === source);
        if (check?.state !== "ok" && check?.state !== "warning") {
          throw new Error([check?.said, check?.todo].filter(Boolean).join(" ") || "No answer.");
        }
        return { ref: check.model ?? check.label, text: "OK" };
      },
      providers: PROVIDERS,
      async key(_c, provider, key) {
        const preset = GATEWAY_PRESETS[provider];
        const model = GATEWAY_MODELS[provider];
        if (!preset || !model) return { ok: false, message: null, text: null };
        const gateway: Gateway = { ...preset, models: [model] };
        const value = key?.trim() || home.secrets.get(`gateway.${provider}`);
        const found = await probeGateway(gateway, value, undefined, setup.gatewayFetch);
        if (found.state !== "ok" && found.state !== "warning") {
          return { ok: false, message: say(found.said, langOf(db)), text: null };
        }
        // The first key that works is the pick; another one joins the keys picked before.
        const picked = models.picked();
        const own = picked?.some((id) => stored(id));
        models.setGateway(gateway, value ?? "");
        if (!own) models.pickSource(provider);
        await setup.tested(provider, found);
        await told();
        return { ok: true, message: null, text: `${provider}:${model}` };
      },
      async server(_c, id) {
        models.pickSource(id);
        const view = id === "ollama" ? await setup.ollama(true) : await setup.test(id);
        const check = view.models.find((row) => row.id === id);
        const ok = check?.state === "ok" || check?.state === "warning";
        return {
          ok,
          message: ok ? null : (check?.said ?? null),
          text: ok && check?.model ? `${id}:${check.model}` : null,
        };
      },
    },
  });
}
