export const ROLES = ["viewer", "member", "lead"] as const;

export type Role = (typeof ROLES)[number];

export type User = {
  id: string;
  telegramUserId: string;
  githubLogin: string | null;
};

export type Project = {
  id: string;
  name: string;
  repository: string;
  timezone: string;
  telegramChatId: string;
};

export type ProjectMember = {
  id: string;
  projectId: string;
  userId: string;
  role: Role;
  topicId: number | null;
};
