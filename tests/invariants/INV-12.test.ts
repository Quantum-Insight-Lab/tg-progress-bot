import { beforeEach, expect, it } from "vitest";
import { DomainError } from "../../src/domain/shared/errors.js";
import {
  addMember,
  registerGuardedHandler,
  registeredHandlers,
  removeMember,
  requireMember,
  resetHandlerRegistry,
  type Project,
  type ProjectMember,
} from "../../src/domain/projects/index.js";
import { EVENT_TYPES } from "../../src/events/generated/event-types.js";

const project: Project = {
  id: "p1",
  name: "Секретный проект",
  repository: "org/repo",
  timezone: "Asia/Bangkok",
  telegramChatId: "1",
};

const lead: ProjectMember = {
  id: "m-lead",
  projectId: project.id,
  userId: "u-lead",
  role: "lead",
  topicId: null,
};

const member: ProjectMember = {
  id: "m-user",
  projectId: project.id,
  userId: "u-member",
  role: "member",
  topicId: 10,
};

beforeEach(() => {
  resetHandlerRegistry();
});

it("INV-12: неизвестный пользователь отклонён", () => {
  try {
    requireMember(undefined);
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const denied = error as DomainError;
    expect(denied.code).toBe("not_a_member");
    expect(denied.message).not.toMatch(/Секретный|p1|org\/repo/i);
  }
});

it("INV-12: фабрика не вызывает хендлер и не отдаёт данные не-участнику", async () => {
  const roster = [lead];
  let called = false;
  const handle = registerGuardedHandler(
    "report",
    {
      find: (projectId, userId) =>
        roster.find((m) => m.projectId === projectId && m.userId === userId),
    },
    () => {
      called = true;
      return project.name;
    },
  );
  await expect(
    handle({ projectId: project.id, userId: "stranger" }),
  ).rejects.toMatchObject({ code: "not_a_member" });
  expect(called).toBe(false);
  expect(registeredHandlers().every((h) => h.guarded)).toBe(true);
});

it("INV-12: участник проходит guard", async () => {
  const roster = [lead];
  const handle = registerGuardedHandler(
    "ok",
    {
      find: (projectId, userId) =>
        roster.find((m) => m.projectId === projectId && m.userId === userId),
    },
    (_input, current) => current.role,
  );
  await expect(
    handle({ projectId: project.id, userId: lead.userId }),
  ).resolves.toBe("lead");
});

it("lead добавляет участника и публикует project.member_added", () => {
  const result = addMember({
    roster: [lead],
    actorUserId: lead.userId,
    member,
  });
  expect(result.applied).toBe(true);
  expect(result.roster).toHaveLength(2);
  expect(result.event?.type).toBe(EVENT_TYPES.PROJECT_MEMBER_ADDED);
  expect(result.event?.payload).toEqual({
    project_id: project.id,
    user_id: member.userId,
    role: "member",
    topic_id: 10,
  });
});

it("повторное добавление того же участника не меняет состав", () => {
  const first = addMember({
    roster: [lead],
    actorUserId: lead.userId,
    member,
  });
  const second = addMember({
    roster: first.roster,
    actorUserId: lead.userId,
    member,
  });
  expect(second.applied).toBe(false);
  expect(second.event).toBeNull();
  expect(second.roster).toHaveLength(2);
});

it("member не может добавить участника", () => {
  expect(() =>
    addMember({
      roster: [lead, member],
      actorUserId: member.userId,
      member: {
        id: "m2",
        projectId: project.id,
        userId: "u2",
        role: "viewer",
        topicId: null,
      },
    }),
  ).toThrow(DomainError);
});

it("lead снимает участника; доступ после снятия закрыт", () => {
  const added = addMember({
    roster: [lead],
    actorUserId: lead.userId,
    member,
  });
  const removed = removeMember({
    roster: added.roster,
    actorUserId: lead.userId,
    projectId: project.id,
    userId: member.userId,
    removedAt: "2026-09-21T00:00:00.000Z",
  });
  expect(removed.applied).toBe(true);
  expect(removed.event?.type).toBe(EVENT_TYPES.PROJECT_MEMBER_REMOVED);
  expect(
    removed.roster.find((m) => m.userId === member.userId),
  ).toBeUndefined();
  expect(() =>
    requireMember(
      removed.roster.find(
        (m) => m.projectId === project.id && m.userId === member.userId,
      ),
    ),
  ).toThrow(DomainError);
});
