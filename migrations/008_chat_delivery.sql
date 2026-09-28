-- Командный топик и время рассылки (E-2) живут на группе, не на проекте и не на участнике.
-- reports_topic_id пуст, пока топик не выбран. Номер — целое больше нуля.
-- daily_cron пуст, пока время не задано: включение рассылки — это же поле чата.
-- Топик исполнителя сюда не пишется: он в project_members.topic_id.
-- Командный топик в project_members не пишется.

ALTER TABLE chats
  ADD COLUMN reports_topic_id bigint,
  ADD COLUMN daily_cron text,
  ADD CONSTRAINT chats_reports_topic_id_positive CHECK (reports_topic_id IS NULL OR reports_topic_id > 0),
  ADD CONSTRAINT chats_daily_cron_not_blank CHECK (daily_cron IS NULL OR length(btrim(daily_cron)) > 0);
