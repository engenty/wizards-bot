import { configureViews, type ViewTextKey } from "@engenty/chatviews/react/texts";
import { type Key, lang, t } from "./i18n";

/** The library of views this app draws; a card's view of another one shows as title and body. */
export const VIEW_LIBRARY = "engenty:core/1";

/** The views of @engenty/chatviews say their own few words in the page's language. */
export function speakViews(): void {
  configureViews({
    text: (key: ViewTextKey, vars) => t(key satisfies Key, vars),
    lang: () => lang,
  });
}
