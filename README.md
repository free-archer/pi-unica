# pi-unica

Плагин [pi](https://pi.dev) с функционалом [unica](https://github.com/IngvarConsulting/unica)
(1С:Предприятие) для клиента pi. Переносит поверхность **Unica v0.13.0** —
11 MCP-инструментов `unica.*`, 55 скиллов и контентные справочники — из плагина
Codex/Claude `unica` на pi-клиент.

Начиная с 0.13 upstream публикует **тонкое** ядро: релизный архив несёт только
бинарник `unica` и сгенерированный манифест, а движки (`bsl-analyzer`,
`v8-runner`, `rlm-bsl-mcp`, `rlm-bsl-index`) лежат в отдельных неизменяемых
релизах. pi-unica собирает самодостаточный рантайм сам: ядро — из релиза
`v0.13.0`, движки — по адресам из вендоренного `tools.lock.json`.

Backend остаётся тем же Rust-сервером `unica` (не переписывается на TypeScript):
он подключается через pi-пакет **`pi-mcp-adapter`**, который предоставляет
прокси-инструмент `mcp()`. Через него агент вызывает `unica.*`.

## Архитектура

```
pi-unica (этот пакет)
├── AGENTS.md                  инструкции для агентов: инварианты, процедуры, проверки
├── extensions/unica.ts        регистрация backend + статус/диагностика (/unica)
├── skills/                    55 адаптированных скиллов (SKILL.md в подпапках)
├── references/                platform/ specs/ tooling/ use-cases/ (контент)
├── scripts/
│   ├── setup-backend.sh       установка backend (тонкий враппер)
│   ├── setup-backend.mjs      основная логика установки backend
│   ├── package.sh             упаковка в один файл (тонкий враппер)
│   ├── package.mjs            сборка dist/pi-unica-<version>-<target>.tar.gz
│   ├── generate-manifest.mjs  генерация runtime/third-party/manifest.json
│   ├── adapt-skills.mjs       регенерация skills/ из вендоренного unica/
│   └── lib/
│       ├── version.mjs        ПИН версии Unica (единственное место)
│       └── toolchain.mjs      скачивание ядра и движков, проверка SHA-256
├── runtime/                   ГЕНЕРИРУЕТСЯ setup-ом
│   ├── bin/<target>/{unica,bsl-analyzer,v8-runner,rlm-bsl-mcp,rlm-bsl-index}
│   ├── third-party/manifest.json + tools.lock.json
│   ├── runtime-manifest.json  версия ядра, версии движков, их SHA-256
│   ├── skills/ + .mcp.json    (маркеры для поиска plugin-root)
└── unica/                     вендоренный upstream 0.13.0 (не менять)
```

Версия Unica зафиксирована в четырёх местах, которые сверяются друг с другом:
`package.json` (`version` + блок `unica`), `scripts/lib/version.mjs`
(`UNICA_VERSION = "v0.13.0"`), сгенерированный `runtime/runtime-manifest.json`
и заголовок `third-party/manifest.json`. Расхождение `package.json` и
`scripts/lib/version.mjs` — жёсткая ошибка сборки, а не предупреждение.

`pi-unica` **не пишет свой MCP-клиент**. Он:
1. устанавливает рантайм unica: релизное ядро `unica` v0.13.0 + 4 движка,
   скачанных по пинам из `tools.lock.json` (полный паритет с поставкой upstream);
2. расширение само регистрирует его в `~/.pi/agent/mcp.json` на
   `session_start` (паттерн `@agent-sh/computer-use-linux`); при сборке из
   исходника то же делает `scripts/setup-backend.sh`;
3. `pi-mcp-adapter` читает этот конфиг и даёт прокси `mcp()`;
4. скиллы маршрутизируются через `mcp({ tool: "unica.<tool>", args: {...} })`.

## Предварительные условия

```bash
pi install npm:pi-mcp-adapter
```

Требуется Node.js ≥ 20 и (только для `--build-local`) Rust `cargo`. Движки
скачиваются с GitHub-релизов `IngvarConsulting/unica-toolchain`,
`IngvarConsulting/v8-runner-rust` и `IngvarConsulting/unica` (~230 МБ на цель) и
проверяются по SHA-256: архив ядра — по метаданным релиза, движки — по пинам
`tools.lock.json`.

## Установка

```bash
# 1. прокси MCP
pi install npm:pi-mcp-adapter

# 2. сам пакет (локальный путь)
pi install /home/archer/projects/pi-plugins/pi-unica

# 3. backend: ядро v0.13.0 + 4 движка + manifest + запись в mcp.json
cd /home/archer/projects/pi-plugins/pi-unica
./scripts/setup-backend.sh

# 4. перезагрузка
#    в pi: /reload
```

Флаги `setup-backend.sh`:

```
--target <id>          linux-x64 | darwin-arm64 | win-x64 (по умолчанию — авто)
--version <tag>        тег релиза Unica (по умолчанию — пиннутый v0.13.0)
--build-local          собрать unica из вендоренного исходника (cargo) вместо релиза
--skip-core            не трогать бинарник unica
--skip-engines         не скачивать движки (алиасы: --skip-build, --skip-download)
--skip-manifest        не перегенерировать third-party/manifest.json
--skip-mcp-config      не писать ~/.pi/agent/mcp.json
--force                переустановить bin/<target>, даже если версия уже совпадает
--from-runtime-url URL запасной путь: взять ядро из указанного архива
--keep-build-cache     сохранить runtime/.downloads
--dry-run              показать план без выполнения
```

Если в `runtime/` лежит дерево от другой версии Unica (это видно по
`runtime/runtime-manifest.json`), setup не подмешивает новые файлы к старым, а
переустанавливает `bin/<target>` целиком.

## Установка из архива (офлайн, без cargo и сети) для Windows

Архивы собираются командой `./scripts/package.sh --all` (см. «Сборка архивов») в
`dist/`: `pi-unica-0.13.0-linux-x64.tar.gz` и `pi-unica-0.13.0-win-x64.tar.gz` —
версия Unica стоит в имени архива. Архив самодостаточен — ядро `unica` v0.13.0 и
четыре движка (`bsl-analyzer`, `v8-runner`, `rlm-bsl-mcp`, `rlm-bsl-index`) лежат в
`runtime/bin/<target>/`, поэтому на целевой машине не нужны ни cargo, ни
git-зависимости, ни сеть.

Для целевой Windows-машины:

```powershell
# 1. перенести архив (USB / сетевой шар / etc.)
#    pi-unica-0.13.0-win-x64.tar.gz

# 2. распаковать
#    (внутри каталог pi-unica-0.13.0-win-x64 — его и указываем в pi install)
tar -xzf pi-unica-0.13.0-win-x64.tar.gz

# 3. прокси MCP (единственная сетевая зависимость, ставится один раз)
pi install npm:pi-mcp-adapter

# 4. сам пакет (локальный каталог)
pi install .\pi-unica-0.13.0-win-x64

# 5. в pi: /reload
```

Проверка в сессии pi:

```
mcp({ server: "unica" })   → 11 инструментов
/unica                     → version / binary OK / manifest present / MCP config записан / mcp() available
```

## Сборка архивов

```bash
./scripts/package.sh --all             # оба архива: linux-x64 и win-x64
./scripts/package.sh --target win-x64  # один архив
./scripts/package.sh --universal       # один архив с рантаймами обеих target
```

Версия берётся из `scripts/lib/version.mjs` (пин), а не из аргумента: по
умолчанию собирается `v0.13.0`. Другой тег можно попросить явно —
`--version v0.13.1`, но только вместе с синхронным обновлением пина, иначе
сборка упадёт на версионном барьере.

Для каждой цели скрипт:
1. скачивает `unica-runtime-<target>.tar.gz` с релиза `IngvarConsulting/unica`,
   сверяет SHA-256 архива с метаданными `unica-runtime-<target>.json`, берёт из
   архива `bin/<target>/unica[.exe]` и сверяет его по SHA-256 из тех же метаданных;
2. скачивает и распаковывает четыре движка по `tools.lock.json` (одиночный файл,
   `tar.gz` у rlm-tools-bsl с двумя бинарями, `tar.gz`/`zip` у v8-runner),
   проверяя SHA-256 каждого архива;
3. генерирует `runtime/third-party/manifest.json` (SHA-256 каждого бинаря на диске)
   и `runtime/runtime-manifest.json` (версия ядра, версии движков, происхождение);
4. кладёт результат в `dist/pi-unica-<version>-<target>.tar.gz` и пишет файл
   `.sha256`. Архивы детерминированы (фиксированные mtime, порядок и владелец
   записей).

Локально собранное ядро (вместо релизного) можно положить в архив через
`--build-local` — это работает только для host-цели и требует cargo.

## Проверка

В сессии pi:

```
mcp({ server: "unica" })
```

должно вернуть список из **11 инструментов**:

| Инструмент | Зачем |
| --- | --- |
| `unica.view` | прочитать узел по адресу `at` (замена старым `*.info` / `project.map`) |
| `unica.apply` | запланировать правки (`ops`) и исполнить план по `executionToken` |
| `unica.resolve` | разрешить адрес/набор исходников в конкретный узел |
| `unica.search` | поиск по коду и метаданным |
| `unica.check` | проверка готовности и диагностика |
| `unica.diff` | сравнение состояний |
| `unica.run` | runtime/build-операции (в т.ч. `v8-runner`) |
| `unica.docs` | документация платформы и стандарты |
| `unica.task.get` / `unica.task.result` / `unica.task.cancel` | длительные задания |

Вызов инструмента:

```
mcp({ tool: "unica.check", args: {} })
mcp({ tool: "unica.view", args: { "at": "<sourceSet>:Configuration" } })
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

Список адаптированных скиллов — 55 директорий в `skills/` (полный паритет с
upstream 0.13.0). Примеры в `SKILL.md` используют `mcp({ tool: "unica.*", args: {...} })`,
ссылки `../../references/...` читаются относительно скилла.

В 0.13 upstream скиллы переехали на новый поверхностный набор (`unica.view`,
`unica.apply`, `unica.check`, …); 18 старых скиллов (`cf-info`, `form-add`,
`role-validate`, `v8-runner` и др.) из upstream убраны — их работу закрывают
`unica.view` / `unica.apply` в соседних скиллах.

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

- `unica.run` реально исполняет 1cv8 только там, где установлена платформа 1С;
  на Linux-хосте доступны preview/dryRun. Поверхность инструментов присутствует
  целиком.
- Сетевой адаптер `v8std` (`ai.v8std.ru`) встроен в ядро 0.13 (запросы к нему
  идут на `unica.docs`); без сети работает только локальная документация.
- Запись в конфигурацию идёт через план + `executionToken` (`unica.apply`);
  непроверенных «просто выполнить» вызовов на поверхности 0.13 нет.

## Тесты и сценарии проверки

1. `mcp({ server: "unica" })` → 11 инструментов.
2. Версии: `/unica` показывает `version: pi-unica 0.13.0 / unica v0.13.0` и
   `engines: bsl-analyzer 0.2.86, rlm-bsl-index 1.42.0, rlm-bsl-mcp 1.42.0,
   v8-runner 0.14.0`.
3. Офлайн на фикстуре 1С-воркспейса (`v8project.yaml` + `Configuration.xml`):
   - `unica.check {}` → готовность и диагностика;
   - `unica.view { at: "<sourceSet>:Configuration" }` → корень конфигурации;
   - `unica.apply { at: "<sourceSet>:Configuration", ops: [...] }` → план без записи,
     затем исполнение по `executionToken`;
   - `unica.search` / `unica.diff` / `unica.resolve` на том же наборе.
4. После сторонних движков: `unica.search` по BSL-модулю отдаёт результаты
   (`bsl-analyzer 0.2.86`), `unica.diff` работает.
5. Скиллы `/skill:meta-add`, `/skill:code-search` загружаются; пути
   `../../references/...` читаются.
6. Расширение: при отсутствии бинаря — уведомление; `/unica` показывает статус.
7. SHA-256 проверки и негативные кейсы: испорченный движок → checksum mismatch при
   установке; `runtime/` от другой версии Unica → переустановка `bin/<target>`;
   расхождение `package.json` и `scripts/lib/version.mjs` → ошибка сборки.
8. Windows-цель: `./scripts/package.sh --target win-x64` собирается из Linux
   (все артефакты — загрузки и распаковки, без сборки), внутри `unica.exe` и
   движки `.exe`.

## История версий

- **0.13.0** — переход на Unica v0.13.0: тонкое ядро из релиза + движки по
  `tools.lock.json`, новая поверхность из 11 инструментов, 55 скиллов,
  `runtime/runtime-manifest.json` с пинами, версия в имени архива.
- **0.1.0** — первая версия плагина на Unica 0.12.x (74 инструмента, 73 скилла).
