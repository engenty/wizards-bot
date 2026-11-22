import { useQueryClient } from "@tanstack/react-query";
import type { FileRef } from "@wizards-bot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { FILE_LIMIT, FILE_LIMIT_LABEL, FILES_PER_MESSAGE, roomFor } from "./files";
import { t } from "./i18n";
import { shrinkImage } from "./image";
import { keys } from "./keys";
import { fileBlob } from "./queries";
import { uuid } from "./uuid";

/** A file attached to the message being written. */
interface Attachment {
  key: string;
  name: string;
  mime: string;
  size: number;
  /** The file in this browser, to look at before it is sent. */
  url: string;
  /** `ready`: the home has it. `failed`: it was not attached; `why` says so. */
  state: "uploading" | "ready" | "failed";
  ref?: FileRef;
  why?: string;
}

/** What `take` hands over: the attachments, and what they hold on to until they are let go. */
interface Held {
  list: Attachment[];
  blobs: Map<string, Blob>;
  aborts: Map<string, AbortController>;
}

/**
 * The files of the message being written. Each one is uploaded to the home as soon as it is
 * attached, a large picture made smaller first; the message then names the ids.
 */
export function useAttachments() {
  const client = useQueryClient();
  const [list, setList] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const held = useRef<Held>({ list: [], blobs: new Map(), aborts: new Map() });
  held.current.list = list;

  const letGo = useCallback((gone: Attachment[]) => {
    for (const a of gone) {
      held.current.aborts.get(a.key)?.abort();
      held.current.aborts.delete(a.key);
      held.current.blobs.delete(a.key);
      URL.revokeObjectURL(a.url);
    }
  }, []);
  // The composer is gone: what was attached and not sent is let go.
  useEffect(() => () => letGo(held.current.list), [letGo]);

  const patch = (key: string, change: Partial<Attachment>) =>
    setList((all) => all.map((a) => (a.key === key ? { ...a, ...change } : a)));

  const upload = async (key: string, picked: File, signal: AbortSignal) => {
    try {
      const file = await shrinkImage(picked);
      if (file.size > FILE_LIMIT) {
        patch(key, { state: "failed", why: t("files.tooLarge", { max: FILE_LIMIT_LABEL }) });
        return;
      }
      const ref = await api.upload<FileRef>("/v1/files", file, signal);
      if (ref.mime !== file.type && ref.mime.startsWith("image/")) {
        // The home kept another picture (a phone's HEIC as a JPEG): that one is shown.
        const kept = await fileBlob(client, ref.id);
        held.current.blobs.set(key, kept);
        const url = URL.createObjectURL(kept);
        setList((all) =>
          all.map((a) => {
            if (a.key !== key) return a;
            URL.revokeObjectURL(a.url);
            return {
              ...a,
              state: "ready",
              ref,
              url,
              name: ref.name,
              mime: ref.mime,
              size: ref.size,
            };
          }),
        );
        return;
      }
      held.current.blobs.set(key, file);
      patch(key, { state: "ready", ref });
    } catch (err) {
      if (!signal.aborted) {
        patch(key, { state: "failed", why: (err as Error).message });
      }
    }
  };

  const add = (files: File[]) => {
    const counted = held.current.list.filter((a) => a.state !== "failed").length;
    const taken = files.slice(0, roomFor(counted, files.length));
    setNotice(taken.length < files.length ? t("files.limit", { n: FILES_PER_MESSAGE }) : null);
    const added = taken.map((file): Attachment => {
      const key = uuid();
      const abort = new AbortController();
      held.current.aborts.set(key, abort);
      void upload(key, file, abort.signal);
      return {
        key,
        name: file.name,
        mime: file.type,
        size: file.size,
        url: URL.createObjectURL(file),
        state: "uploading",
      };
    });
    setList((all) => [...all, ...added]);
  };

  return {
    list,
    /** A sentence when files were left out because the message is full. */
    notice,
    add,
    remove: (key: string) => {
      letGo(held.current.list.filter((a) => a.key === key));
      setList((all) => all.filter((a) => a.key !== key));
      setNotice(null);
    },
    /**
     * Empties the field for sending. The files are kept as the bytes of their ids, so the chat
     * shows a picture without asking the home for what this browser just gave it.
     */
    take: () => {
      const taken = held.current.list;
      for (const a of taken) {
        const blob = held.current.blobs.get(a.key);
        if (a.ref && blob) {
          client.setQueryData<Blob>(keys.file(a.ref.id), blob);
        }
      }
      setList([]);
      setNotice(null);
      return taken;
    },
    /** Sending failed: the files are attached again. */
    restore: (taken: Attachment[]) => setList((all) => [...taken, ...all]),
    /** The message is sent: what the field held of its files is let go. */
    sent: letGo,
  };
}
