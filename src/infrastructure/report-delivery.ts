import { sql, type Kysely } from 'kysely';
import {
  groupReportCommand,
  privateReportCommand,
  publishReportSent,
  REPORT_ACTOR_SYSTEM,
  REPORT_ROLE_SYSTEM,
  REPORT_SOURCE_SYSTEM,
  REPORT_TARGET_GROUP,
  REPORT_TRIGGER_SCHEDULE,
  scheduledReport,
  type ReportActor,
  type ReportDocument,
  type ReportGroup,
  type ReportProjectFacts,
  type ReportProjectRef,
  type ReportRepositoryFacts,
  type ReportCommands,
  type ReportMessage,
  type ReportRenderer,
  type ReportSection,
  type ReportSender,
} from '../domain/projects/deliver-report.ts';
import { LEAD_ROLE, MEMBER_ROLE } from '../domain/projects/member.ts';
import { periodTaskCounters, PERIOD_TASK_COUNTER_TASK, type PeriodTaskCounterTask } from '../domain/progress/period-tasks.ts';
import { reportCurrent, REPORT_CURRENT_TASK } from '../domain/progress/report-current.ts';
import { projectCalendarDate, projectDaysBetween } from '../domain/shared/project-time.ts';
import {
  TASK_STATUS_BLOCKED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
} from '../domain/tasks/status.ts';
import { EVENT_TYPES } from '../events/index.ts';
import type { Clock } from '../domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';
import { reportWindows } from './zoned-day.ts';

interface ProjectRow {
  id: string;
  name: string;
  timezone: string;
  chat_id: string | null;
  repository_id: string | null;
}

interface TaskRow {
  id: string;
  project_id: string;
  number: number | string;
  title: string;
  status: string;
  priority: string;
  assignee_id: string;
  created_at: Date | string;
}

interface TaskEvent {
  taskId: string;
  type: string;
  at: Date;
}

const STATUS_EVENT: Record<string, string> = {
  [EVENT_TYPES.TASK_CHECKED]: TASK_STATUS_REVIEW,
  [EVENT_TYPES.TASK_UNCHECKED]: TASK_STATUS_IN_PROGRESS,
  [EVENT_TYPES.TASK_CONFIRMED]: TASK_STATUS_DONE,
  [EVENT_TYPES.TASK_RETURNED]: TASK_STATUS_IN_PROGRESS,
  [EVENT_TYPES.TASK_PLANNED]: TASK_STATUS_PLANNED,
  [EVENT_TYPES.TASK_RESUMED]: TASK_STATUS_IN_PROGRESS,
  [EVENT_TYPES.TASK_CANCELLED]: TASK_STATUS_CANCELLED,
  [EVENT_TYPES.BLOCKER_DETECTED]: TASK_STATUS_BLOCKED,
  [EVENT_TYPES.BLOCKER_DISMISSED]: TASK_STATUS_IN_PROGRESS,
};

const COUNTER_EVENTS = [
  EVENT_TYPES.TASK_CREATED,
  EVENT_TYPES.TASK_CHECKED,
  EVENT_TYPES.TASK_UNCHECKED,
  EVENT_TYPES.TASK_CONFIRMED,
  EVENT_TYPES.TASK_RETURNED,
  EVENT_TYPES.TASK_PLANNED,
  EVENT_TYPES.TASK_RESUMED,
  EVENT_TYPES.TASK_CANCELLED,
  EVENT_TYPES.BLOCKER_DETECTED,
  EVENT_TYPES.BLOCKER_DISMISSED,
];

function asText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`${label} повреждён`);
}

function topicOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(asText(value, 'reports_topic_id'));
  if (!Number.isSafeInteger(parsed)) throw new Error('reports_topic_id повреждён');
  return parsed;
}

function instantOf(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function whole(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new Error('номер задачи повреждён');
  return parsed;
}

function payloadOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return {};
  }
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  return {};
}

function standingDay(createdAt: Date, now: Date, timezone: string): number {
  const between = projectDaysBetween(createdAt, now, timezone);
  if (between < 1) return 1;
  return between + 1;
}

