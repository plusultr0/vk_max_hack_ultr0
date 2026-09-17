# S8 validation — UX hardening / mobile + desktop

Дата: 16.09.2026

Статус: **реализовано в коде; реальная проверка внутри MAX mobile/web ожидает публичный mini-app URL и token.**

## Реализовано

- единый responsive React mini-app вместо отдельных mobile/desktop приложений;
- mobile layout с bottom navigation и sticky CTA;
- desktop layout с боковой навигацией;
- onboarding с прогрессом и явным ответом «не знаю»;
- фильтры карточек: attention / all / applies / needs_info / not_applicable;
- понятные статусы `needs_review`, `needs_info`, `action_required`, `compliant`;
- loading / empty / inline error states;
- история версий профиля и audit events;
- deep link `impact_<ruleId>` прокручивает к нужной карточке;
- действия можно переводить в `in_progress` / `completed`;
- verified evidence открывается через MAX Bridge `openLink`, а вне MAX — обычным browser link;
- context questions теперь имеют явный тип ввода: boolean, select, multi-select, number, date, string-list или text;
- enum-поля больше не требуют вручную вводить внутренние значения (`receiptIssuer`, category банка и т.п.);
- compliance-вопросы получают человекочитаемые формулировки, а не технические имена полей.

## Важная UX-семантика

- `applies` не показывается как «нарушение»;
- если для compliance не хватает данных, карточка получает статус «Нужно уточнить»;
- пользователь не обязан заполнять всю техническую схему профиля при onboarding;
- context answer создаёт новую immutable profile version и не переписывает старую историю;
- «не знаю» в базовом профиле остаётся `null`, а не `false`.

## Статически проверено здесь

- TypeScript/TSX syntax parse (`tsc --noCheck`) — без ошибок;
- JSON manifests — parse OK;
- `compose.yaml` — parse OK.

## Что остаётся проверить на устройствах

После публикации HTTPS mini-app:

1. MAX mobile ширина около 375 px;
2. MAX Web/Desktop на 1440+;
3. viewport при открытой мобильной клавиатуре;
4. длинные названия карточек и action items;
5. deep link из bot notification;
6. переход по evidence через Bridge;
7. повторный вход после сохранённой сессии;
8. accessibility/focus navigation базового сценария.
