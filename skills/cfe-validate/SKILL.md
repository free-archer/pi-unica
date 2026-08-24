---
name: cfe-validate
description: Валидация расширения конфигурации 1С (CFE). Используй после создания или модификации расширения для проверки корректности
allowed-tools: bash read find
---


# /cfe-validate — валидация расширения конфигурации (CFE)

## MCP routing

Все инструменты `unica.*` вызываются через прокси pi-mcp-adapter: `mcp({ tool: "unica.<tool>", args: { ... } })`; полный список — `mcp({ server: "unica" })`.

- Preferred path: call `mcp({ tool: "unica.cfe.validate", args: { ... } })`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `unica.cfe.validate`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Проверяет структурную корректность расширения: XML-формат, свойства, состав, заимствованные объекты, семантику сервисов (`HTTPService`, `WebService`) — включая соответствие `HTTPMethod` перечислению платформы 8.3.27 (`Any`, `GET`, `PROPFIND`, …). Аналог `/cf-validate`, но для расширений.

## Параметры

| Параметр      | Обяз. | Умолч. | Описание                                        |
|---------------|:-----:|---------|-------------------------------------------------|
| ExtensionPath | да    | —       | Путь к каталогу или Configuration.xml расширения |
| Detailed      | нет   | —       | Подробный вывод (все проверки, включая успешные)  |
| MaxErrors     | нет   | 30      | Остановиться после N ошибок                      |

## MCP вызов

### Каталог расширения

```js
mcp({
  tool: "unica.cfe.validate",
  args: {
    "cwd": "<workspace>",
    "ExtensionPath": "src"
  }
})
```

### Прямой путь к Configuration.xml расширения

```js
mcp({
  tool: "unica.cfe.validate",
  args: {
    "cwd": "<workspace>",
    "ExtensionPath": "src/Configuration.xml"
  }
})
```
