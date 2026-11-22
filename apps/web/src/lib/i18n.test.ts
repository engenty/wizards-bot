import { describe, expect, it } from "vitest";
import { de, en, type Key, type Line, langOf, textOf } from "./i18n";

/** Every line of a table, a plural line form by form. */
function lines(table: Record<string, Line>): [string, string][] {
  return Object.entries(table).flatMap(([key, line]): [string, string][] =>
    typeof line === "string"
      ? [[key, line]]
      : Object.entries(line).map(([form, text]) => [`${key}.${form}`, text]),
  );
}

// The mechanical rules of engenty wizards' docs/copy-style.md, as its scripts/copy-check.mjs
// checks them, and the words AGENTS.md rules out.
const RULES: Record<"en" | "de", [string, RegExp][]> = {
  en: [
    ["em dash: use a spaced en dash –", /—/],
    ["hyphen as a dash: use –", / - /],
    ["three dots: use …", /\.\.\./],
    ["space before …", / …/],
    ["straight quotes: use “ ”", /"/],
    ["straight apostrophe: use ’", /\w'\w|s' /],
    ["American spelling", /\b(colors?|colored|summariz\w*|analyz\w*|favorite|center|canceled)\b/i],
    ["exclamation mark", /!/],
    ["please", /\bplease\b/i],
    ["glossary: log in → sign in", /\blog ?in\b/i],
    // "bot" only as a word of its own: the product's name has it too, wizards.bot and the
    // command wizards-bot.
    [
      "words: server, bot, assistant, widget, inbox",
      /\b(server|assistant|widget|inbox)\b|(?<!wizards[.-])\bbot\b/i,
    ],
  ],
  de: [
    ["Geviertstrich: – verwenden", /—/],
    ["Bindestrich als Gedankenstrich: – verwenden", / - /],
    ["drei Punkte: … verwenden", /\.\.\./],
    ["… ohne Leerzeichen davor", /\S…/],
    ["gerade Anführungszeichen: „…“ verwenden", /"/],
    ["gerader Apostroph: ’ verwenden", /\w'\w/],
    ["Sie-Form", /\b(Ihnen|Ihre[mnrs]?)\b|[a-zäöü,] Sie\b/],
    ["ihr/euch: du verwenden", /\b(euch|eure[mnrs]?)\b/i],
    ["Ausrufezeichen", /!/],
    ["bitte", /\bbitte\b/i],
    ["Glossar: schreibgeschützt / synchronisiert", /schreibgeschützt|synchronisiert/i],
    ["Wörter: Server, Bot, Assistent, Widget", /\b(Server|Bot|Assistent|Widget)\b/],
  ],
};

describe("the copy", () => {
  for (const [lang, table] of [
    ["en", en],
    ["de", de],
  ] as const) {
    it(`keeps the rules of the copy style in ${lang}`, () => {
      const broken = lines(table).flatMap(([key, text]) =>
        RULES[lang]
          .filter(([, pattern]) => pattern.test(text.replace(/\{\w+\}/g, "{}")))
          .map(([rule]) => `${key}: ${rule}`),
      );
      expect(broken).toEqual([]);
    });
  }

  it("has the same gaps in both languages", () => {
    const gaps = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const german = new Map(lines(de));
    const differing = lines(en)
      .filter(([key, text]) => gaps(text).join() !== gaps(german.get(key) ?? "").join())
      .map(([key]) => key);
    expect(differing).toEqual([]);
  });
});

describe("textOf", () => {
  it("picks the plural form by the number and writes it the language's way", () => {
    expect(textOf("needs.count", "en", { n: 1 })).toBe("1 needs you");
    expect(textOf("needs.count", "en", { n: 3 })).toBe("3 need you");
    expect(textOf("needs.count", "de", { n: 1 })).toBe("1 braucht dich");
    expect(textOf("folder.files", "en", { n: 5000 })).toBe("5,000 files");
    expect(textOf("folder.files", "de", { n: 5000 })).toBe("5.000 Dateien");
  });

  it("fills the gaps it has words for and leaves the others", () => {
    expect(textOf("chat.empty", "en", { name: "Goose" })).toBe(
      "Write to Goose. Everything is set up in this conversation.",
    );
    expect(textOf("agents.shared" satisfies Key, "en")).toBe("from {from}");
  });
});

describe("langOf", () => {
  it("is German for a browser that reads German first, English for every other", () => {
    expect(langOf(["de-AT", "en"])).toBe("de");
    expect(langOf(["fr", "de"])).toBe("en");
    expect(langOf([])).toBe("en");
  });
});
