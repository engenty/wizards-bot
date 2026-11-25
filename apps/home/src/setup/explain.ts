// What a failed test call means, in one sentence the person can act on. The client's or the
// service's own words are matched; the sentence and what to do are the Bot Server's, in both
// languages (words.ts).
import { type Client, failureCode } from "@engenty/local-models/clients";
import { type Words, w } from "./words.ts";

/** What a check found: the sentence, what to do, and a command when a terminal is the way. */
export interface Finding {
  said: Words;
  todo?: Words;
  command?: string;
}

/** The first line of what a client or a service said, short enough for one sentence. */
export function firstLine(detail: string): string {
  const line =
    detail
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/** "<name> did not answer: <what it said>." */
export const silent = (name: string, detail: string): Words => {
  const why = firstLine(detail);
  return w(
    `${name} did not answer: ${why || "no reason given"}.`,
    `${name} hat nicht geantwortet: ${why || "ohne Grund"}.`,
  );
};

/** Why Claude Code did not answer. */
export function explainClaude(detail: string): Finding {
  if (/specified API usage limits|API usage limit/i.test(detail)) {
    return {
      said: w(
        "Claude Code is signed in with an API key whose usage limit is reached.",
        "Claude Code ist mit einem API-Schlüssel angemeldet, dessen Limit erreicht ist.",
      ),
      todo: w(
        "Raise the key's limit in the Anthropic Console, or sign in with your subscription instead: run claude, then /login.",
        "Erhöhe das Limit in der Anthropic Console, oder melde dich mit deinem Abo an: starte claude, dann /login.",
      ),
      command: "claude",
    };
  }
  if (/credit balance|too low|billing/i.test(detail)) {
    return {
      said: w(
        "The Anthropic account Claude Code is signed in with has no credit left.",
        "Das Anthropic-Konto, mit dem Claude Code angemeldet ist, hat kein Guthaben mehr.",
      ),
      todo: w(
        "Add credit in the Anthropic Console, or sign in with your subscription: run claude, then /login.",
        "Lade Guthaben in der Anthropic Console auf, oder melde dich mit deinem Abo an: starte claude, dann /login.",
      ),
      command: "claude",
    };
  }
  if (/usage limit|limit reached|hit your limit|rate.?limit|\b429\b|overloaded/i.test(detail)) {
    return {
      said: w(
        "Your Claude plan's limit is reached for now.",
        "Das Limit deines Claude-Abos ist für den Moment erreicht.",
      ),
      todo: w(
        "It comes back by itself after a few hours. Until then the Bot Server asks the next model.",
        "Es kommt nach ein paar Stunden von selbst zurück. Bis dahin fragt der Bot Server das nächste Modell.",
      ),
    };
  }
  if (
    /not logged in|log ?in|\/login|authenticat|oauth|credential|invalid api key|\b401\b/i.test(
      detail,
    )
  ) {
    return claudeSignedOut();
  }
  return { said: silent("Claude", detail) };
}

/** Claude Code is installed and not signed in. */
export function claudeSignedOut(): Finding {
  return {
    said: w(
      "Claude is not signed in on this computer.",
      "Claude ist auf diesem Computer nicht angemeldet.",
    ),
    todo: w(
      "Run claude in a terminal, then /login.",
      "Starte claude in einem Terminal, dann /login.",
    ),
    command: "claude",
  };
}

/** Why a client without words of its own (Cursor Agent, Antigravity) did not answer. */
export function explainClient(
  client: Pick<Client, "id" | "name" | "bin">,
  detail: string,
): Finding {
  switch (failureCode(detail)) {
    case "exhausted":
      return {
        said: w(
          `The limit of your ${client.name} plan is reached for now.`,
          `Das Limit deines ${client.name}-Abos ist für den Moment erreicht.`,
        ),
        todo: w(
          "It comes back by itself. Until then the Bot Server asks the next model.",
          "Es kommt von selbst zurück. Bis dahin fragt der Bot Server das nächste Modell.",
        ),
      };
    case "signed_out":
      return clientSignedOut(client);
    default:
      return { said: silent(client.name, detail) };
  }
}

/** Such a client is installed and not signed in. */
export function clientSignedOut({ id, name, bin }: Pick<Client, "id" | "name" | "bin">): Finding {
  return {
    said: w(
      `${name} is not signed in on this computer.`,
      `${name} ist auf diesem Computer nicht angemeldet.`,
    ),
    todo: w("Sign in to it in the setup.", "Melde es in der Einrichtung an."),
    command: id === "antigravity" ? bin : `${bin} login`,
  };
}

/** Why Codex did not answer. `model`: what `~/.codex/config.toml` sets, when it sets one. */
export function explainCodex(detail: string, model?: string): Finding {
  if (/requires an Ollama account|ollama signin|ollama\.com\/connect/i.test(detail)) {
    return {
      said: w(
        `Codex is set to use ${model ? `the Ollama cloud model ${model}` : "an Ollama cloud model"}, and Ollama is not signed in.`,
        `Codex ist auf ${model ? `das Ollama-Cloud-Modell ${model}` : "ein Ollama-Cloud-Modell"} eingestellt, und Ollama ist nicht angemeldet.`,
      ),
      todo: w(
        "Sign in to Ollama, or remove the Ollama lines (model, model_provider) from ~/.codex/config.toml.",
        "Melde dich bei Ollama an, oder entferne die Ollama-Zeilen (model, model_provider) aus ~/.codex/config.toml.",
      ),
      command: "ollama signin",
    };
  }
  if (/usage limit|hit your limit|rate.?limit|\b429\b|quota/i.test(detail)) {
    return {
      said: w(
        "Your ChatGPT plan's Codex limit is reached for now.",
        "Das Codex-Limit deines ChatGPT-Abos ist für den Moment erreicht.",
      ),
      todo: w(
        "It comes back by itself. Until then the Bot Server asks the next model.",
        "Es kommt von selbst zurück. Bis dahin fragt der Bot Server das nächste Modell.",
      ),
    };
  }
  if (/not logged in|codex login|\b401\b|unauthori[sz]ed|authenticat|log ?in/i.test(detail)) {
    return codexSignedOut();
  }
  if (/model .*(not found|does not exist|not supported)|unknown model/i.test(detail)) {
    return {
      said: w(
        `Codex does not know the model it is set to${model ? ` (${model})` : ""}.`,
        `Codex kennt das eingestellte Modell nicht${model ? ` (${model})` : ""}.`,
      ),
      todo: w(
        "Remove the model line from ~/.codex/config.toml, or name a model your plan has.",
        "Entferne die model-Zeile aus ~/.codex/config.toml, oder nenne ein Modell, das dein Abo hat.",
      ),
    };
  }
  return { said: silent("Codex", detail) };
}

/** Codex is installed and not signed in. */
export function codexSignedOut(): Finding {
  return {
    said: w(
      "Codex is not signed in on this computer.",
      "Codex ist auf diesem Computer nicht angemeldet.",
    ),
    todo: w("Sign in with your ChatGPT account.", "Melde dich mit deinem ChatGPT-Konto an."),
    command: "codex login",
  };
}

/** Why Ollama's model did not answer. */
export function explainOllama(detail: string, model: string): Finding {
  if (/more system memory|out of memory|not enough memory|insufficient memory/i.test(detail)) {
    return {
      said: w(
        `${model} is too large for this computer's memory.`,
        `${model} ist zu groß für den Arbeitsspeicher dieses Computers.`,
      ),
      todo: w(
        "Pull a smaller model with tools, e.g. ollama pull qwen3:8b.",
        "Lade ein kleineres Modell mit Werkzeugen, z. B. ollama pull qwen3:8b.",
      ),
      command: "ollama pull qwen3:8b",
    };
  }
  if (/requires an Ollama account|ollama signin|unauthori[sz]ed|\b401\b/i.test(detail)) {
    return {
      said: w(
        `${model} is a cloud model, and Ollama is not signed in.`,
        `${model} ist ein Cloud-Modell, und Ollama ist nicht angemeldet.`,
      ),
      todo: w(
        "Sign in to Ollama, or use a model on this computer.",
        "Melde dich bei Ollama an, oder nutze ein Modell auf diesem Computer.",
      ),
      command: "ollama signin",
    };
  }
  if (/not found|pull/i.test(detail)) {
    return {
      said: w(`Ollama does not have ${model}.`, `Ollama hat ${model} nicht.`),
      todo: w(`Pull it: ollama pull ${model}`, `Lade es: ollama pull ${model}`),
      command: `ollama pull ${model}`,
    };
  }
  return { said: silent(model, detail) };
}

/** Why a gateway did not answer. */
export function explainGateway(
  label: string,
  detail: string,
  status: number | undefined,
  model: string,
): Finding {
  if (status === 401 || status === 403 || /invalid.*key|unauthori[sz]ed|forbidden/i.test(detail)) {
    return {
      said: w(`${label} refused the key.`, `${label} hat den Schlüssel abgelehnt.`),
      todo: w(
        `Give a new key: tell your agent "add ${label}".`,
        `Gib einen neuen Schlüssel: Sag deinem Wizard „${label} hinzufügen“.`,
      ),
    };
  }
  if (status === 402 || /credit|balance|billing|payment|quota|insufficient/i.test(detail)) {
    return {
      said: w(
        `${label} says the account has no credit left.`,
        `${label} sagt, das Konto hat kein Guthaben mehr.`,
      ),
      todo: w(`Add credit at ${label}.`, `Lade Guthaben bei ${label} auf.`),
    };
  }
  if (status === 429 || /rate.?limit/i.test(detail)) {
    return {
      said: w(
        `${label} asks to wait: too many calls for now.`,
        `${label} lässt gerade warten: zu viele Aufrufe.`,
      ),
      todo: w("Test again in a minute.", "Teste in einer Minute noch einmal."),
    };
  }
  if (status === 404 || /model.*(not found|does not exist|unknown)|no endpoints/i.test(detail)) {
    return {
      said: w(
        `${label} does not know the model ${model}.`,
        `${label} kennt das Modell ${model} nicht.`,
      ),
      todo: w(
        `Name another model: tell your agent "add ${label} with <model>".`,
        `Nenne ein anderes Modell: Sag deinem Wizard „${label} mit <Modell> hinzufügen“.`,
      ),
    };
  }
  return { said: silent(label, detail) };
}

/** What a failed test call to the wizards account means: the key and the credits are the Manage-App's. */
export function explainAccount(
  label: string,
  detail: string,
  status: number | undefined,
  model: string,
): Finding {
  if (status === 401 || status === 403) {
    return {
      said: w(
        "Your wizards account refused the Bot Server's key.",
        "Dein wizards-Konto hat den Schlüssel des Bot Servers abgelehnt.",
      ),
      todo: w("Ask for help at wizards.bot.", "Frag bei wizards.bot nach Hilfe."),
    };
  }
  if (status === 402 || /credit|balance|insufficient/i.test(detail)) {
    return {
      said: w(
        "Your wizards account has no credits left.",
        "Dein wizards-Konto hat keine Credits mehr.",
      ),
      todo: w("Add credits at wizards.bot.", "Lade Credits bei wizards.bot auf."),
    };
  }
  const found = explainGateway(label, detail, status, model);
  return { said: found.said, ...(status === 429 ? { todo: found.todo } : {}) };
}
