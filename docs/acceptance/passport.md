# Паспорт репозитория и развёртывания

Снимок характеристик одного коммита. Раздел не переписывается: следующий снимок — новый раздел со своим SHA.

Команды выполнены на `bca4480509058eaefd9ba0c3bca4b69fd58d1ac2` (`main`, 2026-10-01 02:44:22 +0000). Повтор: `git checkout bca4480509058eaefd9ba0c3bca4b69fd58d1ac2`, затем команда из колонки.

## bca4480 · 2026-10-01

### История и ветки

| Характеристика | Значение | Команда |
| --- | --- | --- |
| SHA | `bca4480509058eaefd9ba0c3bca4b69fd58d1ac2` | `git rev-parse HEAD` |
| Дата коммита | 2026-10-01 02:44:22 +0000 | `git log -1 --format=%ci` |
| Первый коммит | 2026-09-20 12:21:53 +0000, `ab61525` | `git log --reverse --format='%ci %h' \| head -1` |
| Коммиты с 2026-09-20 | 373 | `git rev-list --count --since='2026-09-20 00:00:00 +0000' HEAD` |
| Из них merge | 127 | `git rev-list --count --merges --since='2026-09-20 00:00:00 +0000' HEAD` |
| Ветка `main` | тот же SHA | `git ls-remote --heads origin refs/heads/main` |
| Ветки `dev`, `v2-from-spec` | на `origin` нет | `git ls-remote --heads origin refs/heads/dev refs/heads/v2-from-spec` |
| Issues | 123 всего, 119 закрыты, 4 открыты: #240, #241, #242, #243 | `gh issue list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --state all --limit 400 --json number,state` |
| Issues с номером меньше 64 | 30, все закрыты | тот же `gh issue list`, отбор `number < 64` |
| Issues #64…#146 | 83, все закрыты | тот же `gh issue list`, отбор `64 ≤ number ≤ 146` |

### ТЗ и трасса

Вывод `npm run tz:check -- --gate --pda` (290 мс, код 0).

| Характеристика | Значение | Команда |
| --- | --- | --- |
| Блоки с якорем | 496 из 496; разделов 48 из 48 | строка `TR-1` |
| Атомы | 962, следующий номер R-963 | строка `TR-2` |
| Релизы scope | mvp 47 · out 12 · later 14 | строка `TR-3` |
| Виды | scope 73 · entity 157 · integration 30 · rule 331 · tech 22 · view 228 · act 60 · reaction 54 · metric 7 | строка `REG` |
| Решения | same_as 151 · withdrawn 25 · clarify 1 · deferred 33 | строка `REG` |
| Открытый clarify | 1 — R-696, не блокирует MVP | хвост того же вывода |
| Атомы MVP со статусом «покрыт» (M-20) | 682/682 | строка `TR-7`: «покрытых атомов MVP в issues: 682/682»; строка `TR-4` — по видам все доли полные |
| Issues в backlog | 93, закрыто 83 | строка `TR-7` |
| Атомов в issue | до 10 при лимите 10 | строка `TR-8` |
| Gate D-1…D-6 | ok | строка `GATE` |

### PDA

| Характеристика | Значение | Команда |
| --- | --- | --- |
| Элементы | U 19 · A 45 · E 17 · L 18 · INV 28 · C 13 · B 17 · P 19 · M 28 · S 10 · EV 51 | строка `TR-5` того же `tz:check` |
| Ссылки элементов на атомы | 898 | строка `TR-5` |
| Доля `derived` (M-22) | 55/265 | разбор тех же элементов, команда ниже |
| Покрытие инвариантов тестами (M-13) | 28/28 | `npm run check:invariants -- --strict` → `инвариантов в спеке 28, с тестом 28` (132 мс, код 0) |
| Дрейф реестра событий (M-14) | 0 | `npm run codegen:events -- --check`, код 0, расхождения нет |
| Падения CI на границах S-1, S-2, S-5, S-6 (M-27) | 0 | workflow `CI`, 329 запусков: 322 success, 7 failure; ни один failure не на шаге `boundaries (S-1, S-2, S-5, S-6)` |
| Повтор механизма из реестра (M-28) | 0 | `npm run check:mechanisms` → `механизмы из AGENTS.md сходятся с одним файлом` (149 мс, код 0) |

