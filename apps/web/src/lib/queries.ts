import { type QueryClient, useQuery } from "@tanstack/react-query";
import type {
  Agent,
  AgentDetail,
  Artifact,
  Avatar,
  Card,
  Contact,
  Device,
  Document,
  DocumentMark,
  FileRef,
  Folder,
  HomeInfo,
  Models,
  PluginsView,
  PublishedLinks,
  SecretEntry,
  Setup,
  SharedKind,
} from "@wizards-bot/protocol";
import { useEffect, useState } from "react";
import { api } from "./api";
import type { Thread } from "./events";
import { keys } from "./keys";

/** How many messages one page of a conversation holds. */
const PAGE = 50;

/** The agents of the home, the main agent first. */
export function useAgents() {
  return useQuery({
    queryKey: keys.agents(),
    queryFn: ({ signal }) =>
      api.get<{ agents: Agent[] }>("/v1/agents", signal).then((r) => r.agents),
  });
}

/** An agent with what it keeps, read anew each time it is looked at. */
export function useAgentDetail(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.agent(id),
    enabled,
    staleTime: 0,
    queryFn: ({ signal }) => api.get<AgentDetail>(`/v1/agents/${id}`, signal),
  });
}

/** Every open card that waits for the person, oldest first. */
export function useItems() {
  return useQuery({
    queryKey: keys.items(),
    queryFn: ({ signal }) => api.get<{ items: Card[] }>("/v1/items", signal).then((r) => r.items),
  });
}

const page = (conversationId: string, before?: string, signal?: AbortSignal) =>
  api.get<Thread>(
    `/v1/conversations/${conversationId}/messages?limit=${PAGE}${before ? `&before=${before}` : ""}`,
    signal,
  );

/** A conversation's latest messages. Loading them tells the home the conversation was read. */
export function useThread(conversationId: string | undefined) {
  return useQuery({
    queryKey: keys.thread(conversationId),
    enabled: Boolean(conversationId),
    queryFn: async ({ signal }) => {
      const thread = await page(conversationId as string, undefined, signal);
      void api.post(`/v1/conversations/${conversationId}/read`).catch(() => undefined);
      return thread;
    },
  });
}

/** Loads the messages before the earliest one shown and puts them in front. */
export async function loadEarlier(client: QueryClient, conversationId: string) {
  const first = client.getQueryData<Thread>(keys.thread(conversationId))?.messages[0];
  if (!first) {
    return;
  }
  const earlier = await page(conversationId, first.id);
  client.setQueryData<Thread>(keys.thread(conversationId), (thread) =>
    thread ? { messages: [...earlier.messages, ...thread.messages], more: earlier.more } : thread,
  );
}

export function useDocument(id: string) {
  return useQuery({
    queryKey: keys.document(id),
    queryFn: ({ signal }) => api.get<Document>(`/v1/documents/${id}`, signal),
  });
}

/** What the person marked in a document, oldest first. */
export function useMarks(documentId: string) {
  return useQuery({
    queryKey: keys.marks(documentId),
    queryFn: ({ signal }) =>
      api
        .get<{ marks: DocumentMark[] }>(`/v1/documents/${documentId}/marks`, signal)
        .then((r) => r.marks),
  });
}

/** How often an open artifact is read again: its page's address works for an hour. */
const ARTIFACT_EVERY = 45 * 60_000;

/**
 * An artifact with the address of its page. The address works for an hour, so the artifact
 * is read fresh for each look and again in time while it stays open.
 */
export function useArtifact(id: string) {
  return useQuery({
    queryKey: keys.artifact(id),
    queryFn: ({ signal }) => api.get<Artifact>(`/v1/artifacts/${id}`, signal),
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: ARTIFACT_EVERY,
  });
}

