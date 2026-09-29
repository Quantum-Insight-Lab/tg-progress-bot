-- CI зеркала: default_branch_ci у репозитория, ci_status и даты у pull request.
-- Пустой статус — CI ещё неизвестен. Иное завершение workflow сюда не входит: оно сворачивается в other.
-- updated_at — дата факта pull request. merged_at и merged_by_login пусты, пока PR не смержен.
-- Проекта и задачи в этих полях нет.

ALTER TABLE repositories
  ADD COLUMN default_branch_ci text,
  ADD CONSTRAINT repositories_default_branch_ci CHECK (
    default_branch_ci IS NULL
    OR default_branch_ci IN ('success', 'failure', 'cancelled', 'other')
  );

ALTER TABLE pull_requests
  ADD COLUMN ci_status text,
  ADD COLUMN updated_at timestamptz NOT NULL,
  ADD COLUMN merged_at timestamptz,
  ADD COLUMN merged_by_login text,
  ADD CONSTRAINT pull_requests_ci_status CHECK (
    ci_status IS NULL OR ci_status IN ('success', 'failure', 'cancelled', 'other')
  ),
  ADD CONSTRAINT pull_requests_merged_by_login CHECK (
    merged_by_login IS NULL OR length(btrim(merged_by_login)) > 0
  ),
  ADD CONSTRAINT pull_requests_merged_fields CHECK (
    state = 'merged' OR (merged_at IS NULL AND merged_by_login IS NULL)
  );
