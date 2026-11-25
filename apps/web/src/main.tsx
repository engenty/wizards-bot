import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Crashed } from "./Crashed";
import { applyTheme } from "./lib/theme";
import { speakViews } from "./lib/views";
import "./styles/app.css";

applyTheme();
speakViews();

// The home's events keep the lists current, so a list is asked for once: when the stream
// stands, and again each time it comes back (lib/stream.ts).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false },
  },
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Crashed>
          <App />
        </Crashed>
      </QueryClientProvider>
    </StrictMode>,
  );
}