M-22. Префиксы совпадают со строкой `TR-5` (265 элементов). `derived` — поле разбора `tz:check`, не отдельная строка отчёта:

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning -e "
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePdaElements, parseEventRegistry, EVENT_REGISTRY_PATH, PDA_DIR } from './scripts/tz-check.ts';
const pda = readdirSync(PDA_DIR).filter((name) => name.endsWith('.md')).flatMap((name) => parsePdaElements({ file: join(PDA_DIR, name), text: readFileSync(join(PDA_DIR, name), 'utf8') }));
const all = [...pda, ...parseEventRegistry(readFileSync(EVENT_REGISTRY_PATH, 'utf8')).elements];
console.log('derived ' + all.filter((element) => element.derived).length + '/' + all.length);
"
```

M-27. Сводка заключений — страницы `gh api --paginate "/repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions/workflows/ci.yml/runs?per_page=100"`: 100+100+100+29 запусков, failure 0+5+2+0. У семи упавших запусков шаг с `conclusion=failure` — `Run npm test` (5), `Run npm run typecheck` (1), `Run npm run build` (1). Шаг `boundaries (S-1, S-2, S-5, S-6)` среди них не падал.

### Код и зависимости

| Характеристика | Значение | Команда |
| --- | --- | --- |
| Файлы `src` (`*.ts`) | 189 | `git ls-files \| grep -c '^src/.*\.ts$'` |
| Миграции | 24 | `git ls-files 'migrations/*' \| wc -l` |
| Модули и зависимости | 199 модулей, 879 зависимостей, нарушений нет | `npm run boundaries` (809 мс, код 0): `no dependency violations found (199 modules, 879 dependencies cruised)` |
| Зависимости процесса | grammy, kysely, octokit, pg, zod | `node -e "console.log(Object.keys(require('./package.json').dependencies).join(', '))"` |

### Проверки и их время

| Характеристика | Значение | Команда |
| --- | --- | --- |
| Файлы тестов | 96 | `git ls-files \| grep -c '^tests/.*\.test\.ts$'`; столько же записей `testResults` у vitest |
| Тесты | 785 пройдено, 0 упало | `npm test -- --reporter=json --outputFile=/tmp/vitest.json` → `numPassedTests` / `numTotalTests` |
| Время прогона vitest | 163625 мс | внешний замер той же команды, код 0 |
| Файлы тестов с PGlite | 58 | `git grep -l PGlite -- 'tests/*.test.ts' \| wc -l` |
| Самый долгий тест | 4041 мс, файл импортирует PGlite | максимум `assertionResults[].duration` того же JSON |
| `npm audit` | 2 moderate, обе в dev-зависимости vitest (`vitest`, `@vitest/mocker`), код 1 | `npm audit` (366 мс) |
| `npm audit --omit=dev` | 0 | `npm audit --omit=dev` (312 мс, код 0) |
| `npm run ci` | 177566 мс, код 0, замер 2026-10-01 | `npm run ci` на коде этого SHA: typecheck, lint, boundaries, codegen, инварианты, механизмы, knip, test, tz:check |

### Образ и развёртывание

Образ собран на этом SHA: `docker build -t passport-snapshot:bca4480 .` (18628 мс, код 0). Живой адрес хоста в git не хранится: его задают `PUBLIC_HOST` и `PUBLIC_WEBHOOK_ORIGIN`.

| Характеристика | Значение | Команда |
| --- | --- | --- |
| База образа | `node:22-bookworm-slim`, `NODE_VERSION=22.23.3` | `docker image inspect node:22-bookworm-slim` |
| Пользователь процесса | `node` | `docker image inspect passport-snapshot:bca4480 --format '{{.Config.User}}'` |
| Команда процесса | `node --experimental-strip-types --disable-warning=ExperimentalWarning src/main.ts` | `docker image inspect` → `Config.Cmd` |
| Postgres | `postgres:16`, `PG_MAJOR=16`, `PG_VERSION=16.15-1.pgdg13+2` | `docker image inspect postgres:16` |
| Уязвимости в образе | 0 | `docker run --rm --entrypoint npm passport-snapshot:bca4480 audit --omit=dev` |

Имена переменных окружения из `.env.example`, без значений (`grep -E '^[A-Z0-9_]+=' .env.example | cut -d= -f1`):

`DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PORT`, `HOST`, `SCHEDULER_INTERVAL_MS`, `LOG_LEVEL`, `TELEGRAM_WEBHOOK_PATH`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `PUBLIC_WEBHOOK_ORIGIN`, `PUBLIC_HOST`, `COMPOSE_PROFILES`, `APP_HOST_PORT`. <!-- pragma: allowlist secret -->

Адреса webhook — один TLS-хост, пути разные:

| Путь | Значение | Команда |
| --- | --- | --- |
| Telegram | `/telegram/webhook` | `node --experimental-strip-types --disable-warning=ExperimentalWarning -e "import { TELEGRAM_WEBHOOK_PATH } from './src/telegram/webhook.ts'; console.log(TELEGRAM_WEBHOOK_PATH)"` |
| GitHub App | `/github/webhook` | та же форма для `GITHUB_WEBHOOK_PATH` из `src/github/webhook.ts` |

Полный URL — `PUBLIC_WEBHOOK_ORIGIN` плюс путь. `register-webhooks` вызывает `setWebhook` бота и печатает оба адреса. В GitHub бот не пишет.

Человек ставит руками: пустые секреты в `.env`; `PUBLIC_HOST`, `PUBLIC_WEBHOOK_ORIGIN` и `COMPOSE_PROFILES` (Caddy в compose или прокси хоста); сертификат и nginx, если профиль пустой; URL и секрет webhook GitHub App; расписание `pg_dump` на хосте. Описание шагов — `deploy/README.md`.