function ciOf(value: string | null): ReportRepositoryFacts['ci'] {
  if (value === 'success' || value === 'failure' || value === 'cancelled' || value === 'other') return value;
  return null;
}

function taskIdOf(eventType: string, subjectId: string, payload: unknown): string | null {
  if (eventType === EVENT_TYPES.BLOCKER_DETECTED || eventType === EVENT_TYPES.BLOCKER_DISMISSED) {
    const taskId = payloadOf(payload).task_id;
    return typeof taskId === 'string' ? taskId : null;
  }
  return subjectId;
}

async function actorOf(db: Kysely<Database>, telegramUserId: string): Promise<ReportActor | null> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'is_root'])
    .where('telegram_user_id', '=', telegramUserId)
    .executeTakeFirst();
  if (user === undefined) return null;
  const roles = await db.selectFrom('project_members').select('role').where('user_id', '=', user.id).execute();
  const role = roles.some((row) => row.role === LEAD_ROLE) ? LEAD_ROLE : roles.length > 0 ? MEMBER_ROLE : null;
  return { id: user.id, isRoot: user.is_root, role };
}

async function projectsOf(db: Kysely<Database>, rows: ProjectRow[]): Promise<ReportProjectRef[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const members = await db.selectFrom('project_members').select(['project_id', 'user_id']).where('project_id', 'in', ids).execute();
  const byProject = new Map<string, string[]>();
  for (const member of members) {
    const list = byProject.get(member.project_id);
    if (list === undefined) byProject.set(member.project_id, [member.user_id]);
    else list.push(member.user_id);
  }
  return rows.map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    timezone: row.timezone,
    memberIds: byProject.get(row.id) ?? [],
  }));
}

async function userProjects(db: Kysely<Database>, userId: string, isRoot: boolean): Promise<ProjectRow[]> {
  const found = isRoot
    ? await sql<ProjectRow>`
        SELECT id::text AS id, name, timezone, chat_id::text AS chat_id, repository_id
        FROM projects
        WHERE id IN (SELECT project_id FROM project_members WHERE user_id = ${userId}::uuid)
           OR id IN (
             SELECT subject_id::uuid FROM events
             WHERE event_type = ${EVENT_TYPES.PROJECT_CREATED} AND actor_id = ${userId}
           )
        ORDER BY id
      `.execute(db)
    : await sql<ProjectRow>`
        SELECT projects.id::text AS id, projects.name, projects.timezone, projects.chat_id::text AS chat_id, projects.repository_id
        FROM projects
        JOIN project_members ON project_members.project_id = projects.id
        WHERE project_members.user_id = ${userId}::uuid
        ORDER BY projects.id
      `.execute(db);
  return found.rows;
}

async function chatProjects(db: Kysely<Database>, chatId: string): Promise<ProjectRow[]> {
  const found = await sql<ProjectRow>`
    SELECT id::text AS id, name, timezone, chat_id::text AS chat_id, repository_id
    FROM projects
    WHERE chat_id = ${chatId}::uuid
    ORDER BY id
  `.execute(db);
  return found.rows;
}

async function chatTimezones(db: Kysely<Database>, chatIds: readonly string[]): Promise<Map<string, string>> {
  const ids = chatIds.filter((id) => !id.startsWith('unbound:'));
  const zones = new Map<string, string>();
  if (ids.length === 0) return zones;
  const found = await db.selectFrom('chats').select(['id', 'timezone']).where('id', 'in', ids).execute();
  for (const row of found) zones.set(row.id, row.timezone);
  return zones;
}

async function groupOf(db: Kysely<Database>, telegramChatId: string): Promise<ReportGroup | null> {
  const row = await db
    .selectFrom('chats')
    .select(['id', 'telegram_chat_id', 'timezone', 'reports_topic_id'])
    .where('telegram_chat_id', '=', telegramChatId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    id: row.id,
    telegramChatId: asText(row.telegram_chat_id, 'telegram_chat_id'),
    timezone: row.timezone,
    reportsTopicId: topicOf(row.reports_topic_id),
  };
}

