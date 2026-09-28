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
  github_login: string | null;
  name: string;
  is_root: boolean;
}

export interface ProjectsTable {
  id: string;
  name: string;
  description: string;
  timezone: string;
  chat_id: string | null;
  /** Пусто, пока репозиторий не подключён. Один id — у нескольких проектов. */
  repository_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Date;
}

export interface ChatsTable {
  id: string;
  telegram_chat_id: string;
  timezone: string;
  /** Пусто, пока командный топик не выбран. Топик исполнителя этой колонкой не является. */
  reports_topic_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Пусто, пока время рассылки не задано. Включение рассылки — наличие этого значения. */
  daily_cron: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface ProjectMembersTable {
  id: string;
  project_id: string;
  user_id: string;
  role: 'member' | 'lead';
  /** Пусто, пока топик не указан. Вставка участника колонку не заполняет. */
  topic_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Задача (E-5): шаг в Telegram. Статус и приоритет — закрытый перечень. Ключ — id. */
export interface TasksTable {
  id: string;
  project_id: string;
  number: number;
  title: string;
  status: 'PLANNED' | 'IN_PROGRESS' | 'BLOCKED' | 'REVIEW' | 'DONE' | 'CANCELLED';
  priority: 'high' | 'normal' | 'low';
  assignee_id: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

/** Репозиторий установки GitHub App (E-9). Ключ — id GitHub, не проект. */
export interface RepositoriesTable {
  id: string;
  owner: string;
  name: string;
}

export interface Database {
  events: EventsTable;
  users: UsersTable;
  projects: ProjectsTable;
  chats: ChatsTable;
  project_members: ProjectMembersTable;
  tasks: TasksTable;
  repositories: RepositoriesTable;
}
