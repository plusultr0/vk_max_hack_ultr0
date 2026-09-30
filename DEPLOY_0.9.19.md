# Обновление 0.9.18 → 0.9.19 на существующем сервере

Патч `max-regulatory-control-0.9.19-server-patch-no-env.zip` рассчитан на исходники 0.9.18 и распаковывается непосредственно в корень существующего проекта. В нём нет `.env`. Для другой исходной версии используйте полный проект, предварительно сохранив рабочий `.env` и данные БД; не создавайте новый Compose-проект с новым volume.

## 1. Перед распаковкой

Загрузите ZIP в домашнюю папку сервера. В SSH:

```bash
set -e
cd ~/vk_max_hack_ultr0-main
umask 077
BACKUP="$HOME/max-regulatory-before-0.9.19-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp .env "$BACKUP/.env"
sha256sum .env > "$BACKUP/env.sha256"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$BACKUP/database.sql"
test -s "$BACKUP/database.sql"
printf 'Backup: %s\n' "$BACKUP"
```

Если pg_dump завершился ошибкой, не продолжайте обновление до получения резервной копии. Файл содержит данные бизнеса; храните его закрыто.

## 2. Патч и пересборка

```bash
unzip -o ~/max-regulatory-control-0.9.19-server-patch-no-env.zip -d ~/vk_max_hack_ultr0-main
cd ~/vk_max_hack_ultr0-main
sha256sum -c "$BACKUP/env.sha256"
node scripts/verify-manifest.mjs
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 migrate api worker bot
```

Существующий Compose запускает migrate, затем seed и приложение. Миграция `013_action_checks_and_history.sql` добавочная; старые ответы не удаляет. После миграции выполняется осторожное согласование старых action-отметок с текущими действиями. Неподходящие старые основания остаются историей.

`migrate` и `seed` должны завершиться с кодом 0. Остальные сервисы должны работать. Не добавляйте `-v` к остановке рабочего Compose; для этого обновления `down` не требуется.

## 3. Проверить результат

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3001/health
```

В MAX пройти:
1. Действие выполнено в карточке → та же отметка в документах → снять отметку из документов → действие снова открыто.
2. Оставить Mini App открытым, отметить действие через бота, вернуться в Mini App без ручной перезагрузки.
3. Открыть карточку из ленты изменений; проверить, что актуальная карточка не показана предыдущим результатом.
4. Изменить профиль и проверить возврат в «Требуют внимания», сохранность дополнительных сведений и историю «было → стало».

## Изолированные расширенные тесты

Новый `Dockerfile.acceptance` тяжелее production-образа из-за Chromium/Python. Он нужен только для тестов. При наличии ресурсов стенда:

```bash
docker compose --env-file .env.test.example -p max-regcontrol-tests -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose --env-file .env.test.example -p max-regcontrol-tests -f compose.test.yaml down
```

Тестовый стек не использует production `.env` и production volume; БД существует в tmpfs. Проверка включает typecheck/Vitest/build, offline-группы, PostgreSQL integrations и настоящие React UI contracts с синтетическим API. Успех здесь не заменяет живой MAX/GigaChat проход.

## При ошибке миграции или запуска

Сохраните логи и резервную копию. Не удаляйте volume и не запускайте integration scripts с рабочим DATABASE_URL. Отдельный `.env` не заменяйте шаблоном `.env.example`. Не восстанавливайте старую БД поверх новой автоматически: это может уничтожить новые ответы, появившиеся после обновления.
