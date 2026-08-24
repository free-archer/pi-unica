---
name: role-validate
description: Валидация роли 1С. Используй после создания или модификации роли для проверки корректности
allowed-tools: bash read
---


# /role-validate — валидация роли 1С

## MCP routing

Все инструменты `unica.*` вызываются через прокси pi-mcp-adapter: `mcp({ tool: "unica.<tool>", args: { ... } })`; полный список — `mcp({ server: "unica" })`.

- Preferred path: call `mcp({ tool: "unica.role.validate", args: { ... } })`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `unica.role.validate`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Проверяет корректность `Rights.xml` роли: формат XML, namespace, глобальные флаги, типы объектов, имена прав, RLS-ограничения, шаблоны. Опционально проверяет метаданные роли (UUID, имя, синоним).

## Параметры

| Параметр     | Обяз. | Умолч. | Описание                                        |
|--------------|:-----:|---------|-------------------------------------------------|
| RightsPath   | один из двух | —       | Путь к роли (директория или `Rights.xml`)        |
| sourceSet    | один из двух | —       | Имя набора исходников из `v8project.yaml`        |
| metadataPath | один из двух | —       | Логический адрес, например `Role.<ИмяРоли>`      |
| Detailed     | нет   | —       | Подробный вывод (все проверки, включая успешные)  |
| MaxErrors    | нет   | 30      | Макс. ошибок до остановки (по умолчанию 30)      |

Селектор цели ровно один: либо `sourceSet` + `metadataPath`, либо `RightsPath`.
Оба сразу отклоняются кодом `selector_conflict` (ADR-0049).

## MCP вызов

```js
mcp({
  tool: "unica.role.validate",
  args: {
    "cwd": "<workspace>",
    "RightsPath": "src/Roles/ЧтениеНоменклатуры",
    "Detailed": true,
    "MaxErrors": 30
  }
})
```

## Логический адрес вместо пути

`unica.role.validate` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```js
mcp({
  tool: "unica.role.validate",
  args: {
    "cwd": "<workspace>",
    "sourceSet": "<имя набора>",
    "metadataPath": "Role.<ИмяРоли>"
  }
})
```

Имя набора даёт `unica.project.map`, адрес — `unica.source.resolve`, а `unica.source.locate` переводит
в адрес путь, найденный иначе. Файловый селектор сохраняется до
отдельного среза его снятия (ADR-0049).
