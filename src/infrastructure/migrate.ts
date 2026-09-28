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

/** Таблица задач: поля, затем допустимые статус и приоритет. */
export function readTasksMigration(root = process.cwd()): string {
  return `${readFileSync(join(root, 'migrations', '011_tasks.sql'), 'utf8')}\n${readTaskStatusMigration(root)}`;
}

/** Статусы и приоритеты `tasks`: перечень — constraint. Ключ таблицы — `id`. */
export function readTaskStatusMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '012_task_status_priority.sql'), 'utf8');
}
