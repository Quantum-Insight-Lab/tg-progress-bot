import { EVENT_TYPES } from "../../events/generated/event-types.js";
import type { PayloadByType } from "../../events/generated/payloads.js";
import { dailyPeriodKey, reportSentKey } from "./schedule.js";

export const REPORT_ACTOR = { id: "system", role: "system" } as const;

export type ReportSentEvent = {
  type: typeof EVENT_TYPES.REPORT_SENT;
  actor: typeof REPORT_ACTOR;
  subject: { entity: "ReportTarget"; id: string };
  payload: PayloadByType["report.sent"];
  idempotencyKey: string;
};

export function recordReportSent(input: {
  targetId: string;
  reportType: "daily";
  projectIds: readonly string[];
  destination: "dm" | "group";
  chatId: number;
  topicId: number | null;
  periodDate: string;
}): ReportSentEvent {
  const periodKey = dailyPeriodKey(input.periodDate);
  return {
    type: EVENT_TYPES.REPORT_SENT,
    actor: REPORT_ACTOR,
    subject: { entity: "ReportTarget", id: input.targetId },
    payload: {
      report_type: input.reportType,
      project_ids: [...input.projectIds],
      destination: input.destination,
      chat_id: input.chatId,
      topic_id: input.topicId,
    },
    idempotencyKey: reportSentKey({
      reportType: input.reportType,
      destination: input.destination,
      chatId: input.chatId,
      periodKey,
    }),
  };
}
