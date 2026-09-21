import { getDb } from "../infrastructure/db.js";

export type ReportTargetRow = {
  id: string;
  projectId: string;
  chatId: string;
  topicId: string | null;
  scheduleCron: string;
  timezone: string;
};

export async function reportTargets(): Promise<ReportTargetRow[]> {
  const db = getDb();
  return (
    await db
      .selectFrom("report_targets")
      .innerJoin("projects", "projects.id", "report_targets.project_id")
      .select([
        "report_targets.id as id",
        "report_targets.project_id as project_id",
        "report_targets.chat_id as chat_id",
        "report_targets.topic_id as topic_id",
        "report_targets.schedule_cron as schedule_cron",
        "projects.timezone as timezone",
      ])
      .where("report_targets.report_type", "=", "daily")
      .execute()
  ).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    chatId: row.chat_id,
    topicId: row.topic_id,
    scheduleCron: row.schedule_cron,
    timezone: row.timezone,
  }));
}
