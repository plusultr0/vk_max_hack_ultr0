# S1 validation report

Дата: 16.09.2026

## Реализовано

- `packages/max`: HMAC validation, session signing, MAX HTTP API client.
- `POST /auth/max` и `GET /auth/me`.
- dev auth для работы без bot token.
- миграция `002_max_auth.sql`.
- MAX Bridge в web shell.
- bot webhook `/webhook` + `/health`.
- webhook secret validation.
- script регистрации subscription.
- `platform-api2.max.ru` как актуальный API host.
- Docker/env обновлены под API + bot.

## Проверено по актуальной документации MAX

1. WebAppData валидируется HMAC-SHA256 на сервере.
2. `auth_date` приходит в Unix seconds.
3. `initDataUnsafe` не используется для доверенной авторизации.
4. MAX Bridge доступен как `window.WebApp` после CDN `max-web-app.js`.
5. Актуальный API domain: `platform-api2.max.ru`.
6. Для production рекомендуется Webhook, Long Polling не используется.
7. Webhook URL должен быть HTTPS; self-signed HTTP flow не закладывается.
8. Webhook может передавать `X-Max-Bot-Api-Secret`.
9. Mini-app URL привязывается к bot в настройках платформы.
10. Deep link: `https://max.ru/<botName>?startapp=<payload>`.

## Что не удалось физически проверить в этой среде

- `npm install` не завершился: доступ к npm registry в runtime недоступен/зависает;
- поэтому TypeScript/Vitest/Vite full build здесь не запускался;
- Docker CLI в текущем runtime ранее отсутствовал;
- реального `MAX_BOT_TOKEN` и публичного HTTPS endpoint в сессии нет, поэтому настоящий webhook/auth handshake с MAX не выполнялся.

## Что проверить на машине команды

```bash
npm install
npm test
npm run build:web
cp .env.example .env
docker compose up --build
```

Без MAX token проверить browser dev-auth. После получения token — отключить dev auth и пройти:

```text
bot_started -> welcome -> mini-app -> WebAppData -> /auth/max -> /auth/me
```

## Acceptance S1

S1 считается закрытым после реального smoke-test в MAX:

- [ ] bot token установлен server-side;
- [ ] mini-app URL привязан к bot;
- [ ] HTTPS webhook опубликован;
- [ ] subscription зарегистрирована;
- [ ] bot_started приходит на webhook;
- [ ] mini-app получает WebAppData;
- [ ] `/auth/max` возвращает authenticated MAX user;
- [ ] испорченный initData получает 401;
- [ ] `/auth/me` принимает session bearer token;
- [ ] mobile MAX и web/desktop MAX открывают один и тот же account.
