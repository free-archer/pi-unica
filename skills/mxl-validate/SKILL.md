---
name: mxl-validate
description: Валидация макета табличного документа (MXL). Используй после создания или модификации макета для проверки корректности
allowed-tools: bash read find
---


# /mxl-validate — валидация макета табличного документа (MXL)

## MCP routing

Все инструменты `unica.*` вызываются через прокси pi-mcp-adapter: `mcp({ tool: "unica.<tool>", args: { ... } })`; полный список — `mcp({ server: "unica" })`.

- Preferred path: call `mcp({ tool: "unica.mxl.validate", args: { ... } })`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `unica.mxl.validate`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Проверяет Template.xml на структурные ошибки: индексы, ссылки на палитры, диапазоны именованных областей и объединений.

## Параметры

| Параметр      | Обяз. | Умолч. | Описание                                 |
|---------------|:-----:|---------|--------------------------------------------|
| TemplatePath  | один из двух | —       | Путь к макету (директория или Template.xml) |
| sourceSet     | один из двух | —       | Имя набора исходников из `v8project.yaml`   |
| metadataPath  | один из двух | —       | Логический адрес, например `Report.<Отчёт>.Template.<Макет>` |
| Detailed      | нет   | —       | Подробный вывод (все проверки, включая успешные) |
| MaxErrors     | нет   | 20      | Остановиться после N ошибок                |

Селектор цели ровно один: либо `sourceSet` + `metadataPath`, либо
`TemplatePath`. Оба сразу отклоняются кодом `selector_conflict` (ADR-0049).

## MCP вызов

### Каталог макета

```js
mcp({
  tool: "unica.mxl.validate",
  args: {
    "cwd": "<workspace>",
    "TemplatePath": "Catalogs/Номенклатура/Templates/Макет"
  }
})
```

### Макет внешней обработки

```js
mcp({
  tool: "unica.mxl.validate",
  args: {
    "cwd": "<workspace>",
    "TemplatePath": "src/МояОбработка/Templates/ПечатнаяФорма"
  }
})
```

## Логический адрес вместо пути

`unica.mxl.validate` принимает либо логический селектор, либо файловый путь —
ровно один из двух. Оба сразу отклоняются кодом `selector_conflict`.

```js
mcp({
  tool: "unica.mxl.validate",
  args: {
    "cwd": "<workspace>",
    "sourceSet": "<имя набора>",
    "metadataPath": "Report.<Отчёт>.Template.<Макет>"
  }
})
```

Имя набора даёт `unica.project.map`, адрес — `unica.source.resolve`, а `unica.source.locate` переводит
в адрес путь, найденный иначе. Файловый селектор сохраняется до
отдельного среза его снятия (ADR-0049).
