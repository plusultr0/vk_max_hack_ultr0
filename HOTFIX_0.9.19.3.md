# Hotfix 0.9.19.3

Исправляет production web build после успешного backend typecheck/tests.

Причина: при `noUncheckedIndexedAccess` результат RegExp.exec() делает элементы destructuring потенциально undefined. В `formatNumberInput` добавлены безопасные строковые значения по умолчанию для sign/integer/separator/fraction. Поведение форматирования не изменено.

Проверено локально в доступной среде:
- offline core: 229/229;
- chatbot offline: 10/10;
- syntax gate: 108 TS/TSX, 0 syntax errors.

Полный production build подтверждается повторным acceptance на сервере, где npm dependencies доступны.
