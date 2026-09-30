# MAX chatbot acceptance matrix · 0.9.15

Цель: проверить один и тот же `t106_hakaton_max_bot` как быстрый чат-интерфейс и точку входа в Mini App. Персональные результаты должны показываться только в личном диалоге.

## 1. Start / menu

- Остановить и снова запустить бота либо открыть его заново.
- Ожидается welcome с native `open_app` и быстрыми callback-кнопками.
- Отправить `/start`, `/menu`, `привет`, `меню`.
- Ожидается одно и то же актуальное меню без дублирования ответа при повторной доставке одного webhook event.

## 2. Incomplete profile

На пользователе без подтверждённого onboarding выполнить `/status`, `/requirements`, `/actions`, `/changes`, `/documents`.

Ожидается: бот не показывает персональные юридические выводы и предлагает открыть профиль Mini App с прогрессом заполнения.

## 3. Status

`/status` или «всё ли в порядке».

Ожидается: реальные счётчики current baseline — действия, уточнения, проверка выполнения, выполненные требования, число оценённых активных rules. Есть дисклеймер о неполной юридической экспертизе.

## 4. Requirements

`/requirements`, «мои требования», «что относится».

Ожидается: до пяти текущих релевантных карточек с приоритетом needs-info/action-required и переход в Mini App.

## 5. Safe free-text lookup

- «что у меня по персональным данным?» — должен найти только связанные current personal impacts.
- произвольный вопрос вида «можно ли продавать X без лицензии?» при отсутствии совпадения — не должен выдумывать юридический ответ; возвращается безопасный fallback + меню.

## 6. Actions and completion

`/actions` или «что мне нужно сделать».

Ожидается: до трёх открытых action items со сроками, кнопкой открытия точной карточки и `Готово N`.

`Готово N` → отдельное подтверждение → `Подтвердить`.

Ожидается: `action_items.execution_status=completed`, audit event, обновлённый список действий и тот же результат в Mini App. Повторное нажатие старой кнопки сообщает, что действие уже выполнено/неактуально.

## 7. Changes

`/changes`, «что изменилось».

Ожидается: последние релевантные recent items из regulatory feed и переход в экран изменений Mini App.

## 8. Documents/settings

`/documents`, «какие документы нужны».

Ожидается: реальные summary counts checklist и до трёх missing items; подробная работа остаётся в Mini App.

## 9. History/profile/help

- `/history` → native open_app в историю;
- `/profile` / «мой бизнес» → профиль;
- `/help` / «что умеешь» → описание возможностей и границ сервиса.

## 10. Native notification flows

- `bot_started` → welcome;
- publication `applies` → новое релевантное требование + exact card;
- publication `needs_info` → просьба уточнить данные + exact card/question flow;
- deadline reminder → exact action/card + callback «Отметить выполненным»;
- `bot_stopped` / `dialog_removed` → queued delivery не должна продолжать персональные отправки;
- повторный `bot_started` → `bot_active=true`, новый welcome для нового event.

Пользовательское редактирование профиля само по себе не должно создавать `regulatory_update` spam.

## 11. Group/privacy

Если бот доступен в группе: известная команда должна вернуть только privacy-подсказку и не раскрывать company status; обычный групповой chatter игнорируется.

## 12. Mini App deep links

Проверить native `open_app` на mobile MAX и MAX Web/Desktop:

- home/check/actions;
- assessment_<impactId>;
- profile;
- feed;
- documents;
- history.

Незавершённый профиль всегда ведёт в onboarding.

## 13. Error/retry

- повторная доставка того же direct webhook не должна отправлять второй ответ;
- при ошибке внешней отправки event claim освобождается, чтобы MAX retry мог обработаться снова;
- malformed event → HTTP 400 без raw internal error в ответе;
- invalid webhook secret → HTTP 401;
- устаревший action/version → безопасное сообщение без изменения старого состояния.
