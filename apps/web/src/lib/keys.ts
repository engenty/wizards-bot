/**
 * The query keys, named once: the queries, the event stream that writes into them and the
 * invalidations after a save all use these.
 */
export const keys = {
  agents: () => ["agents"] as const,
  /** An agent with its memory and its scheduled tasks. */
  agent: (id: string) => ["agent", id] as const,
  /** Every open card that waits for the person. */
  items: () => ["items"] as const,
  thread: (conversationId: string | undefined) => ["thread", conversationId] as const,
  threads: () => ["thread"] as const,
  document: (id: string) => ["document", id] as const,
  /** What the person marked in a document. */
  marks: (documentId: string) => ["marks", documentId] as const,
  artifact: (id: string) => ["artifact", id] as const,
  /** The published links of a document or an artifact that still work. */
  links: (kind: string, id: string) => ["links", kind, id] as const,
  /** The connected contacts. */
  contacts: () => ["contacts"] as const,
  models: () => ["models"] as const,
  folders: () => ["folders"] as const,
  /** What uses each secret of the home, never a value. */
  secrets: () => ["secrets"] as const,
  /** The person's devices with what each keeps and offers its agents. */
  devices: () => ["devices"] as const,
  /** The files the person sent in a conversation. */
  sentFiles: (conversationId: string) => ["sentFiles", conversationId] as const,
  /** The person's avatar; null: none made yet. */
  avatar: () => ["avatar"] as const,
  /** Whose home this is. */
  home: () => ["home"] as const,
  /** The checks of the first start, with each model's last test call. */
  setup: () => ["setup"] as const,
  /** A file's bytes, as a blob. */
  file: (id: string) => ["file", id] as const,
};
