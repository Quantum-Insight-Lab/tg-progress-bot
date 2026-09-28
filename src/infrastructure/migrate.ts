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

/** Таблица супергрупп: поля и constraint'ы группы. */
export function readChatsMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '004_chats.sql'), 'utf8');
}

/** Таблица участников: поля и constraint'ы роли. */
export function readProjectMembersMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '005_project_members.sql'), 'utf8');
}

/** Топик исполнителя: колонка `project_members.topic_id` и constraint номера. */
export function readMemberTopicMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '006_member_topic.sql'), 'utf8');
}
