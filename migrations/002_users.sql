-- Пользователь (E-1): человек с аккаунтом Telegram. Корень — первый lead.
-- github_login этой миграцией не добавляется.
-- telegram_user_id уникален. is_root истинен ровно у одного, когда строки есть:
-- частичный уникальный индекс — не больше одного корня, отложенный constraint — не ноль.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  telegram_user_id bigint NOT NULL,
  name text NOT NULL,
  is_root boolean NOT NULL,
  CONSTRAINT users_telegram_user_id_unique UNIQUE (telegram_user_id)
);

CREATE UNIQUE INDEX users_one_root ON users ((true)) WHERE is_root;

CREATE FUNCTION users_require_one_root() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users)
     AND NOT EXISTS (SELECT 1 FROM users WHERE is_root) THEN
    RAISE EXCEPTION 'is_root истинен ровно у одного пользователя'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER users_require_one_root
AFTER INSERT OR UPDATE OR DELETE ON users
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION users_require_one_root();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users TO journal_app;
