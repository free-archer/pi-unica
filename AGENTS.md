# pi-unica — инструкции для агентов

pi-плагин, который переносит 1С-возможности [unica](https://github.com/IngvarConsulting/unica)
в клиент [pi](https://pi.dev): адаптированные скиллы, контентные справочники и
Rust-бэкенд `unica`, подключённый через `pi-mcp-adapter` (прокси-инструмент `mcp()`).

Читать до действий: `README.md` (полная картина, флаги, история версий) и этот файл
(инварианты и процедуры). Вендоренный апстрим живёт в `unica/` и имеет свой
`unica/AGENTS.md` — он про разработку самого Unica, не про этот плагин.

## Инварианты

Нарушение любого пункта даёт «зелёную» сборку со сломанным рантаймом, поэтому
это не рекомендации:

1. **`unica/` — вендоренная копия апстрима.** Руками не править. Обновление —
   только заменой каталога целиком по тегу (см. «Обновление версии Unica»).
   Каталог в `.gitignore`, история правок в нём не сохраняется.
2. **`skills/`, `references/`, `runtime/`, `dist/`, `.package-build/` —
   генерируемые.** Правка таких файлов теряется при следующем запуске скрипта.
   Правится источник (`unica/plugins/unica/...` или `scripts/`), затем скрипт.
3. **Версия Unica задаётся в одном месте** — `scripts/lib/version.mjs`
   (`UNICA_VERSION`, `UNICA_CORE_VERSION`). `package.json.version` обязан
   совпадать с `UNICA_CORE_VERSION`: `setup-backend.mjs` и `package.mjs` падают
   на этом расхождении (`assertVersionsAgree`). Не хардкодить версию, тег и
   URL-репозиторий в скриптах — импортировать из `scripts/lib/version.mjs`.
4. **Логика загрузки одна на оба входа.** Скачивание ядра/движков, проверки
   SHA-256, разбор `tools.lock.json`, запись `runtime-manifest.json` живут в
   `scripts/lib/toolchain.mjs`. `setup-backend.mjs` (локальный рантайм) и
   `package.mjs` (архивы) только собирают из этих примитивов; не копировать
   логику в один из них.
5. **Поверхность 0.13 — 11 инструментов.** В любых текстах, скиллах и README
   допустимы только `unica.view`, `unica.apply`, `unica.resolve`, `unica.search`,
   `unica.check`, `unica.diff`, `unica.run`, `unica.docs`,
   `unica.task.get/result/cancel`. Имена `unica.cf.*`, `unica.project.map`,
   `unica.meta.*`, `unica.code.*` и прочие «74 инструмента» — устаревшие;
   запись идёт через план + `executionToken`, адресация — через `at`.
6. **Коммитить `scripts/lib/`.** `runtime/`, `dist/`, `.package-build/`,
   `unica/`, `node_modules/` — build-выход и вендор: в git не попадают.
7. **Цели различаются.** `setup-backend` умеет `linux-x64`, `darwin-arm64`,
   `win-x64`; `package` — только `linux-x64` и `win-x64` (пакуется из Linux без
   кросс-компиляции: все шаги — загрузки и распаковки).
8. **Скиллы не переводятся и не правятся руками.** Они приходят из апстрима
   (`unica/plugins/unica/skills`) через `scripts/adapt-skills.mjs`, который
   делает pi-специфичные замены (frontmatter, `/unica:x` → `/skill:x`,
   `tools/call` → `mcp({...})`). Если в скилле нужна правка — правь адаптер или
   апстрим, не результат.

## Карта репозитория

| Путь | Что это |
| --- | --- |
| `extensions/unica.ts` | Регистрация MCP-сервера в `~/.pi/agent/mcp.json` на `session_start`, команда `/unica` (статус, версия, движение `/reload`) |
| `skills/<name>/SKILL.md` | 55 адаптированных скиллов (генерируются) |
| `references/{platform,specs,tooling,use-cases}` | Контентные справочники (копируются из апстрима) |
| `scripts/lib/version.mjs` | **Пин версии Unica** — единственный источник |
| `scripts/lib/toolchain.mjs` | Ядро загрузки: релиз ядра, движки по `tools.lock.json`, SHA-256, `runtime-manifest.json` |
| `scripts/setup-backend.{sh,mjs}` | Установка `runtime/` для текущего хоста + запись MCP-конфига |
| `scripts/package.{sh,mjs}` | Сборка `dist/pi-unica-<version>-<target>.tar.gz` |
| `scripts/adapt-skills.mjs` | Регенерация `skills/` и `references/` из `unica/` |
| `scripts/generate-manifest.mjs` | Генерация `runtime/third-party/manifest.json` по бинарям на диске |
| `runtime/` | Рантайм: `bin/<target>/…`, `third-party/manifest.json`, `runtime-manifest.json`, маркеры `skills/` + `.mcp.json` |
| `unica/` | Вендоренный апстрим 0.13.0 (Rust-исходники, `plugins/unica/{skills,references,third-party/tools.lock.json}`) |

## Команды

```bash
# Рантайм для текущего хоста (ядро из релиза + 4 движка + манифесты + mcp.json)
./scripts/setup-backend.sh                 # или: --target win-x64 --dry-run и т.п.
./scripts/setup-backend.sh --build-local   # ядро из вендоренного исходника (cargo, только host)
./scripts/setup-backend.sh --force         # переустановить bin/<target> принудительно

# Скиллы и справочники из вендоренного апстрима (идемпотентно, чистит каталоги)
node scripts/adapt-skills.mjs

# Манифест по уже лежащим бинарям (после ручной подмены движка)
node scripts/generate-manifest.mjs linux-x64

# Архивы в dist/ (версия берётся из пина, не из аргумента)
./scripts/package.sh --all
./scripts/package.sh --target win-x64
./scripts/package.sh --universal
```

Полезные флаги: `--dry-run` (план без загрузок), `--version vX.Y.Z` (только вместе
с обновлением пина), `--keep-build-cache`, `--skip-core` / `--skip-engines`,
`--skip-manifest`, `--skip-mcp-config`, `--from-runtime-url <url>`.

## Обновление версии Unica

Порядок, при котором не остаётся полу-обновлённого состояния:

1. `scripts/lib/version.mjs`: `UNICA_VERSION` и `UNICA_CORE_VERSION`.
2. `package.json`: `version` (то же число) и блок `unica`
   (`version`, `releaseTag`, `targets`, `toolSurface`).
3. Заменить `unica/` содержимым нового тега целиком:
   `rm -rf unica && mkdir unica && cp -a <новый-исходник>/. unica/`.
4. `node scripts/adapt-skills.mjs` — перегенерировать скиллы и справочники
   (в 0.13 их стало 55; удалённые апстримом скиллы должны исчезнуть и здесь).
5. `./scripts/setup-backend.sh` — соберёт `runtime/` (старое дерево другой версии
   будет переустановлено) и обновит `runtime/runtime-manifest.json`.
6. Проверить, что изменились только ожидаемые вещи: `git status`, `git diff --stat`.
7. `./scripts/package.sh --all` — архивы с новым номером в имени.
8. При необходимости обновить README: число инструментов, число скиллов, таблица
   движков, раздел «История версий».

Если у апстрима поменялся формат манифеста или стратегия доставки движка
(`direct-release-asset`, `archive-release-asset`, `upstream-archive-release-asset`,
новые `.zip`), правь `installThirdParty` / `fetchUnicaCore` в
`scripts/lib/toolchain.mjs` — и там же, а не в вызывающих скриптах.

## Проверка перед сдачей

Фиктивных «должно работать» здесь нет — проверки запускаются и показывают вывод.

```bash
# 1. Версии и поверхность: serverInfo 0.13.0 + ровно 11 инструментов
cd /tmp && printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | /home/archer/projects/pi-plugins/pi-unica/runtime/bin/linux-x64/unica \
  | python3 -c 'import sys,json
for line in sys.stdin:
    d = json.loads(line)
    if d.get("id") == 1: print("server:", d["result"]["serverInfo"])
    if d.get("id") == 2: print("tools:", len(d["result"]["tools"]))'

# 2. End-to-end на реальной фикстуре (ядро + движки + манифест)
cd unica/tests/fixtures/acceptance/workspace   # затем тот же пробник с вызовом
#    unica.check      → structuredContent.data.status == "passed", ready == true
#    unica.view       → {"at": "main:Configuration"} возвращает узел Configuration
#    unica.search     → matches + fileCoverage.complete == true

# 3. Архивы: распаковать и повторить шаг 1 на распакованном рантайме
tar -xzf dist/pi-unica-0.13.0-linux-x64.tar.gz -C /tmp && ls /tmp/pi-unica-0.13.0-linux-x64/runtime/bin/linux-x64

# 4. Штатные барьеры (должны падать с внятной ошибкой, а не молча)
node -e 'const p=require("./package.json"); console.log(p.version)'   # сверка с scripts/lib/version.mjs
./scripts/setup-backend.sh --target win-x64 --build-local --dry-run   # ошибка: только host-цель
```

Проверка в самой pi — `/unica` (печатает `version: pi-unica <v> / unica <tag>` и
версии движков) и `mcp({ server: "unica" })` → 11 инструментов. Сервер подхватывается
через `/reload`: расширение пишет запись в MCP-конфиг, но текущая сессия конфиг не
перечитывает.

## Подводные камни 0.13

- Релизный `unica-runtime-<target>.tar.gz` **тонкий** (12 МБ): внутри только
  `bin/<target>/unica[.exe]` и `third-party/manifest.json`. Наличие движков в
  архиве — заслуга `installThirdParty`, а не апстрима. Не «упрощай» упаковщик до
  копирования релиза.
- `v8-runner` для Windows — **`.zip`** (`v8-runner-windows-x86_64.zip`), для
  Linux/macOS — `.tar.gz` из чужого репозитория (стратегия
  `upstream-archive-release-asset`). Распаковщик обязан понимать оба формата.
- `rlm-bsl-mcp` и `rlm-bsl-index` — **байт-идентичные** файлы из одного архива
  `rlm-tools-bsl-*`: одинаковый SHA-256 в манифесте — это нормально, не «ошибка
  копирования».
- Кэш загрузок ключуется версией (`<version>-<assetName>`, `<version>-unica-runtime-<target>.tar.gz`):
  без этого разные релизы сталкивались бы на одинаковых именах ассетов. После
  смены версии кэш можно чистить, но он не мешает — SHA всё равно перепроверяется.
- `runtime-manifest.json` — источник истины о том, для какой версии собран
  `runtime/`. Нет файла, а бинарники есть → дерево считается до-0.13 и
  переустанавливается целиком. Не «сохраняй» старые бинарники руками.
- `--build-local` работает только для host-цели; для `win-x64` из Linux это
  ошибка (иначе Linux-бинарник уехал бы как `unica.exe`).
- `pi-mcp-adapter` — обязательная зависимость для `mcp()`; без него `/unica`
  напишет `MCP config: записан`, но прокси-инструмента в сессии не будет.
- Путь к MCP-конфигу: `$PI_CODING_AGENT_DIR/mcp.json`, иначе `~/.pi/agent/mcp.json`.
  Абсолютный путь к бинарнику в конфиге — норма (в архиве он указывает на распакованный каталог).

## Стиль

- Скрипты — ESM (`*.mjs`), без внешних зависимостей: только `node:fs`, `node:crypto`,
  `node:child_process`, глобальный `fetch` (Node ≥ 20). Тяжёлые шаги — через
  `spawnSync` с проверкой кода возврата (`run()`).
- Общий код — в `scripts/lib/`, общие константы целей — `TARGET_TRIPLES` и
  `THIRD_PARTY_TOOLS` оттуда же.
- Комментарии и код — по-английски; README, AGENTS.md и тексты для пользователя —
  по-русски. Скиллы и справочники — как в апстриме (русский), без ручной правки.
- Ошибки формулируются как инструкция («что сделать»), а не как факт («не найдено»):
  см. `assertVersionsAgree` и сообщения `setup-backend`.

## Чего здесь нет

- Юнит-тестов и линтеров нет: проверка — прогон скриптов и пробники выше.
  Не выдумывай `npm test` — его нет в `package.json`.
- Плагин не переписывает backend на TypeScript: `unica` остаётся Rust-сервером,
  расширение только регистрирует его и показывает статус.
