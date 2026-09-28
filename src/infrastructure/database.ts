import type { ColumnType } from 'kysely';

/** Колонка журнала не обновляется через типы Kysely: третья позиция `ColumnType` — `never` (INV-28). */
type AppendOnly<T> = ColumnType<T, T, never>;

export interface EventsTable {
  id: AppendOnly<string>;
  source: AppendOnly<string>;
  event_type: AppendOnly<string>;
  payload: AppendOnly<unknown>;
  created_at: AppendOnly<Date>;
  idempotency_key: AppendOnly<string>;
  causation_id: AppendOnly<string | null>;
  correlation_id: AppendOnly<string | null>;
  schema_version: AppendOnly<number>;
  actor_id: AppendOnly<string>;
  actor_role: AppendOnly<string>;
  subject_entity: AppendOnly<string>;
  subject_id: AppendOnly<string>;
}

export interface UsersTable {
  id: string;
  telegram_user_id: string;
  name: string;
  is_root: boolean;
}

export interface ProjectsTable {
  id: string;
  name: string;
  description: string;
  timezone: string;
  chat_id: string | null;
  created_at: Date;
}

export interface ChatsTable {
  id: string;
  telegram_chat_id: string;
  timezone: string;
}

export interface ProjectMembersTable {
  id: string;
  project_id: string;
  user_id: string;
  role: 'member' | 'lead';
}

export interface Database {
  events: EventsTable;
  users: UsersTable;
  projects: ProjectsTable;
  chats: ChatsTable;
  project_members: ProjectMembersTable;
}
