import { useQueryClient } from "@tanstack/react-query";
import type { FileRef } from "@wizards-bot/protocol";
import { useState } from "react";
import { isPicture, type ShownFile, saveFile } from "../lib/files";
import { t } from "../lib/i18n";
import { fileBlob, useFileUrl } from "../lib/queries";
import { cn, Spinner } from "../ui";
import { FilePreview, FileTile } from "../ui/FilePreview";

/** A picture of a message, loaded from the home; a click opens it large. */
function Picture({ file, onOpen }: { file: FileRef; onOpen: (shown: ShownFile) => void }) {
  const { url, failed } = useFileUrl(file.id);
  if (failed) {
    return (
      <li className="list-none text-[0.8125rem] text-ink-3">
        {file.name}: {t("files.gone")}
      </li>
    );
  }
  if (!url) {
    return (
      <li className="grid h-40 w-56 max-w-full list-none place-items-center rounded-xl bg-paper-2 text-ink-4">
        <Spinner />
      </li>
    );
  }
  const shown = { ...file, url };
  return (
    <FileTile
      file={shown}
      large
      label={t("files.open", { name: file.name })}
      onOpen={() => onOpen(shown)}
    />
  );
}

/**
 * The files a message carries: a picture as the picture, any other as a row with its name that
 * downloads it. `onProblem` is told when the home does not send a file.
 */
export function MessageFiles({
  files,
  mine,
  onProblem,
}: {
  files: FileRef[];
  /** The person's own message: its files stand at the right edge, as its text does. */
  mine: boolean;
  onProblem: (text: string) => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState<ShownFile | null>(null);
  const download = (file: FileRef) =>
    fileBlob(client, file.id).then(
      (blob) => saveFile(blob, file.name),
      () => onProblem(t("files.gone")),
    );
  return (
    <>
      <ul className={cn("flex max-w-full flex-col gap-1.5", mine ? "items-end" : "items-start")}>
        {files.map((file) =>
          isPicture(file.mime) ? (
            <Picture key={file.id} file={file} onOpen={setOpen} />
          ) : (
            <FileTile
              key={file.id}
              file={file}
              large
              label={`${t("files.download")}: ${file.name}`}
              onOpen={() => void download(file)}
            />
          ),
        )}
      </ul>
      <FilePreview files={open ? [open] : []} at={open ? 0 : null} onAt={() => setOpen(null)} />
    </>
  );
}
