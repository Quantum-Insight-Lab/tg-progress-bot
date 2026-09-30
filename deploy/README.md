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
