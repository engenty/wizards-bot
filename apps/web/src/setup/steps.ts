import type { Setup, SetupCheck } from "@wizards-bot/protocol";

/**
 * The first start, step by step: the person's name, the models (which gate until one answers),
 * what the agents can do, and a phone and a folder. After it, the chat.
 */
export type Step = "name" | "models" | "devices";

/**
 * Whether the app opens the setup instead of the chat: the person has not been through it, or
 * the home has no model it would ask.
 */
export function needsSetup(setup: Setup): boolean {
  return !setup.done || !setup.hasModel;
}

/**
 * The steps this setup takes, fixed when it opens. A home set up before that lost its models
 * shows the models alone; the name is asked only while the person has not said it.
 */
export function stepsOf(setup: Setup): Step[] {
  if (setup.done) {
    return ["models"];
  }
  return [...(setup.name.confirmed ? [] : ["name" as const]), "models", "devices"];
}

/** Whether the person can go on from a step: the models only once one of them answered. */
export function canGoOn(step: Step, setup: Setup, name = ""): boolean {
  if (step === "name") {
    return name.trim().length > 0;
  }
  if (step === "models") {
    return setup.working;
  }
  return true;
}

/**
 * Whether the models step makes its test calls when it opens: no model was tested yet and none
 * is being tested. Later calls are the person's: "Test again".
 */
export function testOnOpen(setup: Setup): boolean {
  return !setup.models.some((check) => check.at || check.state === "testing");
}

/** Whether a check can be tested again from here: a model of this computer or a gateway. */
export function testable(check: SetupCheck): boolean {
  return (
    check.kind === "model" &&
    !check.id.includes("/") &&
    check.state !== "testing" &&
    !absentHere(check)
  );
}

/** A client that is not installed: testing it again changes nothing until it is. */
function absentHere(check: SetupCheck): boolean {
  return check.state === "absent" && check.id !== "ollama" && !check.at;
}

/** Whether a test call runs now. */
export function testing(setup: Setup): boolean {
  return setup.models.some((check) => check.state === "testing");
}

/** The newest test call's time, for "tested at". */
export function testedAt(setup: Setup): string | undefined {
  return setup.models
    .map((check) => check.at)
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
}
