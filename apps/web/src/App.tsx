import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Home } from "./Home";
import { api } from "./lib/api";
import { useLang } from "./lib/i18n";
import { usePaired } from "./lib/session";
import { Pairing } from "./Pairing";

/** The chat for a browser the home knows, the pairing page for one it does not. */
export function App() {
  const paired = usePaired();
  const client = useQueryClient();
  // Another language: the whole page is drawn again in it, and the Bot Server writes in it.
  const lang = useLang();
  useEffect(() => {
    if (paired) {
      api.patch("/v1/setup", { lang }).catch(() => undefined);
    }
  }, [paired, lang]);
  // Signed out, nothing of the home stays in the page.
  useEffect(() => {
    if (!paired) {
      client.clear();
    }
  }, [paired, client]);
  return paired ? <Home /> : <Pairing />;
}
