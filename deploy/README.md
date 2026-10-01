# Развёртывание

Один хост, `docker compose` из каталога репозитория. Секреты — только в `.env` на хосте, он в `.gitignore`; `.env.example` — те же ключи без значений. Других файлов вне git не нужно. `docker-compose.override.yml` с прошлого развёртывания удалить: порт `app` теперь открывает сам compose.

## Вариант TLS

Выбирается строкой `COMPOSE_PROFILES` в `.env`.

| Вариант | `.env` | Что поднимается |
| --- | --- | --- |
| Caddy в compose | `COMPOSE_PROFILES=caddy` | Caddy держит 80 и 443, сертификат на `PUBLIC_HOST` выпускает сам (`deploy/Caddyfile`) |
| Внешний прокси | `COMPOSE_PROFILES=` | Caddy не поднимается, 80 и 443 держит прокси хоста |

В обоих вариантах `app` публикует порт только на `127.0.0.1:${APP_HOST_PORT}`, по умолчанию 8088: снаружи хоста его не видно.

Внешний прокси на nginx:

1. Сертификат: `sudo certbot certonly --nginx -d <PUBLIC_HOST>`.
2. `sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/tg-bot.conf`, в копии заменить `bot.example.com` на `PUBLIC_HOST`, а `8088` — на `APP_HOST_PORT`, если он другой.
3. `sudo nginx -t && sudo systemctl reload nginx`.

Пример ведёт на `app` только `/telegram/webhook` и `/github/webhook`, остальные пути — 404, как в `deploy/Caddyfile`. Доставке GitHub разрешено тело до 25 МБ.

## Первый запуск

```sh
cp .env.example .env                        # заполнить пустые поля, выбрать вариант TLS
docker compose build
docker compose up -d                        # postgres → migrate → app, caddy — в профиле
docker compose ps -a                        # migrate — Exited (0), остальные — Up
docker compose run --rm register-webhooks   # когда PUBLIC_HOST уже отвечает по HTTPS
```

`register-webhooks` запускается из того же образа с окружением из `.env`, Node на хосте не нужен. Он вызывает `setWebhook` бота и печатает оба адреса. Webhook GitHub App ставит человек: URL — второй адрес, секрет — `GITHUB_WEBHOOK_SECRET`. Бот в GitHub не пишет.

## Обновление, остановка, перезапуск

```sh
git pull
docker compose build
docker compose up -d                        # migrate применяет новые миграции, app пересоздаётся
```

- `docker compose down`, затем `docker compose up -d` — журнал на месте: данные Postgres в именованном томе `<проект>_pgdata`, `down` его не удаляет. Имя проекта — имя каталога; переименованный каталог получит новый пустой том.
- `docker compose down -v` и `docker volume rm` удаляют журнал. Вернуть его можно только из копии.
- У `postgres`, `app` и `caddy` стоит `restart: unless-stopped`: после падения процесса и перезагрузки хоста они поднимаются сами, если Docker стартует вместе с хостом (`systemctl is-enabled docker`). После `docker compose stop` сервисы поднимает только `docker compose up -d`. `migrate` не перезапускается: это шаг `up`.
- Логи: драйвер `json-file`, `max-size: 10m`, `max-file: 5` у каждого сервиса, не больше 50 МБ на контейнер. Смотреть — `docker compose logs -f app`.

## Копия журнала

Решение владельца 30.09: `pg_dump` по расписанию хоста, раз в сутки в 03:00 по часам хоста, 7 последних копий в `/var/backups/tg-bot`. В compose для этого ничего нет.

Копия спасает от `down -v`, удаления тома и порчи базы. Теряется то, что записано после последней копии. Копия лежит на том же диске и от потери диска не спасает; вынос её с хоста — отдельное решение.

```sh
sudo install -d -m 700 /var/backups/tg-bot
sudo crontab -e
```

Строка crontab, `/opt/tg-bot` — каталог репозитория на хосте:

```
0 3 * * * cd /opt/tg-bot && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /var/backups/tg-bot/.partial && mv /var/backups/tg-bot/.partial /var/backups/tg-bot/journal-$(date +\%F).dump && ls -1 /var/backups/tg-bot/journal-*.dump | sort -r | tail -n +8 | xargs -r rm --
```

Неудачный `pg_dump` прошлые копии не трогает: файл получает имя и старые копии удаляются только после успешной выгрузки.

Проверить, что копии делаются:

```sh
sudo ls -l /var/backups/tg-bot              # не больше 7 файлов, последний — за сегодня
sudo cat /var/backups/tg-bot/journal-ГГГГ-ММ-ДД.dump | docker compose exec -T postgres pg_restore -l | grep 'TABLE DATA public events'
```

## Восстановление из копии

Роль `journal_app` принадлежит кластеру Postgres, а не базе, и в `pg_dump` не попадает: третий шаг создаёт её, если тома не было. Права журнала — только `SELECT` и `INSERT` — приходят из копии. `psql` идёт по TCP (`-h 127.0.0.1`): на пустом томе образ сначала поднимает временный сервер только на сокете.

```sh
docker compose stop app
docker compose up -d --wait postgres
docker compose exec -T postgres sh -c 'psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -v db="$POSTGRES_DB"' <<'SQL'
DROP DATABASE IF EXISTS :"db";
CREATE DATABASE :"db";
SELECT 'CREATE ROLE journal_app NOLOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'journal_app') \gexec
SQL
sudo cat /var/backups/tg-bot/journal-ГГГГ-ММ-ДД.dump | docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error'
docker compose up -d
```

`migrate` после восстановления применяет только миграции новее копии.

## Переход с безымянного тома

