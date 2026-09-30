# Changelog 0.9.11

- Исправлен ложный `refreshPending=true` после уже завершённого полного пересчёта компании.
- Полный пересчёт последней версии профиля теперь атомарно закрывает оставшиеся profile-triggered recalculation jobs этой компании.
- Частичные пересчёты конкретных rules не закрывают профильную очередь.
- Обновлены README, roadmap и test report по результатам первого Windows/Docker acceptance.
- `.env` и seed-набор не изменялись этим hotfix.
