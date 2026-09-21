> Domain Graph Canvas (PDA 5.2). Отношения первичны: таблицы и API — реализация графа, а не его источник.

# Граф домена

## Контексты

| Контекст | Что внутри | Чем владеет | Роль |
| --- | --- | --- | --- |
| `projects` | Project, Stage, User, ProjectMember | конфигурация проекта, состав участников, права | ядро |
| `tasks` | Task, TaskList, TaskListItem, Blocker | работа и её состояние — то, ради чего продукт существует | ядро |
| `github` | Issue, PullRequest, CheckRun | зеркало внешних фактов, только чтение | интеграция |
| `progress` | ProgressSnapshot и расчёт процента | производные величины | проекция |
| `reports` | ReportTarget, сборка отчётов | доставка | проекция |

Ядро (`projects`, `tasks`) содержит законы. `progress` и `reports` ничего не решают: они читают и показывают. `github` не имеет права писать во внешний мир.

## Часть A: сущности

| Сущность | Описание | Ключевые поля | ID / ключ | Контекст | Источник |
| --- | --- | --- | --- | --- | --- |
| Project | единица, по которой считается прогресс и шлются отчёты | `name`, `repository`, `timezone`, `telegram_chat_id` | `id` | `projects` | бот |
| Stage | этап проекта | `name`, `order`, `status`, `due_on` | `id`; природный `project_id + milestone_number` | `projects` | зеркало GitHub milestone |
| User | человек, известный системе в двух мирах | `telegram_user_id`, `github_login` | `id`; уникальны оба внешних ключа | `projects` | бот |
| ProjectMember | участие человека в проекте с ролью | `role`, `topic_id` | `id`; уникально `project_id + user_id` | `projects` | бот |
| Task | шаг работы, который ведёт человек | `title`, `status`, `priority`, `progress` | `id` | `tasks` | бот |
| TaskList | список задач на дату | `list_date`, `topic_id`, `message_id` | `id`; уникально `project_id + list_date` | `tasks` | бот |
| TaskListItem | пункт списка, ссылающийся на задачу | `position`, `is_done`, `carried_from_list_id` | `id` | `tasks` | бот |
| Blocker | причина остановки или факт застоя | `source`, `signal_type`, `reason`, `impact`, `required_action` | `id` | `tasks` | бот + сигналы GitHub |
| Issue | границы работы в GitHub | `issue_number`, `title`, `state`, `assignee`, `milestone` | `id`; природный `project_id + issue_number` | `github` | зеркало |
| PullRequest | техническая реализация issue | `pull_request_number`, `state`, `merged_at` | `id` | `github` | зеркало |
| CheckRun | состояние CI по PR | `status`, `conclusion`, `completed_at` | `id` | `github` | зеркало |
| ProgressSnapshot | значение прогресса на момент времени | `progress`, `created_at` | `id` | `progress` | расчёт |
| ReportTarget | куда и когда доставлять отчёт | `chat_id`, `topic_id`, `report_type`, `schedule_cron` | `id` | `reports` | бот |
| Event | факт в журнале, append-only | `event_type`, `payload`, `idempotency_key` | `id` | ядро | все контексты |

Зеркальные сущности (Issue, PullRequest, CheckRun, Stage) имеют два ключа: свой `id` и природный ключ из GitHub. Природный ключ нужен для дедупликации при повторной доставке webhook, `id` — для ссылок внутри домена.

## Часть B: связи

| Связь | От | К | Тип | Смысл и правило | Ключевые события |
| --- | --- | --- | --- | --- | --- |
| `belongs_to` | Task | Project | N:1 | задача существует только внутри проекта; проект не меняется за время жизни задачи | `task.created` |
| `references` | Task | Issue | N:1 | обязательна: issue задаёт границы работы, задач у одного issue может быть несколько | `task.created` |
| `assigned_to` | Task | User | N:1 | обязательна: задача без исполнителя не существует, ему адресуется вопрос о блокере | `task.created`, `task.reassigned` |
| `listed_in` | Task | TaskList | N:M через TaskListItem | задача может появляться в списках нескольких дней подряд, но незакрытый пункт у неё один | `task.created`, `task.carried_over` |
| `raised_on` | Blocker | Task | N:1 | блокер живёт на задаче, а не на issue: остановился конкретный шаг | `blocker.detected`, `blocker.declared` |
| `belongs_to` | Issue | Stage | N:1, необязательна | этап issue — его milestone; без milestone issue попадает в «Без этапа» | `github.issue_updated` |
| `belongs_to` | Stage | Project | N:1 | один milestone может быть этапом в нескольких проектах репозитория | `github.milestone_updated` |
| `depends_on` | Issue | Issue | N:M | зеркало связей `blocked by` и sub-issues; задаёт порядок в плане и «Влияние» блокера | `github.issue_linked` |
| `implements` | PullRequest | Issue | N:1 | PR привязан к issue ссылкой в GitHub, не к задаче | `github.pull_request_updated` |
| `reports_on` | CheckRun | PullRequest | N:1 | красный CI по открытому PR — факт застоя | `github.checks_failed` |
| `member_of` | User | Project | N:M через ProjectMember | членство определяет и доступ, и ветку для задач | `project.member_added` |
| `measures` | ProgressSnapshot | Project | N:1 | снимок принадлежит проекту; общий процент по всем проектам считается на лету, не хранится | `progress.snapshot_taken` |
| `delivers` | ReportTarget | Project | N:1 | ветка отчётов может не совпадать с ветками задач участников | `report.sent` |

## Правила графа

1. **Задача — центр домена.** Все вопросы продукта («что делаю», «что стоит», «что сделано») отвечаются через Task, а не через Issue. Issue — это контекст задачи, а не её замена.
2. **Блокер висит на задаче, влияние считается по issue.** Остановка касается шага, а последствия — продуктовой единицы, поэтому «кто кого ждёт» берётся из связей issues.
3. **Зеркало не редактируется.** Запись в `github`-контекст возможна только из GitHub Adapter и только из данных webhook или API-ответа. Никакой код домена не создаёт и не меняет Issue, PullRequest, CheckRun (INV-09, S-2).
4. **Прогресс не является сущностью домена.** Это функция от задач (см. [04](04-invariants.md), INV-10). В базе хранятся только снимки, чтобы строить динамику.
5. **Расширение графа — отдельное решение.** Новая сущность, связь или переход статуса начинается с правки этого файла; агент, упёршийся в нехватку связи, останавливается и спрашивает (`AGENTS.md`).