До этой версии compose данные Postgres лежали в безымянном томе, и новый `up` поднимет пустую базу. Один раз, до `git pull`:

```sh
sudo install -d -m 700 /var/backups/tg-bot
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' | sudo tee /var/backups/tg-bot/before-pgdata.dump > /dev/null
docker compose down                         # безымянный том остаётся
git pull
rm -f docker-compose.override.yml
```

В `.env` дописать `COMPOSE_PROFILES=` и `APP_HOST_PORT=8088`, собрать образ и пройти «Восстановление из копии» с файлом `before-pgdata.dump`. Безымянный том удалить после проверки, что журнал на месте.

## Проверка после сборки

Каждый шаг — команда и ожидаемый результат. Шаги без людей собирает `npm run smoke`: из образа это `docker compose run --rm --no-deps smoke` (профиль `tools`, Node на хосте не нужен). Итог — одна строка `smoke: ok 5/5` и код выхода 0. Иначе `smoke: fail N/5 — …` и код 1: в строке имена проверок, без секретов и без текстов ответов.

`app` к этому моменту уже поднят. `--no-deps` не стартует остановленный стек. Smoke только читает: два `POST` без секрета, `getWebhookInfo`, `GET /healthz`. В журнал ничего не пишется. В логе от этих запросов ожидаемы `http.request` и `github.signature_invalid`.

1. Сборка зелёная, образ собран, миграции применены.

```sh
npm run ci                                   # код выхода 0
docker compose build                         # код выхода 0
docker compose up -d
docker compose logs migrate                  # имена файлов миграций или строка «миграции уже применены»
```

2. `app` жив, строка старта без секретов. `docker compose ps` показывает `app` как `healthy`: healthcheck раз в 30 с ходит на `GET /healthz` внутри контейнера. `200` и пустое тело — процесс жив и `SELECT 1` проходит, иначе `503`. Каждый такой запрос пишет `http.request` (B-17).

```sh
docker compose logs app | grep '"step":"process.started"'
```

В строке — порт, хост, пути webhook, `healthPath` `/healthz`, интервалы. Токена, секрета webhook и ключа GitHub App в ней нет.

3. `PUBLIC_HOST` отвечает по HTTPS сертификатом своего имени. `curl` проверяет имя сертификата сам; `ssl_verify_result` — 0, код — 404 (остальные пути прокси закрывает).

```sh
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' "https://$PUBLIC_HOST/"
```

4. `getWebhookInfo`: адрес — `PUBLIC_WEBHOOK_ORIGIN` + `TELEGRAM_WEBHOOK_PATH`, `pending_update_count` за 2 секунды не вырос. Токен остаётся в окружении контейнера и в команду не подставляется. `last_error_message` в критерий не входит: Telegram хранит текст последней ошибки и не стирает его после успешной доставки.

```sh
docker compose exec -T app node -e 'fetch("https://api.telegram.org/bot"+process.env.TELEGRAM_BOT_TOKEN+"/getWebhookInfo").then(async(r)=>{if(!r.ok){console.log("getWebhookInfo: HTTP "+r.status);return}const w=(await r.json()).result||{};console.log(w.url||"");console.log(w.pending_update_count)}).catch(()=>console.log("getWebhookInfo: нет ответа"))'
sleep 2
docker compose exec -T app node -e 'fetch("https://api.telegram.org/bot"+process.env.TELEGRAM_BOT_TOKEN+"/getWebhookInfo").then(async(r)=>{if(!r.ok){console.log("getWebhookInfo: HTTP "+r.status);return}const w=(await r.json()).result||{};console.log(w.url||"");console.log(w.pending_update_count)}).catch(()=>console.log("getWebhookInfo: нет ответа"))'
```

Ожидание: первая строка совпадает с адресом webhook Telegram, число во втором запуске не больше первого.

5. Ping GitHub App — кнопка в настройках App, бот в GitHub не пишет. Ожидание: доставка `2xx`. В логе строка `github.delivery`.

```sh
docker compose logs app --since 5m | grep '"step":"github.delivery"'
```

6. `/start` в личке корня. Ожидание: ответ бота. В логе по одному `updateId` — `telegram.update`, `telegram.guard` (`decision` — `allow`, `basis` — `start`), `telegram.outcome` (`handler` — `start`, `outcome` — `replied`). Первый `/start` этого аккаунта между guard и ответом пишет `event.recorded` с `eventType` `user.registered`. Повтор того же аккаунта событие не пишет.

```sh
docker compose logs app --since 5m | grep -E '"step":"telegram.update"|"step":"telegram.guard"|"step":"event.recorded"|"step":"telegram.outcome"'
```

7. Ход планировщика и сверки. `scheduler.run` появляется спустя `SCHEDULER_INTERVAL_MS` после старта (по умолчанию 60 с): первый ход не в момент старта. Если в `process.started` поле `githubApp` — `true`, сразу есть `reconcile.started`, а `reconcile.finished` — когда проход сверки закончился. Если `githubApp` — `false`, строк сверки нет: опрос выключен.

```sh
docker compose logs app --since 2m | grep '"step":"scheduler.run"'
docker compose logs app --since 20m | grep -E '"step":"reconcile.started"|"step":"reconcile.finished"'
```

Адрес здоровья снаружи не открыт: `GET /healthz` на `PUBLIC_HOST` — 404, внутри сети compose `GET http://app:8080/healthz` — 200 и пустое тело. Эти две проверки, TLS, оба `POST` без секрета (`401`) и `getWebhookInfo` — пять шагов smoke.

```sh
docker compose run --rm --no-deps smoke       # smoke: ok 5/5
```
