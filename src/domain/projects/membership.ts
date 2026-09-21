import { EVENT_TYPES } from "../../events/generated/event-types.js";
import type { PayloadByType } from "../../events/generated/payloads.js";
import { DomainError } from "../shared/errors.js";
import type { ProjectMember, Role } from "./types.js";

export type MemberAddedEvent = {
  type: typeof EVENT_TYPES.PROJECT_MEMBER_ADDED;
  actor: { id: string; role: Role };
  subject: { entity: "ProjectMember"; id: string };
  payload: PayloadByType["project.member_added"];
  idempotencyKey: string;
};

export type MemberRemovedEvent = {
  type: typeof EVENT_TYPES.PROJECT_MEMBER_REMOVED;
  actor: { id: string; role: Role };
  subject: { entity: "ProjectMember"; id: string };
  payload: PayloadByType["project.member_removed"];
  idempotencyKey: string;
};

export function requireMember(
  member: ProjectMember | undefined,
): ProjectMember {
  if (member === undefined) {
    throw new DomainError("not_a_member", "Нет доступа");
  }
  return member;
}

function leadOf(
  roster: readonly ProjectMember[],
  projectId: string,
  userId: string,
): ProjectMember {
  const actor = requireMember(
    roster.find((m) => m.projectId === projectId && m.userId === userId),
  );
  if (actor.role !== "lead") {
    throw new DomainError("role_denied", "Нет доступа");
  }
  return actor;
}

export function addMember(input: {
  roster: readonly ProjectMember[];
  actorUserId: string;
  member: ProjectMember;
}): {
  roster: ProjectMember[];
  applied: boolean;
  event: MemberAddedEvent | null;
} {
  const actor = leadOf(input.roster, input.member.projectId, input.actorUserId);
  const existing = input.roster.find(
    (m) =>
      m.projectId === input.member.projectId && m.userId === input.member.userId,
  );
  if (existing !== undefined) {
    return { roster: [...input.roster], applied: false, event: null };
  }
  return {
    roster: [...input.roster, input.member],
    applied: true,
    event: {
      type: EVENT_TYPES.PROJECT_MEMBER_ADDED,
      actor: { id: actor.userId, role: actor.role },
      subject: { entity: "ProjectMember", id: input.member.id },
      payload: {
        project_id: input.member.projectId,
        user_id: input.member.userId,
        role: input.member.role,
        topic_id: input.member.topicId,
      },
      idempotencyKey: `${input.member.projectId}+${input.member.userId}`,
    },
  };
}

export function removeMember(input: {
  roster: readonly ProjectMember[];
  actorUserId: string;
  projectId: string;
  userId: string;
  removedAt: string;
}): {
  roster: ProjectMember[];
  applied: boolean;
  event: MemberRemovedEvent | null;
} {
  const actor = leadOf(input.roster, input.projectId, input.actorUserId);
  const existing = input.roster.find(
    (m) => m.projectId === input.projectId && m.userId === input.userId,
  );
  if (existing === undefined) {
    return { roster: [...input.roster], applied: false, event: null };
  }
  return {
    roster: input.roster.filter((m) => m.id !== existing.id),
    applied: true,
    event: {
      type: EVENT_TYPES.PROJECT_MEMBER_REMOVED,
      actor: { id: actor.userId, role: actor.role },
      subject: { entity: "ProjectMember", id: existing.id },
      payload: { project_id: input.projectId, user_id: input.userId },
      idempotencyKey: `${input.projectId}+${input.userId}+${input.removedAt}`,
    },
  };
}
