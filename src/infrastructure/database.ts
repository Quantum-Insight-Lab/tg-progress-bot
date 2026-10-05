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

/** Канвас (E-7): одно rich-сообщение на проект, исполнителя и дату. Ключ — id. */
export interface CanvasesTable {
  id: string;
  project_id: string;
  assignee_id: string;
  topic_id: string;
  message_id: string;
  canvas_date: string;
}

/**
 * Пункт канваса (E-8): задача на канвасе и её место.
 * Кнопки в строку не складываются. Перенос пуст, пока пункт не перенесён.
 */
export interface CanvasItemsTable {
  id: string;
  canvas_id: string;
  task_id: string;
  position: number;
  carried_from_canvas_id: string | null;
}

/**
 * Блокер (E-6): причина, по которой задача стоит.
 * Причина пуста, пока исполнитель не ответил. Открыт, пока `resolved_at` пуст.
 * Строк CI и PR в таблице нет.
 */
export interface BlockersTable {
  id: string;
  task_id: string;
  reason: string | null;
  asked_at: Date;
  resolved_at: Date | null;
  /** Пусто, пока вопрос в топик не отправлен. */
  message_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** Репозиторий установки GitHub App (E-9). Ключ — id GitHub, не проект. */
export interface RepositoriesTable {
  id: string;
  owner: string;
  name: string;
  /** Пусто, пока workflow основной ветки не завершился. */
  default_branch_ci: ColumnType<
    'success' | 'failure' | 'cancelled' | 'other' | null,
    'success' | 'failure' | 'cancelled' | 'other' | null | undefined,
    'success' | 'failure' | 'cancelled' | 'other' | null
  >;
}

/**
 * Issue зеркала (E-10). Ключ — id.
 * `state_reason` пуст у открытого. Природный ключ — `repository_id` и `issue_number`, не проект.
 */
export interface IssuesTable {
  id: string;
  repository_id: string;
  issue_number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason: 'completed' | 'not_planned' | null;
  closed_by_login: string | null;
  updated_at: Date;
  closed_at: Date | null;
}

/** Assignee issue (E-11): логин на issue. Ключ — `issue_id` и `login`. Проекта в строке нет. */
export interface IssueAssigneesTable {
  issue_id: string;
  login: string;
}

/**
 * Связь issues (E-12): `blocked_by` или `sub_issue`.
 * Ключ — `issue_id`, `depends_on_issue_id` и `link_type`. Проекта в строке нет.
 */
export interface IssueDependenciesTable {
  issue_id: string;
  depends_on_issue_id: string;
  link_type: 'blocked_by' | 'sub_issue';
}

/**
 * Milestone зеркала (E-13). Ключ — id.
 * Природный ключ — `repository_id` и `milestone_number`, не проект и не задача.
 * `due_on` пуст, пока в GitHub срока нет.
 */
export interface MilestonesTable {
  id: string;
  repository_id: string;
  milestone_number: number;
  title: string;
  state: 'open' | 'closed';
  due_on: string | null;
}

/**
 * Pull request зеркала (E-14). Ключ — id.
 * Природный ключ — `repository_id` и `pull_request_number`, не проект и не задача.
 * `ci_status` пуст, пока workflow этого PR не завершился.
 * `merged_at` и `merged_by_login` пусты, пока PR не смержен.
 */
export interface PullRequestsTable {
  id: string;
  repository_id: string;
  pull_request_number: number;
  title: string;
  author_login: string;
  state: 'open' | 'closed' | 'merged';
  ci_status: 'success' | 'failure' | 'cancelled' | 'other' | null;
  updated_at: Date;
  merged_at: Date | null;
  merged_by_login: string | null;
}

/**
 * Коммит зеркала (E-15). Ключ — id.
 * Природный ключ — `repository_id` и `sha`, не проект и не задача.
 * Строка живёт, пока коммит внутри окна `COMMITS_TAIL_DAYS`.
 */
export interface CommitsTable {
  id: string;
  repository_id: string;
  sha: string;
  message: string;
  author_login: string;
  created_at: Date;
}

/**
 * Снимок доли (E-16): доля бэклога проекта на сутки.
 * Ключ — id. Дата суток — в факте `progress.snapshot_taken`, не в этой строке.
 * `progress` пуст, когда доли нет. Записанная строка не переписывается.
 */
export interface ProgressSnapshotsTable {
  id: string;
  project_id: string;
  progress: number | null;
  created_at: Date;
}

export interface Database {
  events: EventsTable;
  users: UsersTable;
  projects: ProjectsTable;
  chats: ChatsTable;
  project_members: ProjectMembersTable;
  tasks: TasksTable;
  canvases: CanvasesTable;
  canvas_items: CanvasItemsTable;
  blockers: BlockersTable;
  repositories: RepositoriesTable;
  issues: IssuesTable;
  issue_assignees: IssueAssigneesTable;
  issue_dependencies: IssueDependenciesTable;
  milestones: MilestonesTable;
  pull_requests: PullRequestsTable;
  commits: CommitsTable;
  progress_snapshots: ProgressSnapshotsTable;
}
