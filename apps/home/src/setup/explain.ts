// What a failed test call means, in one sentence the person can act on. The client's or the
// service's own words are matched; the sentence and what to do are the home's.

/** What a check found: the sentence, what to do, and a command when a terminal is the way. */
export interface Finding {
  said: string;
  todo?: string;
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

/** Why Claude Code did not answer. */
export function explainClaude(detail: string): Finding {
  if (/specified API usage limits|API usage limit/i.test(detail)) {
    return {
      said: "Claude Code is signed in with an API key whose usage limit is reached.",
      todo: "Raise the key's limit in the Anthropic Console, or sign in with your subscription instead: run claude, then /login.",
      command: "claude",
    };
  }
  if (/credit balance|too low|billing/i.test(detail)) {
    return {
      said: "The Anthropic account Claude Code is signed in with has no credit left.",
      todo: "Add credit in the Anthropic Console, or sign in with your subscription: run claude, then /login.",
      command: "claude",
    };
  }
  if (/usage limit|limit reached|hit your limit|rate.?limit|\b429\b|overloaded/i.test(detail)) {
    return {
      said: "Your Claude plan's limit is reached for now.",
      todo: "It comes back by itself after a few hours. Until then the home asks the next model.",
    };
  }
  if (
    /not logged in|log ?in|\/login|authenticat|oauth|credential|invalid api key|\b401\b/i.test(
      detail,
    )
  ) {
    return {
      said: "Claude is not signed in on this computer.",
      todo: "Run claude in a terminal, then /login.",
      command: "claude",
    };
  }
  return { said: `Claude did not answer: ${firstLine(detail) || "no reason given"}.` };
}

/** Why Codex did not answer. `model`: what `~/.codex/config.toml` sets, when it sets one. */
export function explainCodex(detail: string, model?: string): Finding {
  if (/requires an Ollama account|ollama signin|ollama\.com\/connect/i.test(detail)) {
    return {
      said: `Codex is set to use ${model ? `the Ollama cloud model ${model}` : "an Ollama cloud model"}, and Ollama is not signed in.`,
      todo: "Sign in to Ollama, or remove the Ollama lines (model, model_provider) from ~/.codex/config.toml.",
      command: "ollama signin",
    };
  }
  if (/usage limit|hit your limit|rate.?limit|\b429\b|quota/i.test(detail)) {
    return {
      said: "Your ChatGPT plan's Codex limit is reached for now.",
      todo: "It comes back by itself. Until then the home asks the next model.",
    };
  }
  if (/not logged in|codex login|\b401\b|unauthori[sz]ed|authenticat|log ?in/i.test(detail)) {
    return {
      said: "Codex is not signed in on this computer.",
      todo: "Sign in with your ChatGPT account.",
      command: "codex login",
    };
  }
  if (/model .*(not found|does not exist|not supported)|unknown model/i.test(detail)) {
    return {
      said: `Codex does not know the model it is set to${model ? ` (${model})` : ""}.`,
      todo: "Remove the model line from ~/.codex/config.toml, or name a model your plan has.",
    };
  }
  return { said: `Codex did not answer: ${firstLine(detail) || "no reason given"}.` };
}

/** Why Ollama's model did not answer. */
export function explainOllama(detail: string, model: string): Finding {
  if (/more system memory|out of memory|not enough memory|insufficient memory/i.test(detail)) {
    return {
      said: `${model} is too large for this computer's memory.`,
      todo: "Pull a smaller model with tools, e.g. ollama pull qwen3:8b.",
      command: "ollama pull qwen3:8b",
    };
  }
  if (/requires an Ollama account|ollama signin|unauthori[sz]ed|\b401\b/i.test(detail)) {
    return {
      said: `${model} is a cloud model, and Ollama is not signed in.`,
      todo: "Sign in to Ollama, or use a model on this computer.",
      command: "ollama signin",
    };
  }
  if (/not found|pull/i.test(detail)) {
    return {
      said: `Ollama does not have ${model}.`,
      todo: `Pull it: ollama pull ${model}`,
      command: `ollama pull ${model}`,
    };
  }
  return { said: `${model} did not answer: ${firstLine(detail) || "no reason given"}.` };
}

/** Why a gateway did not answer. */
export function explainGateway(
  label: string,
  detail: string,
  status: number | undefined,
  model: string,
): Finding {
  const again = `Give a new key: tell your agent "add ${label}".`;
  if (status === 401 || status === 403 || /invalid.*key|unauthori[sz]ed|forbidden/i.test(detail)) {
    return { said: `${label} refused the key.`, todo: again };
  }
  if (status === 402 || /credit|balance|billing|payment|quota|insufficient/i.test(detail)) {
    return {
      said: `${label} says the account has no credit left.`,
      todo: `Add credit at ${label}.`,
    };
  }
  if (status === 429 || /rate.?limit/i.test(detail)) {
    return {
      said: `${label} asks to wait: too many calls for now.`,
      todo: "Test again in a minute.",
    };
  }
  if (status === 404 || /model.*(not found|does not exist|unknown)|no endpoints/i.test(detail)) {
    return {
      said: `${label} does not know the model ${model}.`,
      todo: `Name another model: tell your agent "add ${label} with <model>".`,
    };
  }
  return { said: `${label} did not answer: ${firstLine(detail) || "no reason given"}.` };
}

/** What a failed test call to the wizards account means: the key and the credits are the Manage-App's. */
export function explainAccount(
  label: string,
  detail: string,
  status: number | undefined,
  model: string,
): Finding {
  if (status === 401 || status === 403) {
    return { said: `${label} refused the home's key.`, todo: "Ask for help at wizards.bot." };
  }
  if (status === 402 || /credit|balance|insufficient/i.test(detail)) {
    return { said: `${label} has no credits left.`, todo: "Add credits at wizards.bot." };
  }
  const found = explainGateway(label, detail, status, model);
  return { said: found.said, ...(status === 429 ? { todo: found.todo } : {}) };
}