async function participates(db: Kysely<Database>, chatId: string, userId: string): Promise<boolean> {
  const row = await sql<{ n: number }>`
    SELECT CAST(count(*) AS int) AS n
    FROM project_members
    JOIN projects ON projects.id = project_members.project_id
    WHERE projects.chat_id = ${chatId}::uuid AND project_members.user_id = ${userId}::uuid
  `.execute(db);
  return Number(row.rows[0]?.n ?? 0) > 0;
}

async function taskRows(db: Kysely<Database>, projectIds: readonly string[]): Promise<TaskRow[]> {
  if (projectIds.length === 0) return [];
  const found = await sql<TaskRow>`
    SELECT id::text AS id, project_id::text AS project_id, number, title, status, priority,
           assignee_id::text AS assignee_id, created_at
    FROM tasks
    WHERE project_id IN (${sql.join(projectIds.map((id) => sql`${id}::uuid`))})
  `.execute(db);
  return found.rows;
}

async function taskEvents(db: Kysely<Database>, taskIds: readonly string[]): Promise<TaskEvent[]> {
  if (taskIds.length === 0) return [];
  const found = await sql<{ event_type: string; created_at: Date | string; subject_id: string; payload: unknown }>`
    SELECT event_type, created_at, subject_id, payload
    FROM events
    WHERE event_type IN (${sql.join(COUNTER_EVENTS.map((type) => sql`${type}`))})
      AND (
        subject_id IN (${sql.join(taskIds.map((id) => sql`${id}`))})
        OR payload->>'task_id' IN (${sql.join(taskIds.map((id) => sql`${id}`))})
      )
    ORDER BY created_at
  `.execute(db);
  const events: TaskEvent[] = [];
  for (const row of found.rows) {
    const taskId = taskIdOf(row.event_type, row.subject_id, row.payload);
    if (taskId === null || !taskIds.includes(taskId)) continue;
    events.push({ taskId, type: row.event_type, at: instantOf(row.created_at) });
  }
  return events;
}

async function reasonsOf(db: Kysely<Database>, taskIds: readonly string[]): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();
  if (taskIds.length === 0) return reasons;
  const found = await sql<{ task_id: string; reason: string | null }>`
    SELECT task_id::text AS task_id, reason
    FROM blockers
    WHERE resolved_at IS NULL AND task_id IN (${sql.join(taskIds.map((id) => sql`${id}::uuid`))})
    ORDER BY asked_at
  `.execute(db);
  for (const row of found.rows) {
    if (row.reason === null || row.reason.trim().length === 0) continue;
    reasons.set(row.task_id, row.reason);
  }
  return reasons;
}

async function namesOf(db: Kysely<Database>, userIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;
  const found = await db.selectFrom('users').select(['id', 'name']).where('id', 'in', userIds).execute();
  for (const row of found) names.set(row.id, row.name);
  return names;
}

async function repositoriesOf(
  db: Kysely<Database>,
  repositoryIds: readonly string[],
  periodStart: string,
  periodEnd: string,
): Promise<Map<string, ReportRepositoryFacts>> {
  const repos = new Map<string, ReportRepositoryFacts>();
  if (repositoryIds.length === 0) return repos;
  const rows = await sql<{ id: string; owner: string; name: string; default_branch_ci: string | null }>`
    SELECT id, owner, name, default_branch_ci
    FROM repositories
    WHERE id IN (${sql.join(repositoryIds.map((id) => sql`${id}`))})
  `.execute(db);
  const commits = await sql<{ repository_id: string; n: number }>`
    SELECT repository_id, CAST(count(*) AS int) AS n
    FROM commits
    WHERE created_at >= ${periodStart}::timestamptz
      AND created_at <= ${periodEnd}::timestamptz
      AND repository_id IN (${sql.join(repositoryIds.map((id) => sql`${id}`))})
    GROUP BY repository_id
  `.execute(db);
  const merged = await sql<{ repository_id: string; n: number }>`
    SELECT repository_id, CAST(count(*) AS int) AS n
    FROM pull_requests
    WHERE state = 'merged'
      AND merged_at >= ${periodStart}::timestamptz
      AND merged_at <= ${periodEnd}::timestamptz
      AND repository_id IN (${sql.join(repositoryIds.map((id) => sql`${id}`))})
    GROUP BY repository_id
  `.execute(db);
  const commitCount = new Map(commits.rows.map((row) => [row.repository_id, Number(row.n)]));
  const mergedCount = new Map(merged.rows.map((row) => [row.repository_id, Number(row.n)]));
  for (const row of rows.rows) {
    repos.set(row.id, {
      repositoryId: row.id,
      slug: `${row.owner}/${row.name}`,
      ci: ciOf(row.default_branch_ci),
      commits: commitCount.get(row.id) ?? 0,
      mergedPullRequests: mergedCount.get(row.id) ?? 0,
    });
  }
  return repos;
}

