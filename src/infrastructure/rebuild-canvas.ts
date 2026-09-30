import { sql, type Kysely } from 'kysely';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Logger } from '../domain/shared/logger.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { projectCalendarDate } from '../domain/shared/project-time.ts';
import { recordRebuildRequest } from '../domain/tasks/rebuild-canvas.ts';
import { CANVAS_DESTINATION_TOPIC } from '../domain/tasks/place-canvas.ts';
import type { Database } from './database.ts';
import { showCanvas, type CanvasEditResult, type CanvasHome, type CanvasSendResult } from './canvas.ts';
import { createEventJournal } from './event-journal.ts';

export interface RebuildCommand {
  telegramUserId: string;
  chat: string;
  projectName: string;
  memberName: string;
  idempotencyKey: string;
  send(home: CanvasHome): Promise<CanvasSendResult>;
  edit(home: CanvasHome, messageId: number): Promise<CanvasEditResult>;
}

/** A-37. Просьба в журнал, затем правка того же сообщения. */
export async function rebuildTodayCanvas(db: Kysely<Database>, logger: Logger, clock: Clock, input: RebuildCommand): Promise<void> {
  const now = clock.now();
  const actor = await sql<{ id: string; is_root: boolean }>`
    SELECT id::text AS id, is_root FROM users WHERE telegram_user_id = ${input.telegramUserId}::bigint
  `.execute(db);
  const user = actor.rows[0];
  if (user === undefined) throw new DomainError(DOMAIN_ERROR.REBUILD_ROOT, 'пересобирает корень');
  const projects = await sql<{ id: string; timezone: string }>`
    SELECT id::text AS id, timezone FROM projects WHERE btrim(name) = ${input.projectName.trim()}
  `.execute(db);
  if (projects.rows.length === 0) throw new DomainError(DOMAIN_ERROR.REBUILD_PROJECT, 'проект не найден');
  if (projects.rows.length > 1) throw new DomainError(DOMAIN_ERROR.REBUILD_AMBIGUOUS, 'имя проекта не одно');
  const project = projects.rows[0];
  if (project === undefined) throw new DomainError(DOMAIN_ERROR.REBUILD_PROJECT, 'проект не найден');
  const members = await sql<{ id: string }>`
    SELECT u.id::text AS id
    FROM project_members AS pm
    JOIN users AS u ON u.id = pm.user_id
    WHERE pm.project_id = ${project.id}::uuid AND btrim(u.name) = ${input.memberName.trim()}
  `.execute(db);
  if (members.rows.length === 0) throw new DomainError(DOMAIN_ERROR.REBUILD_MEMBER, 'участник не найден');
  if (members.rows.length > 1) throw new DomainError(DOMAIN_ERROR.REBUILD_AMBIGUOUS, 'имя участника не одно');
  const member = members.rows[0];
  if (member === undefined) throw new DomainError(DOMAIN_ERROR.REBUILD_MEMBER, 'участник не найден');
  const today = projectCalendarDate(now, project.timezone);
  const canvases = await sql<{ id: string; canvas_date: string }>`
    SELECT id::text AS id, canvas_date::text AS canvas_date
    FROM canvases
    WHERE project_id = ${project.id}::uuid
      AND assignee_id = ${member.id}::uuid
      AND canvas_date = ${today}::date
  `.execute(db);
  const canvas = canvases.rows[0];
  if (canvas === undefined) throw new DomainError(DOMAIN_ERROR.REBUILD_ABSENT, 'сегодняшнего канваса нет');
  const causationId = await recordRebuildRequest(createEventJournal(db, logger), clock, {
    canvasId: canvas.id,
    projectId: project.id,
    assigneeId: member.id,
    canvasDate: today,
    requestedBy: user.id,
    idempotencyKey: input.idempotencyKey,
    isRoot: user.is_root,
    privateChat: input.chat === PRIVATE_CHAT,
    today,
  });
  await showCanvas(db, logger, {
    projectId: project.id,
    assigneeId: member.id,
    destination: CANVAS_DESTINATION_TOPIC,
    now,
    causationId,
    cause: input.idempotencyKey,
    send: input.send,
    edit: input.edit,
  });
}
