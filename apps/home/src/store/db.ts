import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists secret (name text primary key, value blob not null, updated_at text not null);
create table if not exists vault_item (
  id text primary key, kind text not null, label text not null, origin text, hint text not null default '',
  sealed text not null, created_at text not null, updated_at text not null);
create table if not exists vault_activity (
  id text primary key, item_id text, label text not null, action text not null, origin text,
  agent_id text, reason text, at text not null);
create index if not exists vault_activity_at on vault_activity(at);
create table if not exists device (
  id text primary key, name text not null, kind text not null, token_hash text not null unique,
  push text, quiet text, created_at text not null, seen_at text not null);
create table if not exists pairing (code text primary key, expires_at text not null);
create table if not exists admin (
  id text primary key, name text not null, role text not null, created_at text not null);
create table if not exists admin_pass (jti text primary key, expires_at text not null);
create table if not exists conversation_read (
  conversation_id text not null references conversation(id) on delete cascade,
  admin_id text not null, read_at text not null, primary key (conversation_id, admin_id));
create table if not exists agent (
  id text primary key, name text not null, kind text not null, about text not null default '',
  instructions text not null default '', memory text not null default '',
  origin text not null default 'own', from_handle text, remote text,
  main integer not null default 0, created_at text not null);
create table if not exists conversation (
  id text primary key, agent_id text not null references agent(id) on delete cascade,
  updated_at text not null, read_at text not null, guest text);
create table if not exists message (
  seq integer primary key autoincrement, id text not null unique,
  conversation_id text not null references conversation(id) on delete cascade,
  role text not null, agent_id text, channel text not null, parts text not null,
  state text not null, model text, client_id text unique, created_at text not null);
create index if not exists message_conversation on message(conversation_id, seq);
create table if not exists card (
  id text primary key, kind text not null, level text not null, state text not null,
  title text not null, body text, fields text, actions text not null, url text, qr text,
  answer text, payload text, agent_id text not null, conversation_id text not null,
  message_id text not null, created_at text not null);
create index if not exists card_open on card(state, level);
create table if not exists document (
  id text primary key, title text not null, format text not null, content text not null,
  version integer not null, updated_at text not null, updated_by text not null,
  conversation_id text not null);
create table if not exists document_version (
  document_id text not null, version integer not null, content text not null,
  by text not null, at text not null, primary key (document_id, version));
create table if not exists document_mark (
  id text primary key, document_id text not null references document(id) on delete cascade,
  quote text not null, before text not null, after text not null, comment text not null,
  created_at text not null);
create index if not exists document_mark_of on document_mark(document_id);
create table if not exists artifact (
  id text primary key, title text not null, format text not null, content text not null,
  version integer not null, updated_at text not null, conversation_id text not null);
create table if not exists artifact_version (
  artifact_id text not null, version integer not null, title text not null,
  content text not null, at text not null, primary key (artifact_id, version));
create table if not exists file (
  id text primary key, name text not null, mime text not null, size integer not null,
  created_at text not null);
create table if not exists folder (
  id text primary key, name text not null unique, path text not null, access text not null,
  created_at text not null);
create table if not exists folder_activity (
  id text primary key, folder_id text not null, agent_id text, conversation_id text,
  turn text not null, read integer not null default 0, changes text not null default '[]',
  undone text not null default '[]', at text not null);
create index if not exists folder_activity_folder on folder_activity(folder_id, at);
create table if not exists connection (
  id text primary key, name text not null unique, url text not null, state text not null,
  tools text not null default '[]', policies text not null default '{}', created_at text not null);
create table if not exists schedule (
  id text primary key, agent_id text not null references agent(id) on delete cascade,
  rule text not null, prompt text not null, next_at text, created_at text not null,
  quiet integer not null default 0, paused text, failures integer not null default 0,
  last_at text, last text, state text, hook text, title text);
create table if not exists channel (
  id text primary key, state text not null, config text not null default '{}',
  owner text, created_at text not null);
create table if not exists contact (
  handle text primary key, name text not null, url text not null, public_key text not null,
  state text not null, created_at text not null);
create table if not exists share (
  id text primary key, agent_id text not null, handle text not null, mode text not null,
  created_at text not null, unique (agent_id, handle));
