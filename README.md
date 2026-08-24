# pi-unica

Плагин [pi](https://pi.dev) с функционалом [unica](https://github.com/IngvarConsulting/unica)
(1С:Предприятие) для клиента pi. Переносит 74 MCP-инструмента `unica.*`, 73 скилла
и контентные справочники из плагина Codex/Claude `unica` на pi-клиент.

Backend остаётся тем же Rust-сервером `unica` (не переписывается на TypeScript):
он подключается через pi-пакет **`pi-mcp-adapter`**, который предоставляет
прокси-инструмент `mcp()`. Через него агент вызывает `unica.*`.

## Архитектура

```
pi-unica (этот пакет)
├── extensions/unica.ts        регистрация backend + статус/диагностика (/unica)
├── skills/                    73 адаптированных скилла (SKILL.md в подпапках)
├── references/                platform/ specs/ tooling/ use-cases/ (контент)
├── scripts/
│   ├── setup-backend.sh       сборка + скачивание backend (тонкий враппер)
│   ├── setup-backend.mjs      основная логика установки backend
│   ├── package.sh             упаковка в один файл (тонкий враппер)
│   ├── package.mjs            сборка dist/pi-unica-<target>.tar.gz
│   ├── generate-manifest.mjs  генерация runtime/third-party/manifest.json
│   └── adapt-skills.mjs       регенерация skills/ из вендоренного unica/
├── runtime/                   ГЕНЕРИРУЕТСЯ setup-ом
│   ├── bin/<target>/{unica,bsl-analyzer,v8-runner,rlm-bsl-mcp,rlm-bsl-index}
│   ├── third-party/manifest.json + tools.lock.json
│   ├── skills/ + .mcp.json    (маркеры для поиска plugin-root)
└── unica/                     вендоренный upstream (не менять)
```

`pi-unica` **не пишет свой MCP-клиент**. Он:
1. собирает/скачивает Rust-рантайм unica (бинарник `unica` + 4 сторонних
   бинаря — полный паритет);
2. расширение само регистрирует его в `~/.pi/agent/mcp.json` на
   `session_start` (паттерн `@agent-sh/computer-use-linux`); при сборке из
   исходника то же делает `scripts/setup-backend.sh`;
3. `pi-mcp-adapter` читает этот конфиг и даёт прокси `mcp()`;
4. скиллы маршрутизируются через `mcp({ tool: "unica.<tool>", args: {...} })`.

## Предварительные условия

```bash
pi install npm:pi-mcp-adapter
```

Требуется Node.js ≥ 20 и (для сборки) Rust `cargo`. Сборка unica тянет git-зависимости
(`bsl-parser`, `bsl-syntax`), сторонние бинари скачиваются с GitHub-релизов
`IngvarConsulting/unica-toolchain` (~200 МБ) и проверяются по SHA-256.

## Установка

```bash
# 1. прокси MCP
pi install npm:pi-mcp-adapter

# 2. сам пакет (локальный путь)
pi install /home/archer/projects/pi-unica

# 3. backend: сборка unica + 4 сторонних бинаря + manifest + запись в mcp.json
cd /home/archer/projects/pi-unica
./scripts/setup-backend.sh

# 4. перезагрузка
#    в pi: /reload
```

Флаги `setup-backend.sh`:

```
--target <id>          linux-x64 | darwin-arm64 | win-x64 (по умолчанию — авто)
--skip-build           не собирать unica (бинарник уже есть)
--skip-download        не скачивать сторонние бинари
--skip-mcp-config      не писать ~/.pi/agent/mcp.json
--from-runtime-url URL запасной путь: официальный unica-runtime-<target>.tar.gz
--dry-run              показать план без выполнения
```

## Установка из архива (офлайн, без cargo и сети) для windows

собрать архивы командой `./scripts/package.sh --all`

Готовые архивы собираются в `dist/` скриптом `scripts/package.sh` (см. ниже):
`pi-unica-linux-x64.tar.gz` и `pi-unica-win-x64.tar.gz`. Архив самодостаточен —
Rust-рантайм `unica` и четыре сторонних бинаря (`bsl-analyzer`, `v8-runner`,
`rlm-bsl-mcp`, `rlm-bsl-index`) лежат в `runtime/bin/<target>/`, поэтому на
целевой машине не нужны ни cargo, ни git-зависимости, ни сеть.

Для целевой Windows-машины:

```powershell
# 1. перенести архив (USB / сетевой шар / etc.)
#    pi-unica-win-x64.tar.gz

# 2. распаковать
tar -xzf pi-unica-win-x64.tar.gz

# 3. прокси MCP (единственная сетевая зависимость, ставится один раз)
pi install npm:pi-mcp-adapter

# 4. сам пакет (локальный каталог)
pi install .\pi-unica-win-x64

# 5. в pi: /reload
```

Проверка в сессии pi:

```
mcp({ server: "unica" })   → 74 инструмента
/unica                     → binary OK / manifest present / MCP config записан / mcp() available
```

## Сборка архивов

```bash
./scripts/package.sh --all             # оба архива: linux-x64 и win-x64
./scripts/package.sh --target win-x64  # один архив
./scripts/package.sh --universal       # один архив с рантаймами обеих target
```

Скрипт скачивает официальный `unica-runtime-<target>.tar.gz` с релиза
`IngvarConsulting/unica` (по умолчанию `v0.12.0`), сверяет SHA-256 архива с
метаданными релиза `unica-runtime-<target>.json` и пишет в `dist/` архив + файл
`.sha256`. Архивы детерминированы (фиксированные mtime, порядок и владелец записей).

## Проверка

В сессии pi:

```
mcp({ server: "unica" })
```

должно вернуть список из **74 инструментов** (семейства project / source / build /
runtime / code / xdto / standards / documentation / cf / support / cfe / epf /
erf / meta / form / interface / subsystem / dcs / mxl / role / help / template).

Вызов инструмента:

```
mcp({ tool: "unica.project.map", args: { "cwd": "<fixture>" } })
```

Команда статуса:

```
/unica
```

## Скиллы

Скиллы загружаются по требованию и регистрируются как команды `/skill:<name>`:

```
/skill:meta-add
/skill:code-search
/skill:form-edit
```

Список адаптированных скиллов — 73 директории в `skills/` (полный паритет с
upstream). Примеры в `SKILL.md` используют `mcp({ tool: "unica.*", args: {...} })`,
ссылки `../../references/...` читаются относительно скилла.

Регенерация скиллов из вендоренного `unica/`:

```bash
node scripts/adapt-skills.mjs
```

## Справочники

`references/` — контентные справочники без изменений:

- `platform/` — механика платформы, объекты, транзакции/блокировки, стандарты;
- `specs/` — DSL-спецификации (form, dcs, mxl, xdto, role, cfe, epf, erf…);
- `tooling/` — `v8project.yaml`, runtime/build;
- `use-cases/` — сценарии (формы, права, отчёты, интеграции…).

## Ограничения

- `build.*` / `runtime.*` реально исполняют 1cv8 только там, где установлена
  платформа 1С; на Linux-хосте доступен preview/dryRun. Поверхность инструментов
  присутствует целиком.
- Сетевой адаптер `v8std` (`ai.v8std.ru`) — опционально, вне основного scope.
- Сборка `unica` из исходника требует сетевого доступа к git-зависимостям cargo;
  при нежелательности сборки используйте `--from-runtime-url` с официальным
  рантайм-архивом.

## Тесты и сценарии проверки

1. `mcp({ server: "unica" })` → 74 инструмента.
2. Офлайн на фикстуре 1С-воркспейса (`v8project.yaml` + `Configuration.xml`):
   - `unica.project.map` → карта sourceSet;
   - `unica.cf.init` / `unica.cf.info` / `unica.cf.validate`;
   - `unica.meta.add` (kind=Catalog) → справочник атомарно; `meta.edit/info/remove`;
   - `unica.form.edit` / `unica.dcs.edit` / `unica.mxl.*` / `unica.xdto.*` /
     `unica.role.*` / `unica.subsystem.*` / `unica.interface.*` / `unica.cfe.*` /
     `unica.epf.init` / `unica.erf.init`.
3. После сторонних бинарей: `unica.code.search` / `unica.code.graph` /
   `unica.code.diagnostics` на BSL-модуле возвращают ролевые секции.
4. Скиллы `/skill:meta-add`, `/skill:code-search` загружаются; пути
   `../../references/...` читаются.
5. Расширение: при отсутствии бинаря — уведомление; `/unica` показывает статус.
6. SHA-256 проверка бинарей и негативный кейс (испорченный бинарь → checksum
   mismatch).
