-- Сообщение вопроса о блокере (E-6): `message_id` в топике.
-- Пусто, пока вопрос не отправлен. Положительное, когда Telegram вернул сообщение.
-- Одно сообщение — один блокер. Пустых значений может быть несколько.

ALTER TABLE blockers ADD COLUMN message_id bigint;

ALTER TABLE blockers ADD CONSTRAINT blockers_message_id_positive CHECK (message_id IS NULL OR message_id > 0);

ALTER TABLE blockers ADD CONSTRAINT blockers_message_id_unique UNIQUE (message_id);
