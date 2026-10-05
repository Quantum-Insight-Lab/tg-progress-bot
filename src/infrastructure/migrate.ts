import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Миграция журнала: поля таблицы и constraint'ы, не проверка в хендлере. */
export function readEventsMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '001_events.sql'), 'utf8');
}

/** Таблица пользователей: поля и constraint'ы корня, затем текущий `github_login`. */
export function readUsersMigration(root = process.cwd()): string {
  return `${readFileSync(join(root, 'migrations', '002_users.sql'), 'utf8')}\n${readGithubLoginMigration(root)}`;
}

/** Поле `github_login`: пустое не уникально, непустое — одно на бота. */
export function readGithubLoginMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '006_users_github_login.sql'), 'utf8');
}

/** Таблица проектов: поля и constraint'ы единицы учёта. */
export function readProjectsMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '003_projects.sql'), 'utf8');
}

/** Таблица супергрупп: поля и constraint'ы группы, затем командный топик и время рассылки. */
export function readChatsMigration(root = process.cwd()): string {
  return `${readFileSync(join(root, 'migrations', '004_chats.sql'), 'utf8')}\n${readChatDeliveryMigration(root)}`;
}

/** Командный топик и `daily_cron` на `chats`: пусто допустимо, пустая строка и неположительный номер — нет. */
export function readChatDeliveryMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '008_chat_delivery.sql'), 'utf8');
}

/** Таблица участников: поля и constraint'ы роли. */
export function readProjectMembersMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '005_project_members.sql'), 'utf8');
}

/** Топик исполнителя: колонка `project_members.topic_id` и constraint номера. */
export function readMemberTopicMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '007_member_topic.sql'), 'utf8');
}

/** Таблица репозиториев установки GitHub App: `id`, `owner`, `name` и constraint'ы. */
export function readRepositoriesMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '009_repositories.sql'), 'utf8');
}

/** `projects.repository_id`: пусто допустимо, непустое — id из `repositories`, не уникально. */
export function readProjectRepositoryMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '010_project_repository.sql'), 'utf8');
}

/** Таблица задач: поля, перечень статуса и приоритета, уникальный номер в проекте. */
export function readTasksMigration(root = process.cwd()): string {
  return `${readFileSync(join(root, 'migrations', '011_tasks.sql'), 'utf8')}\n${readTaskStatusMigration(root)}\n${readTaskNumberMigration(root)}`;
}

/** Статусы и приоритеты `tasks`: перечень — constraint. Ключ таблицы — `id`. */
export function readTaskStatusMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '012_task_status_priority.sql'), 'utf8');
}

/** `tasks.number` уникален в проекте. */
export function readTaskNumberMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '013_task_number.sql'), 'utf8');
}

/** Таблица канвасов: одно сообщение на проект, исполнителя и дату. */
export function readCanvasesMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '014_canvases.sql'), 'utf8');
}

/** Таблица пунктов канваса: задача, место и канвас переноса. Кнопок в строке нет. */
export function readCanvasItemsMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '015_canvas_items.sql'), 'utf8');
}

/** Таблица блокеров задач: причина, вопрос и закрытие. Строк CI и PR нет. */
export function readBlockersMigration(root = process.cwd()): string {
  return `${readFileSync(join(root, 'migrations', '016_blockers.sql'), 'utf8')}\n${readBlockerQuestionMigration(root)}`;
}

/** `blockers.message_id`: сообщение вопроса. Пусто, пока вопрос не отправлен. */
export function readBlockerQuestionMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '025_blocker_question_message.sql'), 'utf8');
}

/** Таблица issues: поля зеркала и constraint'ы состояния. Природный ключ этой миграцией не задаётся. */
export function readIssuesMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '017_issues.sql'), 'utf8');
}

/** Природный ключ issue и поля `issue_assignees`. Проекта в этих таблицах нет. */
export function readIssueMirrorMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '018_issue_mirror.sql'), 'utf8');
}

/** Таблица `issue_dependencies`: пара issues и вид связи. Проекта в строке нет. */
export function readIssueDependenciesMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '019_issue_dependencies.sql'), 'utf8');
}

/** Таблица milestones: поля зеркала, природный ключ и срок. Проекта и задачи в строке нет. */
export function readMilestonesMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '020_milestones.sql'), 'utf8');
}

/** Таблица pull_requests: поля зеркала и природный ключ. Проекта и задачи в строке нет. */
export function readPullRequestsMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '021_pull_requests.sql'), 'utf8');
}

/** CI зеркала: `repositories.default_branch_ci` и поля состояния pull request. */
export function readCiMirrorMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '022_ci_mirror.sql'), 'utf8');
}

/** Таблица commits: хвост коммитов и природный ключ. Проекта и задачи в строке нет. */
export function readCommitsMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '023_commits.sql'), 'utf8');
}

/** Таблица `progress_snapshots`: доля проекта на сутки. Строка только добавляется. */
export function readProgressSnapshotsMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '024_progress_snapshots.sql'), 'utf8');
}
