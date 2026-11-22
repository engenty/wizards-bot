import { useQueryClient } from "@tanstack/react-query";
import type { DeviceResource, FileRef, Folder as FolderType } from "@wizards-bot/protocol";
import {
  ChevronRight,
  File,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  Image,
  Link,
  Music,
  Paperclip,
  Plus,
  Smartphone,
  X,
} from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { asking, onDevices } from "../lib/devices";
import { formatBytes, kindOf } from "../lib/files";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useDevices, useFolders, useSentFiles } from "../lib/queries";
import { Button, cn, IconButton } from "../ui";

const line = "flex min-h-11 items-center gap-3 py-1.5";
const icon = "size-4 shrink-0 text-ink-3";

/** What a file is, as a small picture: a picture, a sheet, a text, a film, a sound. */
function FileIcon({ file }: { file: FileRef }) {
  const kind = kindOf(file);
  const Shape =
    // A phone's HEIC is a picture too, though a browser does not show it.
    kind === "image" || file.mime.startsWith("image/")
      ? Image
      : /\.(xlsx?|csv|tsv|numbers)$/i.test(file.name)
        ? FileSpreadsheet
        : kind === "pdf" || kind === "text" || /\.(docx?|pptx?|pages|key)$/i.test(file.name)
          ? FileText
          : kind === "video"
            ? Film
            : kind === "audio"
              ? Music
              : File;
  return <Shape className={icon} />;
}

/** A connected folder on one line, with what the agents may do in it and the way out. */
function FolderLine({
  folder,
  onProblem,
}: {
  folder: FolderType;
  onProblem: (text: string) => void;
}) {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const disconnect = () =>
    api.del(`/v1/folders/${folder.id}`).then(
      () =>
        client.setQueryData<FolderType[]>(keys.folders(), (all) =>
          (all ?? []).filter((f) => f.id !== folder.id),
        ),
      (err: Error) => onProblem(err.message),
    );
  if (asking) {
    return (
      <li className="enter-fade flex flex-wrap items-center gap-2 py-2">
        <p className="min-w-40 flex-1 text-[0.875rem]">
          {t("folders.disconnectAsk", { name: folder.name })}
        </p>
        <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
          {t("common.cancel")}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void disconnect()}>
          {t("folders.disconnect")}
        </Button>
      </li>
    );
  }
  return (
    <li className={cn(line, "group")} title={folder.path}>
      <Folder className={icon} />
      <span className="min-w-0 flex-1 truncate text-[0.9375rem]">{folder.name}</span>
      <span className="shrink-0 text-[0.8125rem] text-ink-3">
        {t(folder.access === "write" ? "folder.write" : "folder.read")}
      </span>
      <IconButton
        label={`${t("folders.disconnect")}: ${folder.name}`}
        onClick={() => setAsking(true)}
        className="-mr-2 opacity-60 transition group-hover:opacity-100"
      >
        <X className="size-4" />
      </IconButton>
    </li>
  );
}

/**
 * A folder connected on one of the person's devices. Its files stay there and the device's own
 * agent reads them; it is disconnected on the device, not here.
 */
function DeviceLine({ resource, device }: { resource: DeviceResource; device: string }) {
  const Shape = resource.kind === "connection" ? Link : Folder;
  return (
    <li
      className={line}
      title={t(resource.kind === "connection" ? "agent.onDeviceService" : "agent.onDeviceNote", {
        device,
      })}
    >
      <Shape className={icon} />
      <span className="min-w-0 flex-1 truncate text-[0.9375rem]">{resource.name}</span>
      <span className="max-w-[45%] shrink-0 truncate text-[0.8125rem] text-ink-3">
        {t("agent.onDevice", { device })}
      </span>
    </li>
  );
}

/** What the person sent in this chat, folded into one line until it is opened. */
function Uploads({ files }: { files: FileRef[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(line, "w-full text-left")}
      >
        <Paperclip className={icon} />
        <span className="min-w-0 flex-1 truncate text-[0.9375rem]">{t("agent.uploads")}</span>
        <span className="shrink-0 text-[0.8125rem] text-ink-3 tabular-nums">{files.length}</span>
        <ChevronRight
          className={cn("size-4 shrink-0 text-ink-4 transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <ul className="enter-rise mb-1 ml-7 border-border-soft border-l pl-3">
          {files.map((file) => (
            <li key={file.id} className="flex min-h-9 items-center gap-3 py-1" title={file.name}>
              <FileIcon file={file} />
              <span className="min-w-0 flex-1 truncate text-[0.875rem]">{file.name}</span>
              <span className="shrink-0 text-[0.75rem] text-ink-3 tabular-nums">
                {formatBytes(file.size)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * What the agent works with, one line each: the connected folders of the home's computer, the
 * folders connected on the person's devices (read there by the device's own agent) and the
 * files the person sent in this chat. A folder of the home's computer is added from here and
 * taken away again; the files stay with the messages they came in.
 */
export function AgentData({
  agentId,
  name,
  conversationId,
  onFolder,
}: {
  agentId: string;
  name: string;
  conversationId: string;
  /** Connects a folder from this chat. */
  onFolder: () => void;
}) {
  const folders = useFolders();
  const devices = useDevices();
  const sent = useSentFiles(conversationId);
  const [problem, setProblem] = useState<string | null>(null);
  const files = sent.data ?? [];
  const elsewhere = onDevices(devices.data ?? []);
  const asks = asking(devices.data ?? [], agentId);
  return (
    <section className="mt-6">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-medium text-[0.8125rem] text-ink-3">{t("agent.data")}</h3>
        <IconButton label={t("composer.folder")} onClick={onFolder} className="-mr-2">
          <Plus className="size-4" />
        </IconButton>
      </div>
      {folders.data?.length || elsewhere.length || files.length ? (
        <ul className="enter-fade divide-y divide-border-soft">
          {(folders.data ?? []).map((folder) => (
            <FolderLine key={folder.id} folder={folder} onProblem={setProblem} />
          ))}
          {elsewhere.map(({ resource, device }) => (
            <DeviceLine key={`${device}/${resource.id}`} resource={resource} device={device} />
          ))}
          {files.length ? <Uploads files={files} /> : null}
        </ul>
      ) : folders.data ? (
        <p className="enter-fade text-[0.875rem] text-ink-2 leading-relaxed">
          {t("agent.noData", { name })}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="mt-2 text-[0.8125rem] text-rose">
          {problem}
        </p>
      ) : null}
      {asks.length ? (
        <ul className="enter-fade mt-3 divide-y divide-border-soft">
          {asks.map(({ device, may }) => (
            <li key={device} className={line} title={t("agent.askNote", { device })}>
              <Smartphone className={icon} />
              <span className="min-w-0 flex-1 truncate text-[0.9375rem]">
                {t("agent.asks", { name, device })}
              </span>
              <span className="shrink-0 text-[0.8125rem] text-ink-3">{t(`agent.may.${may}`)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
