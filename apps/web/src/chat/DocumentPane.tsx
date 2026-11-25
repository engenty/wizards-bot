import { useQueryClient } from "@tanstack/react-query";
import type { AddMark, Document, DocumentMark, Message } from "@wizards-bot/protocol";
import { Check, Pencil, X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { withConsent } from "../lib/consent";
import { draftReducer, saveDue, startDraft, unsaved } from "../lib/draft";
import { applyEvent } from "../lib/events";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useAgents, useDocument, useMarks } from "../lib/queries";
import { inOpenSpace } from "../lib/studio";
import { uuid } from "../lib/uuid";
import { Button, cn, IconButton, Spinner } from "../ui";
import { ShareButton } from "./ShareDialog";

// The editor comes when the first document opens: the chat does not wait for it.
const BlockEditor = lazy(() =>
  import("../blocks/BlockEditor").then((m) => ({ default: m.BlockEditor })),
);

/** No marks: the same list each time, so the editor does not draw anew. */
const NO_MARKS: DocumentMark[] = [];

/** How long after the last change the text is saved, in milliseconds. */
const SAVE_AFTER = 600;

const waiting = (
  <div className="grid flex-1 place-items-center text-ink-4">
    <Spinner />
  </div>
);

function Header({
  title,
  onClose,
  children,
}: {
  title: string | undefined;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
      <IconButton label={t("common.close")} onClick={onClose}>
        <X className="size-4" />
      </IconButton>
      <h2 className="min-w-0 flex-1 truncate font-display font-semibold text-[1.0625rem]">
        {title}
      </h2>
      {children}
    </header>
  );
}

/**
 * The document in the block editor. It opens to be read: a passage can be marked, commented
 * on or asked about. The pen makes it editable; then it is saved by itself a moment after the
 * last change, against the version the home has (lib/draft.ts). It follows the agent's changes
 * while nothing here is unsaved; otherwise the person chooses which text stays.
 */
