> Event Registry (PDA шаг 6, 5.5; патч 1.2 — 9.4; патч 1.3 — `realizes`). Каталог событий живёт в репозитории как данные, а не в документе как текст.

# События

Источник правды — [`contracts/event-registry.yaml`](../../contracts/event-registry.yaml). Этот файл объясняет правила и показывает картину целиком; при расхождении прав реестр.

## Правила

1. **Типы генерируются из реестра.** Когда появится код, скрипт соберёт типы и схемы валидации; ручное объявление типа события — ошибка сборки (S-3).
2. **Строковых литералов в публикации нет.** Событие публикуется сгенерированной константой, а не строкой.
3. **Новое событие — отдельный коммит**, не смешанный с реализацией фичи.
4. **Схема существующего события не правится.** Изменение — только `version + 1`: в журнале лежат факты прошлой версии, обработчик читает все живые версии.
5. **У события есть инварианты, атомы и проекции.** `invariants` — INV из [04](04-invariants.md), `realizes` — атомы ТЗ, которые событие реализует, `projections` — проекции из [07](07-architecture.md), которые оно перерисовывает. `next` — события-следствия из шаблона Event Card: `project.member_removed` ведёт к `task.cancelled`, `blocker.detected` — к `blocker.declared` или `blocker.dismissed`. Правка канваса (A-31) следует за любым событием, меняющим его содержимое, и в `next` не повторяется. `tz-check` проверяет, что INV, проекции и следствия существуют, атомы живы, а каждое событие из таблицы актов ([02](02-certainty-acts.md)) есть в реестре.
6. **У каждого события — ключ идемпотентности** (INV-22): доставка GitHub, `callback_query_id`, `update_id` Telegram или естественный ключ «проект + дата» для действий системы.

## Конверт

Единый для всех событий, поля из PDA 4.4. Без трёх полей журнал бесполезен:

- `causation_id` — какое событие вызвало это: «почему задача в `BLOCKED`» отвечается одним запросом;
- `correlation_id` — сквозной идентификатор цепочки: нажатие, переход задачи, правка канваса;
- `idempotency_key` — единственная защита от двойного применения факта.

## Карта событий

| Событие | Контекст | Кто инициирует | Что меняет | Акт |
| --- | --- | --- | --- | --- |
| `task.created` | tasks | исполнитель | новая задача в «Задачах» | A-1 |
| `task.checked`, `task.unchecked` | tasks | исполнитель | задача входит в `REVIEW` и выходит из него | A-2, A-3 |
| `task.confirmed`, `task.returned` | tasks | руководитель | `DONE` или возврат в работу | A-4, A-5 |
| `task.planned`, `task.resumed` | tasks | исполнитель | задача уходит в план и возвращается | A-6, A-7 |
| `task.prioritized` | tasks | исполнитель | приоритет и порядок плана | A-8 |
| `task.cancelled` | tasks | исполнитель, руководитель, система | задача уходит с канваса | A-9, A-25 |
| `blocker.detected`, `blocker.declared`, `blocker.dismissed` | tasks | система, исполнитель | блокер, его причина и снятие | A-28, A-10, A-11 |
| `review.reminded` | tasks | система | напоминание руководителям | A-29 |
| `canvas.posted`, `canvas.edited`, `canvas.full`, `canvas.carried_over` | tasks | система | сообщение канваса, перенос дня | A-30, A-31 |
| `divergence.detected` | tasks | система | строка расхождения за сутки | A-36 |
| `user.registered`, `user.github_login_set` | projects | пользователь | аккаунт, корень, логин GitHub | A-13, A-23 |
| `project.created`, `project.chat_bound`, `project.repository_connected`, `project.repository_changed`, `project.settings_changed` | projects | корень, руководитель | проект и его настройки | A-14…A-17, A-24 |
| `project.member_added`, `project.member_removed`, `member.topic_set` | projects | корень | состав и топики | A-21, A-22, A-25 |
| `chat.reports_topic_set`, `chat.schedule_set`, `chat.schedule_cleared` | projects | руководитель, корень | командный топик и расписание | A-18…A-20 |
| `access.denied` | projects | система | отказ постороннему | A-34 |
| `github.issue_changed`, `github.pull_request_changed`, `github.commits_pushed`, `github.workflow_completed`, `github.milestone_changed`, `github.issue_links_changed` | github | GitHub | зеркало | A-26, A-27 |
| `github.reconciled`, `repo.pr_stalled` | github | система | сверка зеркала, застрявший PR | A-35 |
| `progress.snapshot_taken` | progress | система | суточная доля | A-32 |
| `report.sent` | projects | система, пользователь | отчёт в личку или в командный топик | A-12, A-33 |

Поле `projections` в реестре — какие проекции ([07](07-architecture.md)) перерисовывает событие.
