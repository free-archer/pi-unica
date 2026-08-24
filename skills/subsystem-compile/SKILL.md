---
name: subsystem-compile
description: Создать подсистему 1С — XML-исходники из JSON-определения. Используй когда нужно добавить подсистему (раздел) в конфигурацию
allowed-tools: bash read write find
---


# /subsystem-compile — генерация подсистемы из JSON

## MCP routing

Все инструменты `unica.*` вызываются через прокси pi-mcp-adapter: `mcp({ tool: "unica.<tool>", args: { ... } })`; полный список — `mcp({ server: "unica" })`.

- Preferred path: call `mcp({ tool: "unica.subsystem.compile", args: { ... } })`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `unica.subsystem.compile`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.
- Vendor support guard runs inside `unica`; if it blocks a locked/read-only supported object, prefer CFE/release-support or an explicit support-state change plan instead of editing raw support metadata.

Принимает JSON-определение подсистемы → генерирует XML + файловую структуру + регистрирует в родителе (Configuration.xml или родительская подсистема).

## MCP параметры

| Параметр | Описание |
|----------|----------|
| `DefinitionFile` | Путь к JSON-файлу определения |
| `Value` | Инлайн JSON-строка (альтернатива DefinitionFile) |
| `OutputDir` | Корень выгрузки (где `Subsystems/`, `Configuration.xml`) |
| `Parent` | Путь к XML родительской подсистемы (для вложенных) |
| `NoValidate` | Скрыть подробный отчёт авто-валидации; обязательная проверка корректности 8.3.27 перед фиксацией остаётся включённой |

```js
mcp({
  tool: "unica.subsystem.compile",
  args: {
    "cwd": "<workspace>",
    "Value": "{\"name\":\"Продажи\",\"synonym\":\"Продажи\",\"content\":[\"Catalog.Номенклатура\"]}",
    "OutputDir": "src",
    "dryRun": false
  }
})
```

## JSON-определение

```json
{
  "name": "МояПодсистема",
  "synonym": "Моя подсистема",
  "comment": "",
  "includeInCommandInterface": true,
  "useOneCommand": false,
  "explanation": "Описание раздела",
  "picture": "CommonPicture.МояКартинка",
  "content": ["Catalog.Товары", "Document.Заказ"]
}
```

Минимально: только `name`. Остальное — дефолты.

## Примеры

### Минимальная подсистема

```js
mcp({
  tool: "unica.subsystem.compile",
  args: {
    "cwd": "<workspace>",
    "Value": "{\"name\":\"Тест\"}",
    "OutputDir": "config/",
    "dryRun": false
  }
})
```

### С составом и картинкой

```js
mcp({
  tool: "unica.subsystem.compile",
  args: {
    "cwd": "<workspace>",
    "Value": "{\"name\":\"Продажи\",\"content\":[\"Catalog.Товары\",\"Report.Продажи\"],\"picture\":\"CommonPicture.Продажи\"}",
    "OutputDir": "config/",
    "dryRun": false
  }
})
```

### Вложенная подсистема

```js
mcp({
  tool: "unica.subsystem.compile",
  args: {
    "cwd": "<workspace>",
    "Value": "{\"name\":\"Дочерняя\"}",
    "OutputDir": "config/",
    "Parent": "config/Subsystems/Продажи.xml",
    "dryRun": false
  }
})
```
