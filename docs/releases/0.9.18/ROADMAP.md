# Roadmap · MAX Regulatory Control 0.9.18

Дата: 28.09.2026. База: source 0.9.16 из transfer-архива + подтверждённый ранее Yandex Cloud/MAX стенд 0.9.14. Архитектура не переписывалась, рабочий `.env` сохранён.

## 0. Текущая точка

0.9.18 поверх 0.9.17 удаляет из каждой карточки требования дублирующий блок «Ваши ответы, которые повлияли на результат» со списком введённых значений. Расчёт применимости, уточняющие вопросы, редактирование ответов, действия и источники не меняются.

0.9.17 закрывает последний невыполненный UX-запрос из handoff 28.09.2026 поверх уже готовых 0.9.15 и 0.9.16:

- «Мой бизнес» — 8 вопросов одной последовательностью без групповых блоков и старого progress track;
- geography поддерживает всю Россию / Россию и СНГ / произвольный регион или другой охват без миграции существующего `region`;
- пользовательский раздел результатов переименован в «Требования»;
- dynamic question copy и счётчики упрощены, RUB-поля форматируются пробелами;
- `not_applicable` explanation больше не показывает текст про недостающие поля;
- НДС-действия называют конкретную дату, а scenario с регистрацией до/после 01.01.2026 закреплён regression test;
- evaluator/seed не переписывались там, где проблема оказалась только UI/copy.

Важно: **37 — это количество требований/карточек, а не 37 отдельных законов**. Сервис не заявляет полноту законодательства или автоматическую юридическую экспертизу.

## 0.1. 0.9.15 — чат-бот как полноценный интерфейс

Статус: **реализовано в коде и сохранено в 0.9.17; interactive flow всё ещё требует live redeploy/acceptance на стенде**.

- `/start`, `/menu`, `/status`, `/requirements`, `/actions`, `/changes`, `/documents`, `/history`, `/profile`, `/help`;
- распознавание обычных русских формулировок без необходимости помнить команды;
- native MAX `open_app` и callback navigation;
- персональные ответы строятся по реальной DB/baseline/feed/checklist, а не по статическим заглушкам;
- свободный тематический запрос ищет только по уже рассчитанным требованиям, без генерации юридического ответа;
- action можно завершить прямо из чата после подтверждения;
- group privacy guard исключает вывод персональных результатов в общий чат;
- `bot:subscribe` синхронизирует webhook и список команд;
- Mini App принимает `start_param` и открывает точный экран/assessment;
- publication notification поддерживает `needs_info`, чтобы пользователь мог сразу дать недостающий факт;
- regulatory notifications создаются только из publication/regulatory-update flow, а не при обычном редактировании профиля.

Матрица ручной проверки: `BOT_SCENARIOS_0.9.15.md`.

## 0.2. 0.9.16 — полнота regulatory feed

Статус: **сохранено без регрессии**. Фильтр «Добавлены в сервис за последние 90 дней» использует service-added timestamp; `new`/`upcoming` остаются каталоговыми фильтрами, а `relevant` — персональным. Подробности: `CHANGELOG_0.9.16.md`.

## 1. Этап A — UX follow-up 0.9.17

Статус: **выполнено в коде и повторно пройден static layout gate**.

- Удалены customer eyebrow `МОЙ БИЗНЕС` и `ПРОВЕРКА БИЗНЕСА`.
- Onboarding оставляет `Вопрос N из 8`, но убирает секции «О бизнесе» / «Продажи и оплата» / «Данные покупателей».
- Удалён второй progress/подпись «Заполните то, что знаете сейчас».
- Разделители между вопросами получили отдельный отступ и не пересекают legend.
- Главный список и навигация используют термин «Требования».
- Удалён большой scope-disclaimer с главного списка.
- Dynamic fact counter использует обычные числа без zero-padding.
- RUB input визуально группирует разряды пробелами.
- Дата в НДС-action показывается явно.
- География расширена только на уровне ввода/хранения; региональная применимость не выдумывается, потому что текущий seed-37 не содержит условий по `region`.
- УСН не дробится на объекты налогообложения без текущего правила, которому этот факт нужен.

## 2. Этап B — execution/completion UX

Статус: **выполнено в коде**.

Существующая модель `action_items.execution_status` переиспользована без новой таблицы:

- отдельный action можно отметить выполненным;
- статус требования считается выполненным, когда все обязательные, не review-required действия отмечены пользователем;
- UI показывает «Требования выполнены» / «Требования ещё не выполнены» и счётчик действий;
- рядом явно указано, что это отметка пользователя, а не автоматическое подтверждение юридического соответствия;
- при изменении смыслового action hash существующая lifecycle-логика не переносит старое выполнение как актуальное.

