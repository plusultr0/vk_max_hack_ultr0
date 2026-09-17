# S2 validation report

Дата: 16.09.2026

## Реализовано

- миграция `003_profile_drafts.sql`;
- `CompanyProfileDraftSchema`;
- draft storage отдельно от immutable confirmed profile versions;
- `answered_fields`, чтобы `null` («не знаю») не путался с отсутствием ответа;
- `GET /company/profile`;
- `PUT /company/profile`;
- `POST /company/profile/confirm`;
- базовый onboarding из 8 полей;
- progress / canConfirm;
- frontend-профиль с yes/no/«не знаю» и каналами продаж;
- повторное редактирование создаёт новую версию после подтверждения, а старую не переписывает.

## Базовые onboarding fields

```text
legalForm
region
taxRegime
sellsToConsumers
salesChannels
distanceSales
onlinePayment
collectsPersonalData
```

Это не вся техническая схема профиля. `usesKkt`, `receiptIssuer`, доходы, товарные коды, основания ПДн, банк и т.п. остаются context questions конкретных правил.

## Семантика unknown

- поле не отвечено: отсутствует в `answered_fields`;
- пользователь явно выбрал «не знаю»: поле присутствует в `answered_fields`, значение `null`;
- `false` означает только явный ответ «нет»;
- пустой массив каналов — известный ответ, а не unknown.

## Проверки, которые пока требуют среды команды

Из-за недоступного npm registry full TypeScript build/Vitest не выполнены. После `npm install` проверить:

```bash
npm test
npm run build:web
npm run db:migrate
npm run seed
```

Дальше smoke:

1. `/auth/dev`;
2. `GET /company/profile` -> 0%;
3. сохранить часть полей -> draft сохранился;
4. `null` считается отвеченным полем;
5. после 8 ответов `canConfirm=true`;
6. confirm -> profileVersion=1;
7. новое редактирование не меняет v1;
8. второй confirm -> profileVersion=2;
9. v1 остаётся в БД без изменений.

## Статус S3

Отдельной новой разработки не требуется: S3 «5–7 подготовленных карточек + тестовые профили» уже сделан в S0/S06 и лежит в `seed/v1`. Следующий незакрытый этап после проверки — S4.
