import type { Db } from "../store/db.ts";

// What the Bot Server itself writes for the person outside a model's answer (the setup's checks,
// the pairing card) is kept in both languages the apps speak and shown in the person's. The web
// app says which one the person reads (`PATCH /v1/setup` with `lang`).

export type Lang = "en" | "de";

/** A sentence in each language. */
export interface Words {
  en: string;
  de: string;
}

export const w = (en: string, de: string): Words => ({ en, de });

/** The same in both: a name, a command, what a service said. */
export const same = (text: string): Words => ({ en: text, de: text });

/** A sentence as the person reads it. Text kept before there were two is shown as it is. */
export const say = (words: Words | string, lang: Lang): string =>
  typeof words === "string" ? words : words[lang];

/** The language the person reads, as the web app said it; English until it did. */
export function langOf(db: Db): Lang {
  return db.meta("person.lang") === "de" ? "de" : "en";
}

/** The pairing card: what it says, in the person's language. */
export function pairingCard(
  address: string,
  code: string,
  lang: Lang,
  pairing: { address: string; print?: string } = { address },
): { title: string; body: string; qr: string } {
  return {
    title: say(w("Add a device", "Gerät hinzufügen"), lang),
    body: say(
      w(
        `Scan this with the wizards.bot app, or enter the address \`${address}\` and the code **${code}**. The code works once, for 10 minutes.`,
        `Scanne das mit der wizards.bot-App, oder gib die Adresse \`${address}\` und den Code **${code}** ein. Der Code gilt einmal, 10 Minuten lang.`,
      ),
      lang,
    ),
    qr: pairingLink(pairing.address, code, pairing.print),
  };
}

/**
 * What a pairing QR holds: the address and the code for the wizards.bot app, and on the person's
 * network the print of the key the home's https answers with (`k`).
 */
export const pairingLink = (address: string, code: string, print?: string): string =>
  `wizardsbot://pair?home=${encodeURIComponent(address)}&code=${code}${print ? `&k=${print}` : ""}`;

/** The main agent's first words after the setup. */
export function greeting(name: string, agent: string, lang: Lang): string {
  return say(
    name
      ? w(
          `Hello ${name}. I am ${agent}, your first wizard. Tell me what you need, or ask what I can do.`,
          `Hallo ${name}. Ich bin ${agent}, dein erster Wizard. Sag mir, was du brauchst, oder frag, was ich kann.`,
        )
      : w(
          `Hello. I am ${agent}, your first wizard. Tell me what you need, or ask what I can do.`,
          `Hallo. Ich bin ${agent}, dein erster Wizard. Sag mir, was du brauchst, oder frag, was ich kann.`,
        ),
    lang,
  );
}

/**
 * What the main agent is, as the person reads it until they or the agent say otherwise. Kept in
 * every language, so a switch of the language finds it again.
 */
export const MAIN_ABOUT = w(
  "Your own wizard. It knows your other wizards, your accounts and what needs you.",
  "Dein eigener Wizard. Er kennt deine anderen Wizards, deine Konten und was dich braucht.",
);

/** The main agent's first `about`, before it was written in two languages. */
export const MAIN_ABOUT_BEFORE =
  "Your own agent. It knows your other agents, your accounts and what needs you.";