Следующая runtime-проверка должна отдельно пройти состояния `applicable/action_required`, `completed`, `review_required/reopened`, `upcoming`, `not_applicable`, `needs_info`, `manual review`.

## 3. Этап C — seed 30–40

Статус: **37 требований в seed, 30 новых fixtures**.

Добавлены пакеты:

- персональные данные — 13 новых требований;
- дистанционная торговля / защита потребителей — 12;
- ККТ / электронные чеки — 2;
- УСН / НДС 2026 — 3.

Для каждого нового правила есть:

- официальный evidence URL;
- читаемое название и объяснение;
- applicability и исключения;
- dynamic facts при необходимости;
- fixtures `applies`, `not_applicable`, `needs_info`;
- конкретные actions;
- immutable rule version 1.

Карта источников и юридические ограничения: `LEGAL_SEED_RESEARCH_0.9.14.md`.

## 4. Подтверждено в среде сборки

| Проверка | Результат |
|---|---:|
| Offline pure production core / UX / ingestion | **189/189** |
| TS/TSX syntax/transpilation | **102 файла, 0 ошибок** |
| Chatbot offline routing/copy | **9/9** |
| User CSS/layout 0.9.18 | **80/80** |
| Admin review layout | **5/5** |
| Dynamic fact definitions | **39 версий, 0 конфликтов/binding errors** |
| `.env` против входного transfer ZIP | **SHA-256 без изменений** |

Static layout выполнялся системным Chromium на 320/375/768/1024/1440 px. Это не React runtime test.

## 5. Этап D — обязательный runtime acceptance

Статус: **не подтверждён в текущей среде**.

Причина не маскируется под успешный тест:

- Docker CLI отсутствует;
- свежая установка npm dependencies упёрлась в DNS `EAI_AGAIN` к `registry.npmjs.org`.

Поэтому здесь не заявляются пройденными PostgreSQL integration, full workspace typecheck/Vitest, Vite production build и настоящий React browser regression.

На Windows первым запускать:

```powershell
Set-Location "<путь к распакованной 0.9.17>\vk_max_hack_ultr0-main"

docker compose --env-file .env.test.example -p max-regcontrol-tests -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
$LASTEXITCODE
```

Нужен `0`.

Сброс только тестового стека:

```powershell
docker compose --env-file .env.test.example -p max-regcontrol-tests -f compose.test.yaml down -v --remove-orphans
```

После этого проверить рабочий clean start без удаления рабочего volume:

```powershell
docker compose up -d --build
docker compose ps -a
curl.exe http://localhost:3000/health
curl.exe http://localhost:3001/health
Start-Process "http://localhost:5173"
```

## 6. React/browser gate

После успешной установки зависимостей:

```powershell
npm run dev:web -- --host 127.0.0.1
python -m pip install -r tests/browser/requirements.txt
python -m playwright install chromium
python tests/browser/regression.py --base-url http://127.0.0.1:5173
```

Обязательно руками проверить новую карточку applicable: action list → отметка шагов → law-level «Требования выполнены» → reload → изменение основания/новая версия → корректная повторная проверка.

## 7. Этап E — live external

Статус: **инфраструктурная часть подтверждена на 0.9.14; source-изменения 0.9.15–0.9.18 ещё нужно развернуть и пройти live acceptance**.

На Yandex Cloud уже фактически подтверждены: публичный HTTPS, PostgreSQL/API/web/bot/worker, MAX webhook subscription, получение `bot_started` и реальная отправка welcome notification со статусом `sent`. Mini App привязан организаторами и открывается в MAX.

После redeploy 0.9.18 подтвердить:

1. slash-команды и обычные русские фразы;
2. callback navigation;
3. native `open_app` + `start_param` на mobile/web;
4. action completion из чата и отражение результата в Mini App;
5. needs-info publication notification;
6. group privacy/error/retry сценарии;
7. реальный arbitrary official document → GigaChat extraction → grounded evidence → publication → targeted reassessment → MAX notification.

Не заменять этот этап синтетическими ответами.

## 8. Submission hardening

После зелёного runtime/live gate:

- чистый запуск на новой машине;
- зафиксированный commit/hash и архив;
- финальный demo-script;
- проверка всех дисклеймеров о неполноте базы;
- OpenAPI/DATA-API и понятный способ воспроизвести тесты;
- финальная презентация и ручной проход mobile MAX.
