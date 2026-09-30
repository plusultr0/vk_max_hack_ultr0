# 0.9.11 hotfix

Дата: 25.09.2026.

После первого Windows/Docker acceptance версии 0.9.10 был найден один реальный сбой в финальном `usability.integration.ts`.

## Симптом

После синхронного полного пересчёта все карточки уже относились к новой версии профиля, но API мог вернуть `refreshPending: true` из-за более старого profile-recalculation job, оставшегося в очереди. Из-за этого acceptance завершался `exit code 1` на проверке `after.refreshPending === false`.

## Исправление

Полный `recalculateInTransaction(...)` теперь атомарно помечает обработанными все оставшиеся profile-triggered jobs этой компании. Такой полный пересчёт уже использует последнюю подтверждённую версию профиля, поэтому старые profile jobs не несут дополнительной работы.

Частичные пересчёты конкретных правил (`onlyRuleIds`) это состояние не меняют.

## Regression

Существующая проверка `packages/db/src/usability.integration.ts` уже воспроизводит ошибку: contextual answer создаёт новую версию профиля, обе карточки остаются current и `refreshPending` обязан стать `false`.

Перед дальнейшим live-тестированием необходимо повторить:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\\scripts\\acceptance.ps1"
```

Успех: контейнер `tests` завершился с code 0 и `$LASTEXITCODE` равен 0.
