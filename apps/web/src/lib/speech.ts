// From engenty wizards, apps/web/src/lib/speech.ts: the browser's own recognition. A home has
// no route that writes a recording down, so there is no dictation where the browser has none.
import { useEffect, useRef, useState } from "react";

interface RecognitionResult {
  readonly isFinal: boolean;
  [index: number]: { readonly transcript: string };
}

interface RecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResult };
}

interface Recognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((ev: Event & { error: string }) => void) | null;
  onresult: ((ev: RecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionConstructor = new () => Recognition;

declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  }
}

function join(before: string, spoken: string): string {
  const base = before.trimEnd();
  const next = spoken.trim();
  return base && next ? `${base} ${next}` : base || next;
}

/** Speaking into a draft: the browser writes along while the person talks. */
export function useDictation(draft: string, onDraft: (value: string) => void) {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<"denied" | "failed" | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const active = useRef<Recognition | null>(null);

  useEffect(() => () => active.current?.stop(), []);

  const start = () => {
    if (!Recognition || active.current) {
      return;
    }
    setError(null);
    const before = draftRef.current;
    let committed = "";
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language;
    rec.onresult = (event) => {
      // Results below resultIndex were committed by an earlier event.
      let interim = "";
      for (let i = Math.max(0, event.resultIndex); i < event.results.length; i++) {
        const result = event.results[i];
        const said = result?.[0]?.transcript ?? "";
        if (result?.isFinal) {
          committed = join(committed, said);
        } else {
          interim += said;
        }
      }
      onDraftRef.current(join(before, join(committed, interim)));
    };
    rec.onerror = (event) => {
      if (event.error === "aborted" || event.error === "no-speech") {
        return;
      }
      setError(event.error === "not-allowed" ? "denied" : "failed");
    };
    rec.onend = () => {
      active.current = null;
      setListening(false);
    };
    active.current = rec;
    rec.start();
    setListening(true);
  };
  const stop = () => active.current?.stop();

  return {
    supported: Boolean(Recognition),
    listening,
    /** `denied`: the browser may not use the microphone. `failed`: it could not recognise speech. */
    error,
    toggle: () => (active.current ? stop() : start()),
    stop,
  };
}
