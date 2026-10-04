import type { Bot } from 'grammy';
import type { ReportCommands, ReportDocument, ReportMessage } from '../domain/projects/deliver-report.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { dailyReport, type DailyReportView } from '../projections/daily-report.ts';
import { traceHandler, traceRefusal } from './update-log.ts';

/** Группа ещё не привязана — командного отчёта нет. */
export const REPORT_UNBOUND = 'Пока супергруппа не привязана, отчёта группы нет.';

/** Чужой группе отчёт не отдаём. */
export const REPORT_ACCESS = 'Нет доступа.';

function viewOf(document: ReportDocument): DailyReportView {
  return {
    chatId: document.chatId,
    date: document.date,
    audience: document.audience,
    memberId: document.memberId,
    shareAtStart: document.shareAtStart,
    shareAtEnd: document.shareAtEnd,
    remainderAtEnd: document.remainderAtEnd,
    projects: document.projects.map((project) => ({
      chatId: project.chatId,
      memberIds: project.memberIds,
      backlog: {
        projectName: project.name,
        shareAtStart: project.backlog.shareAtStart,
        shareAtEnd: project.backlog.shareAtEnd,
        remainderAtEnd: project.backlog.remainderAtEnd,
        closed: project.backlog.closed,
        openedNew: project.backlog.openedNew,
        confirmedOn: [],
      },
      tasks: project.tasks,
      now: project.now,
      next: project.next,
      risk: {
        reasons: project.reasons,
        defaultBranchCiRed: project.repository?.ci === 'failure',
        pullRequests: [],
      },
      divergence: project.divergence,
      repository:
        project.repository === null
          ? null
          : {
              repositoryId: project.repository.repositoryId,
              slug: project.repository.slug,
              ci: project.repository.ci,
              commits: project.repository.commits,
              mergedPullRequests: project.repository.mergedPullRequests,
              closedIssueTitles: [],
            },
    })),
  };
}

/** Текст отчёта из фактов. Одинаковые факты дают один и тот же текст. */
export function renderReportDocuments(documents: readonly ReportDocument[]): string {
  return documents.map((document) => dailyReport(viewOf(document))).join('\n\n');
}

function noteOf(error: DomainError): string | null {
  traceRefusal(error);
  switch (error.code) {
    case DOMAIN_ERROR.REPORT_UNBOUND:
      return REPORT_UNBOUND;
    case DOMAIN_ERROR.REPORT_ACCESS:
      return REPORT_ACCESS;
    case DOMAIN_ERROR.REPORT_CHAT:
      return null;
    default:
      throw error;
  }
}

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

/**
 * `/report` в личке отвечает сразу, даже если рассылка группы выключена.
 * Из группы текст уходит в командный топик, а пока его нет — в тот же чат.
 */
export async function replyToReportCommand(
  place: { type: string | undefined; id: string | undefined },
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  actions: ReportCommands,
): Promise<ReportMessage | null> {
  if (from === undefined || from.is_bot) return null;
  try {
    return await actions.request({
      telegramUserId: String(from.id),
      chatType: place.type ?? '',
      telegramChatId: place.id ?? '',
      idempotencyKey,
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const text = noteOf(error);
    if (text === null || place.id === undefined) return null;
    return { telegramChatId: place.id, topicId: null, text };
  }
}

/** Команда `/report` на единственном экземпляре grammY. */
export function attachReport(bot: Bot, actions: ReportCommands): void {
  bot.command('report', async (ctx) => {
    traceHandler('report');
    const chat = ctx.chat;
    const message = await replyToReportCommand(
      { type: chat?.type, id: chat === undefined ? undefined : String(chat.id) },
      ctx.from,
      String(ctx.update.update_id),
      actions,
    );
    if (message === null) return;
    if (message.topicId === null) await ctx.api.sendMessage(message.telegramChatId, message.text);
    else await ctx.api.sendMessage(message.telegramChatId, message.text, { message_thread_id: message.topicId });
  });
}
