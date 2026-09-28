-- Пользователь (E-1): текущий логин GitHub.
-- NULL — сопоставления нет; пустая строка запрещена, несколько NULL уникальность не нарушают.
-- Непустой логин один на бота без учёта регистра. Смена ника заменяет значение, история не хранится.

ALTER TABLE users ADD COLUMN github_login text;

ALTER TABLE users ADD CONSTRAINT users_github_login_not_blank
  CHECK (github_login IS NULL OR btrim(github_login) <> '');

CREATE UNIQUE INDEX users_github_login_unique
  ON users (lower(github_login))
  WHERE github_login IS NOT NULL;
