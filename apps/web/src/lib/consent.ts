import type { ModelService, Models } from "@wizards-bot/protocol";
import { useSyncExternalStore } from "react";
import { ApiError, api } from "./api";
import { t } from "./i18n";

/** The question on screen: which services wait for a yes, and who waits for the answer. */
export interface ConsentAsk {
  services: ModelService[];
  answer: (yes: boolean) => void;
}

let shown: ConsentAsk | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) {
    listener();
  }
};

/**
 * Asks the person whether what they write may go to these services. Several calls that wait at
 * once share one question.
 */
export function askConsent(services: ModelService[]): Promise<boolean> {
  return new Promise((resolve) => {
    const before = shown;
    shown = {
      services,
      answer: (yes) => {
        shown = null;
        changed();
        before?.answer(yes);
        resolve(yes);
      },
    };
    changed();
  });
}

/** The question on screen, or none. */
export const consentAsk = (): ConsentAsk | null => shown;

/** The question on screen, for the dialog that shows it. */
export function useConsentAsk(): ConsentAsk | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, consentAsk);
}

/**
 * Runs a call that sends what the person wrote. When the home answers that a service in use
 * waits for a yes (`needs_consent`), the person is asked; with a yes the home learns it and the
 * call runs again, without one it is refused with a sentence that says so. `onModels` gets the
 * home's models after the yes.
 */
export async function withConsent<T>(
  call: () => Promise<T>,
  onModels?: (models: Models) => void,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof ApiError && err.code === "needs_consent")) {
      throw err;
    }
    const services = (err.body?.services ?? []) as ModelService[];
    if (!(await askConsent(services))) {
      throw new ApiError(t("consent.notSent"), err.status, err.body);
    }
    const models = await api.post<Models>("/v1/consent", {
      services: services.map((service) => service.id),
    });
    onModels?.(models);
    return await call();
  }
}