create table if not exists outside_agent (
  agent_id text primary key references agent(id) on delete cascade, card_url text not null,
  tenant text, sign_in text not null, context_id text, task_id text);
create table if not exists caller (
  id text primary key, agent_id text not null references agent(id) on delete cascade,
  name text not null, token_hash text not null unique, created_at text not null, heard_at text);
create table if not exists link (
  id text primary key, token text not null unique, kind text not null, source_id text not null,
  version integer not null, title text not null, password text, expires_at text,
  created_at text not null, taken_back_at text);
create index if not exists link_source on link(kind, source_id);
create table if not exists handoff (
  id text primary key, device_id text not null references device(id) on delete cascade,
  agent_id text not null references agent(id) on delete cascade, conversation_id text not null,
  text text not null, state text not null, answer text, files text, created_at text not null,
  answered_at text);
create index if not exists handoff_device on handoff(device_id, state);
create table if not exists room (
  id text primary key, name text not null, keeper text not null,
  agent_id text not null references agent(id) on delete cascade,
  seq integer not null default 0, created_at text not null);
create table if not exists room_member (
  room_id text not null references room(id) on delete cascade, id text not null,
  kind text not null, handle text not null, name text not null, agent_kind text,
  role text not null, seen integer not null default 0, primary key (room_id, id));
create table if not exists room_message (
  room_id text not null references room(id) on delete cascade, seq integer not null,
  id text not null, member_id text not null, kind text not null, name text not null,
  agent_kind text, of_name text, text text not null, at text not null,
  primary key (room_id, seq));
create unique index if not exists room_message_id on room_message(room_id, id);
create table if not exists outbox (
  id integer primary key autoincrement, handle text not null, path text not null,
  body text not null, created_at text not null);
create index if not exists outbox_handle on outbox(handle, id);
create table if not exists person_record (
  seq integer primary key, payload text not null, sig text not null);
create table if not exists invite (
  id text primary key, code text not null unique, what text not null, target text,
  title text not null, expires_at text not null, used_by text, used_at text,
  taken_back_at text, created_at text not null);
`;

/** Columns a table got after homes were made with it: table, column, definition. */
const ADDED: [string, string, string][] = [
  ["agent", "color", "text"],
  ["outside_agent", "version", "text not null default '1.0'"],
  ["schedule", "quiet", "integer not null default 0"],
  ["schedule", "paused", "text"],
  ["schedule", "failures", "integer not null default 0"],
  ["schedule", "last_at", "text"],
  ["schedule", "last", "text"],
  ["schedule", "state", "text"],
  ["schedule", "hook", "text"],
  ["schedule", "title", "text"],
  ["device", "resources", "text"],
  ["device", "agents", "text"],
  ["message", "sender", "text"],
  ["message", "queued", "integer not null default 0"],
  ["contact", "limited", "integer not null default 0"],
  ["share", "memory", "text not null default 'none'"],
  ["invite", "memory", "text not null default 'none'"],
  ["contact", "person_id", "text"],
  ["contact", "person_key", "text"],
  ["contact", "person_seq", "integer"],
  ["folder", "allow", "text not null default 'ask'"],
  ["device", "admin_id", "text"],
  ["pairing", "admin_id", "text"],
  ["artifact", "summary", "text"],
];

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(dataDir: string) {
    this.raw = new DatabaseSync(dataDir === ":memory:" ? ":memory:" : join(dataDir, "home.db"));
    this.raw.exec(
      "pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;",
    );
    this.raw.exec(SCHEMA);
    for (const [table, column, definition] of ADDED) {
      const has = this.all<{ name: string }>(`pragma table_info(${table})`).some(
        (known) => known.name === column,
      );
      if (!has) this.raw.exec(`alter table ${table} add column ${column} ${definition}`);
    }
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.raw.prepare(sql).run(...params);
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  transaction<T>(work: () => T): T {
    this.raw.exec("begin immediate");
    try {
      const result = work();
      this.raw.exec("commit");
      return result;
    } catch (error) {
      this.raw.exec("rollback");
      throw error;
    }
  }

  meta(key: string): string | undefined {
    return this.get<{ value: string }>("select value from meta where key = ?", key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run(
      "insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
      key,
      value,
    );
  }

  close(): void {
    this.raw.close();
  }
}