async function divergenceOn(db: Kysely<Database>, projectIds: readonly string[], now: Date, timezones: ReadonlyMap<string, string>): Promise<Set<string>> {
  const active = new Set<string>();
  if (projectIds.length === 0) return active;
  const found = await sql<{ project_id: string | null; date: string | null }>`
    SELECT payload->>'project_id' AS project_id, payload->>'date' AS date
    FROM events
    WHERE event_type = ${EVENT_TYPES.DIVERGENCE_DETECTED}
      AND payload->>'project_id' IN (${sql.join(projectIds.map((id) => sql`${id}`))})
  `.execute(db);
  for (const row of found.rows) {
    if (row.project_id === null || row.date === null) continue;
    const timezone = timezones.get(row.project_id);
    if (timezone === undefined) continue;
    if (row.date === projectCalendarDate(now, timezone)) active.add(row.project_id);
  }
  return active;
}

function counterOf(task: TaskRow, events: readonly TaskEvent[], periodStart: Date, periodEnd: Date): PeriodTaskCounterTask {
  const related = events.filter((event) => event.taskId === task.id);
  let statusAtStart: string | null = TASK_STATUS_IN_PROGRESS;
  let createdInPeriod = instantOf(task.created_at).getTime() >= periodStart.getTime() && instantOf(task.created_at).getTime() <= periodEnd.getTime();
  const entered: string[] = [];
  const seen = new Set<string>();
  for (const event of related) {
    if (event.type === EVENT_TYPES.TASK_CREATED) {
      createdInPeriod = event.at.getTime() >= periodStart.getTime() && event.at.getTime() <= periodEnd.getTime();
      continue;
    }
    const next = STATUS_EVENT[event.type];
    if (next === undefined) continue;
    if (event.at.getTime() < periodStart.getTime()) statusAtStart = next;
    else if (event.at.getTime() <= periodEnd.getTime() && !seen.has(next)) {
      seen.add(next);
      entered.push(next);
    }
  }
  if (createdInPeriod) statusAtStart = null;
  return {
    kind: PERIOD_TASK_COUNTER_TASK,
    key: task.id,
    statusAtStart,
    entered,
  };
}

async function documentsOf(db: Kysely<Database>, sections: readonly ReportSection[], now: Date): Promise<ReportDocument[]> {
  const documents: ReportDocument[] = [];
  for (const section of sections) {
    documents.push({
      chatId: section.chatId,
      date: section.date,
      audience: section.audience,
      memberId: section.memberId,
      projects: await projectFacts(db, section, now),
    });
  }
  return documents;
}

