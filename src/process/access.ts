import type { MemberDirectory, ProjectMember, Role } from "../domain/projects/index.js";
import { ROLES } from "../domain/projects/index.js";
import { getDb } from "../infrastructure/db.js";
import type { IdentityDirectories } from "../telegram/bind.js";

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function createRuntimeAccess(): {
  reload: () => Promise<void>;
  directory: () => MemberDirectory;
  identity: () => IdentityDirectories & {
    findProjectIdsByUserId: (userId: string) => readonly string[];
  };
} {
  let members: ProjectMember[] = [];
  const projectByChat = new Map<string, string>();
  const userByTelegram = new Map<string, string>();
  const projectsByUser = new Map<string, string[]>();

  return {
    async reload() {
      const db = getDb();
      const rows = await db
        .selectFrom("project_members")
        .innerJoin("users", "users.id", "project_members.user_id")
        .innerJoin("projects", "projects.id", "project_members.project_id")
        .select([
          "project_members.id as id",
          "project_members.project_id as project_id",
          "project_members.user_id as user_id",
          "project_members.role as role",
          "project_members.topic_id as topic_id",
          "users.telegram_user_id as telegram_user_id",
          "projects.telegram_chat_id as telegram_chat_id",
        ])
        .execute();
      members = [];
      projectByChat.clear();
      userByTelegram.clear();
      projectsByUser.clear();
      for (const row of rows) {
        if (!isRole(row.role)) {
          continue;
        }
        const topicId =
          row.topic_id === null ? null : Number.parseInt(row.topic_id, 10);
        members.push({
          id: row.id,
          projectId: row.project_id,
          userId: row.user_id,
          role: row.role,
          topicId: Number.isFinite(topicId) ? topicId : null,
        });
        projectByChat.set(row.telegram_chat_id, row.project_id);
        userByTelegram.set(row.telegram_user_id, row.user_id);
        const list = projectsByUser.get(row.user_id) ?? [];
        if (!list.includes(row.project_id)) {
          list.push(row.project_id);
        }
        projectsByUser.set(row.user_id, list);
      }
    },
    directory: () => ({
      find: (projectId, userId) =>
        members.find(
          (member) => member.projectId === projectId && member.userId === userId,
        ),
    }),
    identity: () => ({
      findProjectByChatId: (chatId) => {
        const id = projectByChat.get(chatId);
        return id === undefined ? undefined : { id };
      },
      findUserByTelegramId: (telegramUserId) => {
        const id = userByTelegram.get(telegramUserId);
        return id === undefined ? undefined : { id };
      },
      findProjectIdsByUserId: (userId) => projectsByUser.get(userId) ?? [],
    }),
  };
}
