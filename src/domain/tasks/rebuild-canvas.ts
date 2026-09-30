import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/**
 * Пересборка — только корень и только сегодняшний канвас в личке.
 * Прошлый день команда не трогает (INV-24).
 */
export function acceptRebuild(input: { isRoot: boolean; privateChat: boolean; canvasDate: string; today: string }): void {
  if (!input.privateChat) throw new DomainError(DOMAIN_ERROR.REBUILD_CHAT, 'пересборка в личке');
  if (!input.isRoot) throw new DomainError(DOMAIN_ERROR.REBUILD_ROOT, 'пересобирает корень');
  if (input.canvasDate !== input.today) throw new DomainError(DOMAIN_ERROR.REBUILD_DATE, 'только сегодняшний канвас');
}

export interface RebuildRequest {
  canvasId: string;
  projectId: string;
  assigneeId: string;
  canvasDate: string;
  requestedBy: string;
  idempotencyKey: string;
  isRoot: boolean;
  privateChat: boolean;
  today: string;
}

/** A-37. Повтор того же обновления вторую просьбу не пишет. */
export async function recordRebuildRequest(journal: EventJournal, clock: Clock, input: RebuildRequest): Promise<string> {
  acceptRebuild({
    isRoot: input.isRoot,
    privateChat: input.privateChat,
    canvasDate: input.canvasDate,
    today: input.today,
  });
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) throw new DomainError(DOMAIN_ERROR.ACCESS_IDEMPOTENCY_KEY, 'ключ пересборки пуст');
  const published = await emit(journal, {
    type: EVENT_TYPES.CANVAS_REBUILD_REQUESTED,
    source: 'telegram',
    idempotencyKey,
    payload: {
      canvas_id: input.canvasId,
      project_id: input.projectId,
      assignee_id: input.assigneeId,
      canvas_date: input.canvasDate,
      requested_by: input.requestedBy,
    },
    actor: { id: input.requestedBy, role: 'root' },
    subject: { entity: 'Canvas', id: input.canvasId },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  return published.row.id;
}
