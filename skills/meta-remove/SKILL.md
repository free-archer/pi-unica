---
name: meta-remove
description: Безопасно удалить объект метаданных 1С по логическому адресу с анализом ссылок и атомарной публикацией.
allowed-tools: read find
---


# /meta-remove — удаление объекта метаданных

## MCP routing

Все инструменты `unica.*` вызываются через прокси pi-mcp-adapter: `mcp({ tool: "unica.<tool>", args: { ... } })`; полный список — `mcp({ server: "unica" })`.

- Preferred path: call `mcp({ tool: "unica.meta.remove", args: { ... } })`.
- Выбирайте объект только через `sourceSet + metadataPath`.
- Сначала оставьте `dryRun` по умолчанию и изучите типизированный план,
  зависимости и диагностики.
- Обычное применение требует `dryRun: false`. Принудительное применение при
  найденных ссылках разрешено только тройным подтверждением
  `force: true`, `confirm: true`, `dryRun: false`.
- Успешный и предметно неуспешный `mcp()` возвращает `structuredContent`;
  `isError == !structuredContent.ok`. Читайте ссылки, validation и доступные
  частичные данные из `structuredContent.data`; `content[0].text` не является
  вторым контрактом результата.
- Preview возвращает один семантический `removeObject` effect в
  `structuredContent.data.effects`, а не полный XML удаляемого объекта.
- Vendor support guard выполняется до публикации; закрытый объект не обходится
  прямым редактированием служебных файлов.
- `sourceSet` — это имя набора исходников из `v8project.yaml`, а не
  константа. Получите его через `unica.project.map`; `"main"` в примерах
  ниже — иллюстрация, а не значение по умолчанию.

```js
mcp({
  tool: "unica.meta.remove",
  args: {
    "cwd": "<workspace>",
    "sourceSet": "main",
    "metadataPath": "Catalog.Устаревший",
    "dryRun": true
  }
})
```
