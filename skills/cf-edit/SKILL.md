---
name: cf-edit
description: Точечное редактирование конфигурации 1С. Используй когда нужно изменить свойства конфигурации, добавить или удалить объект из состава, настроить роли по умолчанию, поменять раскладку панелей, настроить начальную страницу
allowed-tools: bash read write find
---


# /cf-edit — редактирование конфигурации 1С

## MCP routing

Все инструменты `unica.*` вызываются через прокси pi-mcp-adapter: `mcp({ tool: "unica.<tool>", args: { ... } })`; полный список — `mcp({ server: "unica" })`.

- Preferred path: call `mcp({ tool: "unica.cf.edit", args: { ... } })`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `unica.cf.edit`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.
- Vendor support guard runs inside `unica`; if it blocks a locked/read-only supported object, prefer CFE/release-support or an explicit support-state change plan instead of editing raw support metadata.

Точечное редактирование Configuration.xml: свойства, состав ChildObjects, роли по умолчанию.

## MCP параметры

| Параметр | Описание |
|----------|----------|
| `ConfigPath` | Путь к Configuration.xml или каталогу выгрузки |
| `Operation` | Операция (см. таблицу) |
| `Value` | Значение для операции (batch через `;;`) |
| `DefinitionFile` | JSON-файл с массивом операций |
| `NoValidate` | Скрыть подробный отчёт авто-валидации; обязательная проверка корректности 8.3.27 перед фиксацией остаётся включённой |

```js
mcp({
  tool: "unica.cf.edit",
  args: {
    "cwd": "<workspace>",
    "ConfigPath": "src/Configuration.xml",
    "Operation": "modify-property",
    "Value": "Version=1.0.0.1",
    "dryRun": false
  }
})
```

## Операции

| Операция | Формат Value | Описание |
|----------|-------------|----------|
| `modify-property` | `Ключ=Значение` (batch `;;`) | Изменить свойство |
| `add-childObject` | `Type.Name` (batch `;;`) | Зарегистрировать уже существующий файл объекта в ChildObjects. Для создания нового объекта используй `/skill:meta-add`, `/skill:role-compile`, `/skill:subsystem-compile` — они регистрируют автоматически |
| `remove-childObject` | `Type.Name` (batch `;;`) | Удалить объект из ChildObjects |
| `add-defaultRole` | `Role.Name` или `Name` | Добавить роль по умолчанию |
| `remove-defaultRole` | `Role.Name` или `Name` | Удалить роль по умолчанию |
| `set-defaultRoles` | Имена через `;;` | Заменить список ролей по умолчанию |
| `set-panels` | JSON-объект (см. [reference.md](reference.md)) | Перезаписать `Ext/ClientApplicationInterface.xml` (раскладка панелей) |
| `set-home-page` | JSON-объект (см. [reference.md](reference.md)) | Перезаписать `Ext/HomePageWorkArea.xml` (начальная страница) |

Допустимые значения свойств, формат DefinitionFile (JSON), каноничный порядок: [reference.md](reference.md)

## Примеры

### Изменить версию и поставщика

```js
mcp({
  tool: "unica.cf.edit",
  args: {
    "cwd": "<workspace>",
    "ConfigPath": "src",
    "Operation": "modify-property",
    "Value": "Version=1.0.0.1 ;; Vendor=Фирма 1С",
    "dryRun": false
  }
})
```

### Добавить объекты

```js
mcp({
  tool: "unica.cf.edit",
  args: {
    "cwd": "<workspace>",
    "ConfigPath": "src",
    "Operation": "add-childObject",
    "Value": "Catalog.Товары ;; Document.Заказ",
    "dryRun": false
  }
})
```

### Удалить объект

```js
mcp({
  tool: "unica.cf.edit",
  args: {
    "cwd": "<workspace>",
    "ConfigPath": "src",
    "Operation": "remove-childObject",
    "Value": "Catalog.Устаревший",
    "dryRun": false
  }
})
```

### Добавить роль по умолчанию

```js
mcp({
  tool: "unica.cf.edit",
  args: {
    "cwd": "<workspace>",
    "ConfigPath": "src",
    "Operation": "add-defaultRole",
    "Value": "ПолныеПрава",
    "dryRun": false
  }
})
```

### Заменить роли по умолчанию

```js
mcp({
  tool: "unica.cf.edit",
  args: {
    "cwd": "<workspace>",
    "ConfigPath": "src",
    "Operation": "set-defaultRoles",
    "Value": "ПолныеПрава ;; Администратор",
    "dryRun": false
  }
})
```