async function projectFacts(db: Kysely<Database>, section: ReportSection, now: Date): Promise<ReportProjectFacts[]> {
  if (section.projectIds.length === 0) return [];
  const rows = await sql<ProjectRow>`
    SELECT id::text AS id, name, timezone, chat_id::text AS chat_id, repository_id
    FROM projects
    WHERE id IN (${sql.join(section.projectIds.map((id) => sql`${id}::uuid`))})
    ORDER BY id
  `.execute(db);
  const refs = await projectsOf(db, rows.rows);
  const tasks = await taskRows(db, section.projectIds);
  const events = await taskEvents(db, tasks.map((task) => task.id));
  const reasons = await reasonsOf(db, tasks.map((task) => task.id));
  const names = await namesOf(db, [...new Set(tasks.map((task) => task.assignee_id))]);
  const repositoryIds = [...new Set(rows.rows.map((row) => row.repository_id).filter((id): id is string => id !== null))];
  const repositories = await repositoriesOf(db, repositoryIds, section.periodStart, section.periodEnd);
  const zones = new Map(rows.rows.map((row) => [row.id, row.timezone]));
  const divergence = await divergenceOn(db, section.projectIds, now, zones);
  const periodStart = new Date(section.periodStart);
  const periodEnd = new Date(section.periodEnd);
  return refs.map((ref) => {
    const row = rows.rows.find((item) => item.id === ref.id);
    const timezone = row?.timezone ?? 'UTC';
    const ownTasks = tasks.filter((task) => task.project_id === ref.id);
    const counters = periodTaskCounters(ownTasks.map((task) => counterOf(task, events, periodStart, periodEnd)));
    const current = reportCurrent(
      ownTasks.map((task) => ({
        kind: REPORT_CURRENT_TASK,
        key: task.id,
        number: whole(task.number),
        title: task.title,
        status: task.status,
        priority: task.priority,
        createdAt: instantOf(task.created_at).toISOString(),
        day: standingDay(instantOf(task.created_at), now, timezone),
        assigneeName: names.get(task.assignee_id) ?? null,
        reason: task.status === TASK_STATUS_BLOCKED ? (reasons.get(task.id) ?? null) : null,
      })),
    );
    const assignee = new Map(ownTasks.map((task) => [task.id, task.assignee_id]));
    const repositoryId = row?.repository_id ?? null;
    return {
      id: ref.id,
      name: row?.name ?? '',
      chatId: section.chatId,
      memberIds:
        section.memberId !== null && !ref.memberIds.includes(section.memberId)
          ? [...ref.memberIds, section.memberId]
          : ref.memberIds,
      tasks: counters,
      now: current.now.map((task) => ({
        number: task.number,
        title: task.title,
        day: task.day,
        assigneeId: assignee.get(task.key) ?? '',
        assigneeName: task.assigneeName,
      })),
      next: current.next.map((task) => ({
        number: task.number,
        title: task.title,
        assigneeId: assignee.get(task.key) ?? '',
      })),
      reasons: current.reasons.map((reason) => ({ text: reason.text })),
      divergence: divergence.has(ref.id),
      repository: repositoryId === null ? null : (repositories.get(repositoryId) ?? null),
    };
  });
}

