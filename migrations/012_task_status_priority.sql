-- Статусы и приоритеты задачи (E-5). Перечень — constraint, не проверка в хендлере.
-- BLOCKED — дни в списке без галочки задаёт STALE_DAYS (C-1), не эта схема.
-- Ключ таблицы — id (колонка уже есть).

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status CHECK (
    status IN ('PLANNED', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE', 'CANCELLED')
  ),
  ADD CONSTRAINT tasks_priority CHECK (
    priority IN ('high', 'normal', 'low')
  );
