-- Топик исполнителя (E-4): project_members.topic_id.
-- В chats его нет: топик исполнителя живёт на участнике, не на группе.
-- Пусто, пока топик не указан. Номер — целое больше нуля.

ALTER TABLE project_members
  ADD COLUMN topic_id bigint,
  ADD CONSTRAINT project_members_topic_id_positive CHECK (topic_id IS NULL OR topic_id > 0);