async function commitReport(
  db: Kysely<Database>,
  occurredAt: Date,
  fact: Parameters<typeof publishReportSent>[2],
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`report:${fact.chatId}`})::bigint)`.execute(trx);
    const published = await publishReportSent(createEventJournal(trx), occurredAt, fact);
    return published.applied;
  });
}

function messageOf(telegramChatId: string, topicId: number | null, text: string): ReportMessage {
  return { telegramChatId, topicId, text };
}

/** `/report` в личке или в группе. Текст — проекция фактов, повтор ключа молчит. */
export function createReportCommands(db: Kysely<Database>, clock: Clock, render: ReportRenderer): ReportCommands {
  return {
    async request(input) {
      const now = clock.now();
      const actor = await actorOf(db, input.telegramUserId);
      if (input.chatType === 'private') {
        const rows = actor === null ? [] : await userProjects(db, actor.id, actor.isRoot);
        const refs = (await projectsOf(db, rows)).map((project) =>
          actor !== null && actor.isRoot && !project.memberIds.includes(actor.id)
            ? { ...project, memberIds: [...project.memberIds, actor.id] }
            : project,
        );
        const zones = await chatTimezones(db, refs.map((project) => project.chatId).filter((id): id is string => id !== null));
        const command = privateReportCommand({
          actor,
          telegramUserId: input.telegramUserId,
          projects: refs,
          chatTimezones: zones,
          idempotencyKey: input.idempotencyKey,
          windows: reportWindows(now),
        });
        const documents = await documentsOf(db, command.sections, now);
        const applied = await commitReport(db, now, command);
        if (!applied) return null;
        return messageOf(command.telegramChatId, command.topicId, render(documents));
      }
      if (input.chatType !== 'group' && input.chatType !== 'supergroup') {
        throw new DomainError(DOMAIN_ERROR.REPORT_CHAT, 'отчёт запрашивают в личке или в группе');
      }
      const group = await groupOf(db, input.telegramChatId);
      const rows = group === null ? [] : await chatProjects(db, group.id);
      const refs = await projectsOf(db, rows);
      const member = actor !== null && group !== null ? await participates(db, group.id, actor.id) : false;
      const command = groupReportCommand({
        actor,
        participates: member,
        group,
        projects: refs,
        idempotencyKey: input.idempotencyKey,
        windows: reportWindows(now),
      });
      const documents = await documentsOf(db, command.sections, now);
      const applied = await commitReport(db, now, command);
      if (!applied) return null;
      return messageOf(command.telegramChatId, command.topicId, render(documents));
    },
  };
}

interface SlotRow {
  id: string;
  telegram_chat_id: string | number | bigint;
  timezone: string;
  daily_cron: string | null;
  reports_topic_id: string | number | bigint | null;
}

/**
 * A-33. В час отчёта группы пишет `report.sent` и отдаёт текст в командный топик.
 * Повтор в те же сутки второй раз не шлёт. Сбой одной группы не отменяет остальные.
 */
export async function deliverDueReports(db: Kysely<Database>, now: Date, render: ReportRenderer, send: ReportSender): Promise<void> {
  const slots = await sql<SlotRow>`
    SELECT id::text AS id, telegram_chat_id, timezone, daily_cron, reports_topic_id FROM chats ORDER BY id
  `.execute(db);
  const sentRows = await sql<{ idempotency_key: string }>`
    SELECT idempotency_key FROM events WHERE event_type = ${EVENT_TYPES.REPORT_SENT}
  `.execute(db);
  const sent = new Set(sentRows.rows.map((row) => row.idempotency_key));
  const failures: unknown[] = [];
  for (const slot of slots.rows) {
    try {
      const rows = await chatProjects(db, slot.id);
      const decision = scheduledReport(
        {
          chatId: slot.id,
          telegramChatId: asText(slot.telegram_chat_id, 'telegram_chat_id'),
          timezone: slot.timezone,
          dailyTime: slot.daily_cron,
          reportsTopicId: topicOf(slot.reports_topic_id),
        },
        rows.map((row) => row.id),
        now,
        sent,
        reportWindows(now),
      );
      if (decision === null) continue;
      const documents = await documentsOf(
        db,
        [
          {
            chatId: decision.chatId,
            date: decision.date,
            audience: 'team',
            memberId: null,
            projectIds: decision.projectIds,
            periodStart: decision.periodStart,
            periodEnd: decision.periodEnd,
          },
        ],
        now,
      );
      const applied = await commitReport(db, now, {
        target: REPORT_TARGET_GROUP,
        chatId: decision.chatId,
        subjectId: decision.chatId,
        topicId: decision.topicId,
        periodStart: decision.periodStart,
        periodEnd: decision.periodEnd,
        trigger: REPORT_TRIGGER_SCHEDULE,
        idempotencyKey: decision.idempotencyKey,
        actorId: REPORT_ACTOR_SYSTEM,
        actorRole: REPORT_ROLE_SYSTEM,
        source: REPORT_SOURCE_SYSTEM,
      });
      if (!applied) continue;
      sent.add(decision.idempotencyKey);
      await send(messageOf(decision.telegramChatId, decision.topicId, render(documents)));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) return;
  const first = failures[0];
  if (first instanceof Error) throw first;
  throw new Error('отчёт по расписанию не отправлен');
}
