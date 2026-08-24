---
name: subsystem-validate
description: Валидация подсистемы 1С. Используй после создания или модификации подсистемы для проверки корректности
allowed-tools: bash read find
---


# /subsystem-validate — валидация подсистемы 1С

## MCP routing

Все инструменты `unica.*` вызываются через прокси pi-mcp-adapter: `mcp({ tool: "unica.<tool>", args: { ... } })`; полный список — `mcp({ server: "unica" })`.

- Preferred path: call `mcp({ tool: "unica.subsystem.validate", args: { ... } })`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `unica.subsystem.validate`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Проверяет структурную корректность XML-файла подсистемы из выгрузки конфигурации.

## Параметры

| Параметр      | Обяз. | Умолч. | Описание                                  |
|---------------|:-----:|---------|--------------------------------------------|
| SubsystemPath | один из двух | —       | Путь к XML-файлу подсистемы                |
| sourceSet     | один из двух | —       | Имя набора исходников из `v8project.yaml`  |
| metadataPath  | один из двух | —       | Логический адрес, например `Subsystem.<Подсистема>` |
| Detailed      | нет   | —       | Подробный вывод (все проверки, включая успешные) |
| MaxErrors     | нет   | 30      | Остановиться после N ошибок                |

Селектор цели ровно один: либо `sourceSet` + `metadataPath`, либо
`SubsystemPath`. Оба сразу отклоняются кодом `selector_conflict` (ADR-0049).

## MCP вызов

### Каталог подсистемы

```js
mcp({
  tool: "unica.subsystem.validate",
  args: {
    "cwd": "<workspace>",
    "SubsystemPath": "Subsystems/Продажи"
  }
})
```

### Прямой путь к XML подсистемы

```js
mcp({
  tool: "unica.subsystem.validate",
  args: {
    "cwd": "<workspace>",
    "SubsystemPath": "Subsystems/Продажи.xml"
  }
})
```

## Логический адрес вместо пути

`unica.subsystem.validate` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```js
mcp({
  tool: "unica.subsystem.validate",
  args: {
    "cwd": "<workspace>",
    "sourceSet": "<имя набора>",
    "metadataPath": "Subsystem.<Подсистема>"
  }
})
```

Имя набора даёт `unica.project.map`, адрес — `unica.source.resolve`, а `unica.source.locate` переводит
в адрес путь, найденный иначе. Файловый селектор сохраняется до
отдельного среза его снятия (ADR-0049).
