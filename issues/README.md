# Каталог issues

Скачано из GitHub (`gh issue list`). Номера и Blocked by — как в репозитории.

| # | Milestone | Title | Labels | Blocked by |
| --- | --- | --- | --- | --- |
| [01](01.md) | M0 Foundation | chore: каркас TypeScript / Node 22 и зависимости одним коммитом | `context:infra`, `type:chore` | — |
| [02](02.md) | M0 Foundation | ci: границы слоёв и контекстов, codegen событий, запрет Date в домене | `layer:ci`, `type:chore` | [#1](01.md) |
| [03](03.md) | M0 Foundation | feat: единственные механизмы config, clock, logger, db pool, DomainError | `context:infra`, `layer:domain`, `type:feat` | [#1](01.md) |
| [04](04.md) | M1 Event Core | feat: журнал событий emit + UNIQUE idempotency_key, только append | `layer:events`, `type:feat` | [#2](02.md), [#3](03.md) |
| [05](05.md) | M1 Event Core | feat: миграции таблиц и constraint’ы домена | `context:infra`, `type:feat` | [#3](03.md) |
| [06](06.md) | M1 Event Core | ci: сверка INV-xx в тестах со спекой (S-7) и запрет магических чисел в domain (S-8) | `layer:ci`, `type:chore` | [#2](02.md), [#4](04.md) |
| [07](07.md) | M2 Domain | feat: контекст projects — участники, роли, factory guard | `context:projects`, `layer:domain`, `type:feat` | [#4](04.md), [#5](05.md) |
| [08](08.md) | M2 Domain | feat: контекст tasks — создание, приоритет, исполнитель, переходы статуса | `context:tasks`, `layer:domain`, `type:feat` | [#7](07.md) |
| [09](09.md) | M2 Domain | feat: REVIEW / DONE / BLOCKED — lead-only, блокеры, симметрия | `context:tasks`, `layer:domain`, `type:feat` | [#8](08.md) |
| [10](10.md) | M3 Telegram | feat: grammY-бот, регистрация хендлеров только через factory с guard | `context:projects`, `layer:telegram`, `type:feat` | [#7](07.md), [#2](02.md) |
| [11](11.md) | M3 Telegram | feat: список дня — создать задачу, галочка, один список на дату | `context:tasks`, `layer:telegram`, `type:feat` | [#8](08.md), [#10](10.md) |
| [12](12.md) | M3 Telegram | feat: перенос незакрытых пунктов на новый день | `context:tasks`, `layer:telegram`, `type:feat` | [#11](11.md) |
| [13](13.md) | M3 Telegram | feat: отложить в план, приоритет, переназначение, отмена, подтверждение lead | `context:tasks`, `layer:telegram`, `type:feat` | [#9](09.md), [#11](11.md) |
| [14](14.md) | M4 GitHub | feat: GitHub App webhook — подпись, delivery_id, зеркало issue/PR/checks/milestone | `context:github`, `type:feat` | [#4](04.md), [#5](05.md) |
| [15](15.md) | M4 GitHub | feat: опрос-сверка пропущенного по C-6 | `context:github`, `type:feat` | [#14](14.md) |
| [16](16.md) | M5 Progress and UX | feat: расчёт прогресса по задачам проекта и снимок | `context:progress`, `layer:domain`, `type:feat` | [#8](08.md) |
| [17](17.md) | M5 Progress and UX | feat: проекции экранов и карточка на проект | `layer:projections`, `layer:telegram`, `type:feat` | [#13](13.md), [#14](14.md), [#16](16.md) |
| [18](18.md) | M5 Progress and UX | ci: madge circular, knip warning, проекции не пишут в events (S-5, S-6, S-9) | `layer:ci`, `type:chore` | [#17](17.md) |
| [19](19.md) | M6 Close the loop | feat: застой STALE_DAYS, вопрос исполнителю, declare/dismiss | `context:tasks`, `layer:telegram`, `type:feat` | [#12](12.md), [#15](15.md), [#9](09.md) |
| [20](20.md) | M6 Close the loop | feat: экран Блокеры | `layer:projections`, `layer:telegram`, `type:feat` | [#19](19.md), [#17](17.md) |
| [21](21.md) | M6 Close the loop | feat: ежедневный отчёт в личку и в topic по cron | `context:reports`, `type:feat` | [#16](16.md), [#19](19.md) |
| [22](22.md) | M6 Close the loop | feat: метрики устойчивости и деградация без GitHub | `context:infra`, `type:feat` | [#21](21.md) |
| [23](23.md) | M3 Telegram | feat: выбор issue из зеркала в диалоге создания задачи | `context:github`, `layer:telegram`, `type:feat` | [#11](11.md), [#14](14.md) |