/** The links to a document or an artifact that still work, read anew each time they are looked at. */
export function useLinks(kind: SharedKind, id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.links(kind, id),
    enabled,
    staleTime: 0,
    queryFn: ({ signal }) => api.get<PublishedLinks>(`/v1/links?kind=${kind}&id=${id}`, signal),
  });
}

/** The contacts a copy can be sent to. */
export function useContacts(enabled: boolean) {
  return useQuery({
    queryKey: keys.contacts(),
    enabled,
    staleTime: 0,
    queryFn: ({ signal }) =>
      api.get<{ contacts: Contact[] }>("/v1/contacts", signal).then((r) => r.contacts),
  });
}

/** Where the home's models run and which one the next message uses. */
export function useModels() {
  return useQuery({
    queryKey: keys.models(),
    queryFn: ({ signal }) => api.get<Models>("/v1/models", signal),
  });
}

/** The folders of the home's computer the agents may use. */
/** The files the person sent in a conversation, newest first: read again whenever it is shown. */
export function useSentFiles(conversationId: string) {
  return useQuery({
    queryKey: keys.sentFiles(conversationId),
    queryFn: ({ signal }) =>
      api
        .get<{ files: FileRef[] }>(`/v1/conversations/${conversationId}/files`, signal)
        .then((r) => r.files),
    staleTime: 0,
  });
}

export function useFolders() {
  return useQuery({
    queryKey: keys.folders(),
    queryFn: ({ signal }) =>
      api.get<{ folders: Folder[] }>("/v1/folders", signal).then((r) => r.folders),
  });
}

/** The secrets of the home: what uses each one and when it was set. */
export function useSecrets(enabled: boolean) {
  return useQuery({
    queryKey: keys.secrets(),
    enabled,
    queryFn: ({ signal }) =>
      api.get<{ secrets: SecretEntry[] }>("/v1/secrets", signal).then((r) => r.secrets),
  });
}

/** The plugins in the home's plugins folder. The home looks into the folder on every request. */
export function usePlugins() {
  return useQuery({
    queryKey: keys.plugins(),
    queryFn: ({ signal }) => api.get<PluginsView>("/v1/plugins", signal),
  });
}

/** The person's devices, each with what it keeps and offers its agents once it said so. */
export function useDevices() {
  return useQuery({
    queryKey: keys.devices(),
    queryFn: ({ signal }) =>
      api.get<{ devices: Device[] }>("/v1/devices", signal).then((r) => r.devices),
  });
}

/** The person's avatar; null while they have made none. */
export function useAvatar() {
  return useQuery({
    queryKey: keys.avatar(),
    queryFn: ({ signal }) =>
      api.get<{ avatar: Avatar | null }>("/v1/avatar", signal).then((r) => r.avatar),
  });
}

/** The checks of the first start: each model's last test call and what the home has around it. */
export function useSetup() {
  return useQuery({
    queryKey: keys.setup(),
    queryFn: ({ signal }) => api.get<Setup>("/v1/setup", signal),
  });
}

/** Whose home this is: the person's name as their agents use it. */
export function useHome() {
  return useQuery({
    queryKey: keys.home(),
    queryFn: ({ signal }) => api.get<HomeInfo>("/v1/home", signal),
  });
}

/**
 * A file's bytes. The home sends a file only to a device that names its token, so the page
 * fetches it and shows the blob.
 */
const bytes = (id: string) => ({
  queryKey: keys.file(id),
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.open(`/v1/files/${id}`, { signal }).then((res) => res.blob()),
});

/** A file's bytes as a URL the page can show, for as long as the component is. */
export function useFileUrl(id: string) {
  const file = useQuery(bytes(id));
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file.data) {
      setUrl(undefined);
      return;
    }
    const made = URL.createObjectURL(file.data);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file.data]);
  return { url, failed: file.isError };
}

/** A file's bytes, from the page's own copy when it has one. */
export function fileBlob(client: QueryClient, id: string): Promise<Blob> {
  return client.fetchQuery(bytes(id));
}
