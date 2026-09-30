# CHANGELOG 0.9.15 — complete MAX chatbot flows

Дата: 28.09.2026.

0.9.15 продолжает 0.9.14 без изменения seed-37 и без новой модели данных. Основная цель — сделать существующий `t106_hakaton_max_bot` полноценным быстрым интерфейсом продукта, а не только каналом welcome/notification.

## Chat scenarios

Добавлены команды `/start`, `/menu`, `/status`, `/requirements`, `/actions`, `/changes`, `/documents`, `/history`, `/profile`, `/help` и распознавание эквивалентных обычных русских фраз.

Бот использует реальные данные компании:

- подтверждение профиля перед персональными сценариями;
- текущий compliance baseline;
- применимые/неопределённые требования;
- открытые action items и сроки;
- персональную regulatory feed;
- checklist документов/настроек;
- сохранённую историю через Mini App.

Свободный текст не отправляется в LLM для юридического ответа. Тематические запросы вроде «что у меня по персональным данным?» ищутся только по уже рассчитанным персональным требованиям; при отсутствии совпадения бот возвращает безопасный fallback и меню.

## MAX-native interaction

- `open_app` используется вместо обычных ссылок там, где нужно открыть Mini App;
- callback navigation обновляет текущее сообщение;
- action можно отметить выполненным прямо в чате после отдельного подтверждения;
- устаревшие/уже выполненные action-кнопки не меняют состояние повторно;
- `/subscribe` теперь также синхронизирует список команд через MAX API;
- повторные webhook updates дедуплицируются для личных interactive-сценариев;
- в групповых чатах персональные бизнес-результаты не раскрываются.

## Mini App deep-link contract

Frontend понимает MAX `start_param`:

- `assessment_<impactId>` — конкретная карточка;
- `impact_<ruleId>` — текущая карточка правила;
- `profile` — профиль бизнеса;
- `feed` — изменения;
- `documents` — документы и настройки;
- `history` — история;
- `home`, `check`, `actions` — основной экран проверки.

Незавершённый профиль имеет приоритет и отправляет пользователя в onboarding, даже если deep-link ведёт в персональный раздел.

## Notifications

Welcome, deadline reminder и regulatory update используют native MAX buttons. Новое опубликованное требование теперь может уведомить пользователя не только при `applies`, но и при `needs_info`, чтобы сразу запросить недостающий business fact. Regulatory notification создаётся только для `regulatory_update`, а не при пользовательском редактировании профиля, чтобы исключить notification spam.

## Validation in build environment

- offline core: **186/186**;
- chatbot pure routing/copy gate: **9/9**;
- TS/TSX syntax/transpilation: **102 файлов, 0 ошибок**;
- `.env` не изменён; контрольный SHA-256 остаётся `0ad24632befd02d343fa3a9b074c18395371318396dec406b5ac2ed6fc2c9e94`.

Полный workspace typecheck/Vitest/Vite build в этой среде не заявляется успешным: npm install ранее оборвался из-за сетевой недоступности registry и оставил неполный `node_modules`. Финальный Docker build и live MAX acceptance выполняются на Yandex Cloud стенде.
