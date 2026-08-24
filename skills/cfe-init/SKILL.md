---
name: cfe-init
description: Создать расширение конфигурации 1С (CFE) — scaffold XML-исходников. Используй когда нужно создать новое расширение для исправления, доработки или дополнения конфигурации
allowed-tools: bash read find
---


# /cfe-init — Создание расширения конфигурации 1С

## MCP routing

Все инструменты `unica.*` вызываются через прокси pi-mcp-adapter: `mcp({ tool: "unica.<tool>", args: { ... } })`; полный список — `mcp({ server: "unica" })`.

- Preferred path: call `mcp({ tool: "unica.cfe.init", args: { ... } })`; `unica` owns XML/JSON DSL work and refreshes related workspace caches after mutations.
- Do not call internal MCP/CLI adapters directly. They are hidden behind `unica` and synchronized by the orchestrator.
- Execution path: call MCP `unica` tool `unica.cfe.init`; skill-local operation scripts are not part of the workflow.
- For mutating operations, pass `dryRun: false` only when the user explicitly requested the change; otherwise keep the default dry run.

Создаёт scaffold расширения: `Configuration.xml`, `Languages/Русский.xml`, опционально `Roles/`.

## Подготовка

Если есть выгрузка базовой конфигурации, передай `-ConfigPath` — скрипт автоматически определит `CompatibilityMode` и UUID языка из базовой конфигурации.

### Авто-определение ConfigPath

Если пользователь не указал `-ConfigPath` — попробуй определить автоматически:
1. Используй `./v8project.yaml`.
2. Найди `source-set` с `type: CONFIGURATION`.
3. Используй его `path` как `-ConfigPath`.
4. Если source-set не найден — спроси путь у пользователя.

Если `v8project.yaml` не найден и `-ConfigPath` не задан — расширение создастся с предупреждением (UUID языка = нули, CompatibilityMode по умолчанию).

## Параметры

| Параметр | Описание | По умолчанию |
|----------|----------|--------------|
| `Name` | Имя расширения (обязат.) | — |
| `Synonym` | Синоним | = Name |
| `NamePrefix` | Префикс собственных объектов | = Name + "_" |
| `OutputDir` | Каталог для создания | `src` |
| `Purpose` | `Patch` (исправление) / `Customization` (доработка) / `AddOn` (дополнение) | `Customization` |
| `Version` | Версия расширения | — |
| `Vendor` | Поставщик | — |
| `CompatibilityMode` | Режим совместимости | `Version8_3_24` |
| `ConfigPath` | Путь к выгрузке базовой конфигурации (авто-определяет CompatibilityMode и Language UUID) | — |
| `NoRole` | Без основной роли | false |

## MCP вызов

```js
mcp({
  tool: "unica.cfe.init",
  args: {
    "cwd": "<workspace>",
    "Name": "MyExtension",
    "Synonym": "Моё расширение",
    "OutputDir": "src/extensions/MyExtension",
    "dryRun": false
  }
})
```

## Примеры

### Расширение для ERP с авто-совместимостью

```js
mcp({
  tool: "unica.cfe.init",
  args: {
    "cwd": "<workspace>",
    "Name": "Расш1",
    "ConfigPath": "C:\\WS\\tasks\\cfsrc\\erp_8.3.24",
    "OutputDir": "src",
    "dryRun": false
  }
})
```

### Расширение-исправление с явной совместимостью

```js
mcp({
  tool: "unica.cfe.init",
  args: {
    "cwd": "<workspace>",
    "Name": "Расш1",
    "Purpose": "Patch",
    "CompatibilityMode": "Version8_3_17",
    "OutputDir": "src",
    "dryRun": false
  }
})
```

### Расширение-доработка с версией

```js
mcp({
  tool: "unica.cfe.init",
  args: {
    "cwd": "<workspace>",
    "Name": "МоёРасширение",
    "Version": "1.0.0.1",
    "Vendor": "Компания",
    "OutputDir": "src",
    "dryRun": false
  }
})
```

### Без роли, с явным префиксом

```js
mcp({
  tool: "unica.cfe.init",
  args: {
    "cwd": "<workspace>",
    "Name": "ИсправлениеБага",
    "NamePrefix": "ИБ_",
    "Purpose": "Patch",
    "NoRole": true,
    "OutputDir": "src",
    "dryRun": false
  }
})
```

## Верификация

```js
mcp({
  tool: "unica.cfe.validate",
  args: {
    "cwd": "<workspace>",
    "ExtensionPath": "src/extensions/MyExtension"
  }
})
```
