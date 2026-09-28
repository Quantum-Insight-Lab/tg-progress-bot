-- Группа (E-2): супергруппа, не топик. Командный топик и расписание — миграция 008.
-- telegram_chat_id < 0: топик и личный чат так не записываются.
-- Не уникален у проектов: несколько проектов садятся в одну группу (L-3).

CREATE TABLE chats (
  id uuid PRIMARY KEY,
  telegram_chat_id bigint NOT NULL,
  timezone text NOT NULL,
  CONSTRAINT chats_telegram_chat_id_unique UNIQUE (telegram_chat_id),
  CONSTRAINT chats_telegram_chat_id_supergroup CHECK (telegram_chat_id < 0),
  CONSTRAINT chats_timezone_not_blank CHECK (length(btrim(timezone)) > 0)
);

ALTER TABLE projects
  ADD CONSTRAINT projects_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats (id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE chats TO journal_app;