function Editing({
  document,
  over,
  onClose,
}: {
  document: Document;
  over: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const marks = useMarks(document.id);
  const agents = useAgents();
  const agentName =
    agents.data?.find((a) => a.conversationId === document.conversationId)?.name ?? "";
  const [draft, dispatch] = useReducer(draftReducer, document, startDraft);
  const [problem, setProblem] = useState<string | null>(null);
  /** A save went through since the document was opened: the header says so. */
  const [taken, setTaken] = useState(false);
  const latest = useRef(draft);
  latest.current = draft;
  const gone = useRef(false);
  const { id } = document;

  // The home has another version: the agent wrote, or another device saved.
  useEffect(() => dispatch({ type: "arrived", document }), [document]);

  const save = useRef(async () => {
    const { text, base } = latest.current;
    const put = (content: string, baseVersion: number) =>
      api.put<Document>(`/v1/documents/${id}`, { content, baseVersion });
    dispatch({ type: "saving" });
    try {
      let saved = await put(text, base);
      // Closed meanwhile, with more typed: that goes after it.
      if (gone.current && latest.current.text !== text) {
        saved = await put(latest.current.text, saved.version);
      }
      dispatch({ type: "saved", document: saved });
      client.setQueryData(keys.document(id), saved);
      setProblem(null);
      setTaken(true);
    } catch (err) {
      const newer =
        err instanceof ApiError && err.code === "version_conflict" && err.body?.document;
      if (newer) {
        dispatch({ type: "refused", document: newer as Document });
        client.setQueryData(keys.document(id), newer as Document);
      } else {
        dispatch({ type: "failed" });
        setProblem((err as Error).message);
      }
    }
  });

  const due = saveDue(draft);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every change of the text starts the wait anew
  useEffect(() => {
    if (!due) {
      return;
    }
    const timer = setTimeout(() => void save.current(), SAVE_AFTER);
    return () => clearTimeout(timer);
  }, [due, draft.text]);

  // Closed before the wait was over: what is unsaved is saved on the way out.
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      const last = latest.current;
      if (unsaved(last) && last.conflict === null && last.saving !== "saving") {
        void save.current();
      }
    };
  }, []);

  const markKey = keys.marks(id);
  const addMark = async (mark: AddMark) => {
    try {
      const added = await api.post<DocumentMark>(`/v1/documents/${id}/marks`, mark);
      client.setQueryData<DocumentMark[]>(markKey, (now) => [...(now ?? []), added]);
    } catch (err) {
      setProblem((err as Error).message);
    }
  };
  const removeMark = async (markId: string) => {
    try {
      await api.del(`/v1/documents/${id}/marks/${markId}`);
      client.setQueryData<DocumentMark[]>(markKey, (now) => now?.filter((m) => m.id !== markId));
    } catch (err) {
      setProblem((err as Error).message);
    }
  };
  const ask = async (quote: string, text: string) => {
    try {
      const clientId = uuid();
      const { message } = await withConsent(
        () =>
          api.post<{ message: Message }>(`/v1/conversations/${document.conversationId}/messages`, {
            text,
            about: { documentId: id, quote },
            clientId,
            ...inOpenSpace(),
          }),
        (models) => client.setQueryData(keys.models(), models),
      );
      applyEvent(client, { type: "message.created", message });
      // Lying over the chat, the document would hide the answer.
      if (over) {
        onClose();
      }
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  const conflict = draft.conflict;
  const word =
    conflict || draft.saving === "failed"
      ? "doc.notSaved"
      : unsaved(draft) || draft.saving === "saving"
        ? "doc.saving"
        : taken
          ? "doc.saved"
          : null;

  return (
    <>
      <Header title={document.title} onClose={onClose}>
        {editing || word === "doc.notSaved" ? (
          <span
            aria-live="polite"
            className={cn(
              "shrink-0 pr-2 text-[0.8125rem]",
              word === "doc.notSaved" ? "text-rose" : "text-ink-4",
            )}
          >
            {word ? t(word) : null}
          </span>
        ) : null}
        {editing ? (
          <IconButton label={t("doc.done")} onClick={() => setEditing(false)}>
            <Check className="size-4" />
          </IconButton>
        ) : (
          <IconButton label={t("doc.edit")} onClick={() => setEditing(true)}>
            <Pencil className="size-4" />
          </IconButton>
        )}
        <ShareButton
          kind="document"
          id={id}
          title={document.title}
          version={document.version}
          content={document.content}
        />
      </Header>
      {conflict ? (
        <div
          role="alert"
          className="enter-rise mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-amber-tint px-4 py-3 text-[0.875rem]"
        >
          <p className="min-w-48 flex-1">
            {t(conflict.updatedBy === "you" ? "doc.conflictElsewhere" : "doc.conflict")}
          </p>
          <Button variant="secondary" size="sm" onClick={() => dispatch({ type: "keepMine" })}>
            {t("doc.keepMine")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => dispatch({ type: "takeNewer" })}>
            {t("doc.takeNewer")}
          </Button>
        </div>
      ) : null}
      {problem && draft.saving !== "failed" ? (
        <p
          role="alert"
          className="enter-rise mx-4 mb-2 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose"
        >
          {problem}
        </p>
      ) : null}
      {problem && draft.saving === "failed" ? (
        <p
          role="alert"
          className="enter-rise mx-4 mb-2 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose"
        >
          {problem} {t("doc.retry")}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Suspense fallback={waiting}>
          <BlockEditor
            text={draft.text}
            label={t("doc.text")}
            onChange={(text) => dispatch({ type: "edited", text })}
            editable={editing}
            reading={{
              marks: marks.data ?? NO_MARKS,
              agentName,
              onMark: (anchor) => void addMark(anchor),
              onComment: (anchor, comment) => void addMark({ ...anchor, comment }),
              onAsk: (quote, text) => void ask(quote, text),
              onRemove: (markId) => void removeMark(markId),
            }}
          />
        </Suspense>
      </div>
    </>
  );
}

/** A document beside the chat, or over it where the window has no room beside it. */
export function DocumentPane({
  id,
  over,
  leaving,
  onClose,
}: {
  id: string;
  /** It lies over the chat, as on a phone, instead of standing beside it. */
  over: boolean;
  /** It is on its way out. */
  leaving: boolean;
  onClose: () => void;
}) {
  const doc = useDocument(id);
  return (
    <aside
      aria-label={doc.data?.title}
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        over ? "pane-over fixed inset-0 z-30" : "border-border-soft border-l",
      )}
      data-leaving={leaving || undefined}
    >
      {doc.data ? (
        <Editing document={doc.data} over={over} onClose={onClose} />
      ) : (
        <>
          <Header title={undefined} onClose={onClose} />
          {doc.error ? (
            <p
              role="alert"
              className="mx-4 mb-2 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose"
            >
              {doc.error.message}
            </p>
          ) : (
            waiting
          )}
        </>
      )}
    </aside>
  );
}
