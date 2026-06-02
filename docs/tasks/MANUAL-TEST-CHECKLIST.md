# Manual / Playwright Test Checklist

> Покриває те, чого **не ловлять** unit (`pnpm test`) та integration
> (`pnpm test:integration`) тести: реальний Obsidian-UI, mobile/Capacitor,
> layout-залежну поведінку CodeMirror (геометрія — wrap, PgUp/PgDn, vertical
> nav), фізичні збої (low-memory kill, battery die), і наскрізні sync-flow на
> справжньому GitHub очима користувача.
>
> **Як користуватись:** прогнати релевантні секції перед release (особливо
> `-beta` на mobile). Позначати `[x]` пройдене, нотувати версію/платформу/дату.
> Баг → завести issue + (де можливо) додати unit/integration тест, щоб він
> більше не потрапляв сюди.
>
> Легенда: 🖥️ desktop · 📱 mobile (iOS/Android) · 🌐 потрібен реальний GitHub ·
> ⏳ feature ще не зібрана в `main.js` (тестувати, коли з'явиться).

---

## §1. Платформи та збірка

- [ ] 🖥️ `pnpm build` зелений; `main.js` вантажиться в Obsidian (desktop) без помилок у консолі.
- [ ] 📱 Плагін **вмикається** у списку community-plugins на iOS і Android **без краху**
  (regression-чек: жодного `require("fs")`/`require("path")` на file-scope у `main.js` —
  `grep -E '=require\("fs"\)|=require\("path"\)' main.js` має давати 0).
- [ ] 📱 `styles.css` застосовується (теми світла/темна).
- [ ] 🖥️📱 Перемикання desktop ↔ mobile vault (один і той самий repo) — синхронізація узгоджена.

## §2. Sync core — наскрізні flow (🌐 реальний GitHub)

- [ ] 🖥️ **Bare repo bootstrap:** перший sync у порожній repo створює структуру, `.gitignore`, snapshot-manifest.
- [ ] 🖥️ **Adoption:** перший sync проти НЕ-порожнього repo — без дублікатів/втрат, конфлікти класифіковані.
- [ ] 🖥️ **Incremental:** правка → `[Sync]` → коміт+push; видалення файлу → відображається на remote.
- [ ] 🖥️ **Pending-deletions:** видалити файл, sync — на remote зник; на іншому пристрої pull прибирає локально.
- [ ] 🖥️ **`syncStartsWithCommit=false`:** `[Sync]` лише drain; `[Commit]` ribbon / `commit-local` команда комітить окремо.
- [ ] 🖥️ **Interval scheduler:** періодичний tick синхронить; startup-pulse при відкритті vault.
- [ ] 🖥️ **Ribbon + status-bar:** іконки sync/commit, лічильник конфліктів 🔀, статус «Syncing…/idle/Last error».
- [ ] 🖥️ **Push-queue persistence:** sync, вбити Obsidian під час push → перезапуск дорешає чергу (recovery sweep).
- [ ] 🖥️ Великий vault (1000+ файлів) — sync не блокує UI (worker-orchestra off-main-thread).

## §3. Mobile-специфічне (📱 — Capacitor не тестується unit-ами)

- [ ] 📱 **Capacitor rename:** конфлікт-резолюція / atomic-write не падає на «Destination file already exists»
  (iOS/Android `rename` не перезаписує — має бути remove-before-rename).
- [ ] 📱 **Binary файли** (png/pdf) синхронізуються без корупції (read/writeBinary, не text-path).
- [ ] 📱 **Token з trailing whitespace** (вставка з suggestion-bar) — `loadSettings` self-heal або trim onChange; sync працює.
- [ ] 📱 **Low-memory kill:** під час редагування/sync ОС вбиває Obsidian → перезапуск: vault консистентний, recovery sweep відпрацював.
- [ ] 📱 **Battery die** (<1%, вимкнення) під час sync → перезапуск без корупції/0-byte файлів.
- [ ] 📱 Touch: ribbon/settings/conflict-list кліки працюють як на desktop.

## §4. Conflict resolution (pseudo-merge) наскрізно (🌐)

- [ ] 🖥️📱 Два пристрої правлять той самий файл → конфлікт: створюється sibling `*.conflict-from-<device>-<ts>.*`.
- [ ] 🖥️ Конфлікт-лічильник 🔀 у status-bar оновлюється (event-driven).
- [ ] 🖥️ Auto-merge: несуперечливі зміни зливаються (3-way), суперечливі → sibling.
- [ ] 🖥️ Edit-while-in-conflict: правка base під час наявного sibling — не губиться.
- [ ] 🖥️ Pre-Sync conflict modal показує к-сть, дозволяє підтвердити.
- [ ] 🖥️ Зведення sibling до base (SHA-match) → sibling прибирається на drain (Phase A/B).
- [ ] 🖥️ Multi-device rotation (G-series сценарії) вручну на 2+ пристроях.

## §5. Diff-editor widget (⏳ коли зібрано в `main.js` — Phase 6 entry-points)

> Модель (§1) повністю покрита unit-ами (`tests/diff2/`); тут — **layout-залежне**
> (геометрія CodeMirror, happy-dom не може) і наскрізний UX.

**Layout / геометрія (Playwright або ручний девайс):**
- [ ] **Wrap:** рядок 200 символів при вузькому редакторі (~30 кол.) загортається; `↵`-гліф **лише** на реальному `\n`, continuation-рядки — порожній gutter (один номер).
- [ ] **Вертикальні стрілки** по загорнутому довгому рядку рухаються по візуальних рядках (не перестрибують рядок).
- [ ] **PgUp/PgDn** на великих ver-блоках (10+ рядків) — коректне прокручування/позиція.
- [ ] **Ctrl+Home / Ctrl+End** — на перший/останній рядок; перевірити коли перший — **прихований порожній ver1**, останній — **прихований порожній ver2** (мають проявитись/активуватись коректно).
- [ ] **Home/End** на загорнутому рядку — початок/кінець візуального vs логічного рядка.
- [ ] **Empty-ver activation:** [down] з normal над порожнім ver1 → тимчасовий порожній рядок з'являється; ще раз [down] без вводу → зникає, перехід у ver2 (§1.8). [up] з ver2 — дзеркально.
- [ ] **Markers:** `<<<<< / ===== / >>>>>` рендеряться як block-widget'и; кнопки `[apply]/[remove]/[both]/[neither]/[join]` клікабельні; deviceLabel у top/bottom.
- [ ] **Кольори:** ver1 червоний, ver2 зелений, word-level жовтий overlay (orange/salad мікс).
- [ ] **EOL-less same-line edge** (base `"abc"` / sibling `"XYZ"`): не падає, маркери на межах рядка (не mid-line).

**UX наскрізно:**
- [ ] Відкриття через entry-points (Phase 6: file-menu `Resolve conflict`, diff ribbon-іконка, post-sync modal).
- [ ] Резолюція: apply/remove/both/neither + hotkeys (`Ctrl+Enter/Backspace/Shift+Enter/Shift+Backspace/Shift+.`).
- [ ] **`[← Back]`** комітить base, прибирає sibling при SHA-match; повертає у список.
- [ ] **`[×]`** tab-close скидає сесію; vault у стані до редагування.
- [ ] **Single-tab invariant:** клік на інший конфлікт під час активної сесії → Notice «close current first».
- [ ] **Delete-to-EOL (Ctrl+K)** — наразі НЕ прив'язано (не в defaultKeymap); якщо очікується — додати + перевірити.
- [ ] **select-all + delete** → `[← Back]` зберігає `"\n"` (не 0-byte; не тригерить §2.9 restore).

**Autosave / recovery (⏳ Stage 3 / Phase 5):**
- [ ] Редагувати, вбити Obsidian → перевідкрити конфлікт → recovery dialog `[Continue editing]` відновлює стан + cursor ≈ де був; `Ctrl+Z` йде назад по chunk'ах.
- [ ] `[Start over]` — чистий старт із vault-стану.
- [ ] Vault змінився під час сесії (sync2 pull) → snapshot-mismatch dialog (restore-old / discard / cancel).
- [ ] TOCTOU на `[← Back]` (vault змінився) → modal save-to-alt / force / cancel.

## §6. Settings & lifecycle (🖥️📱)

- [ ] Token/owner/repo/branch trim onChange; невалідні → зрозуміла помилка (не тихий 404).
- [ ] Connection-probe (Settings) працює, не чіпає plugin-state.
- [ ] **Reset modal** (ввести RESEXT-фразу) — wipe token/repo/history/queue/conflicts; локальні файли НЕ чіпаються; sibling'и → `.unresolved`.
- [ ] `syncConfigDir` toggle — `.obsidian/*` синхронізується/ні відповідно.
- [ ] `deviceLabel` зміна — нові коміти з новим суфіксом `(label)`.
- [ ] Repo switch — стан скидається коректно.
- [ ] `maxAutoMergeSizeBytes` (Performance) — великі файли не авто-мержаться.
- [ ] Token expiry (401/403) → token-expired modal (Stage 7 recovery dialog).

## §7. Self-update (🖥️📱)

- [ ] Оновлення плагіна через себе: self-update marker protocol (SYNC2 §12); після оновлення плагін перезапускається.
- [ ] 📱 Mobile auto-reload (disable+enable) після self-update — без ручного втручання.

## §8. Crash / recovery / edge (🖥️📱)

- [ ] Crash між 3-step/5-step atomic-write кроками → recovery sweep на onload дорешає (forward-complete).
- [ ] **Zero-byte restore guard (§2.9):** файл з контентом випадково став 0-byte → відновлюється остання добра версія, 0-byte не йде на сервер.
- [ ] 422 BadObjectState на deletion-entry → self-resolve через reconcile-empty (≈17 хв) АБО fail-fast (перевірити поточну поведінку).
- [ ] Out-of-band drift (інший інструмент змінив repo) → reconcile коректний.
- [ ] Plugin reload (disable→enable) під час drain — без подвійного запуску/корупції.

## §9. Performance (📱 — `pnpm test:perf` opt-in, але mobile benchmark ручний)

- [ ] **Mobile append benchmark** (DIFF-EDITOR.md §6, Settings → «Run mobile autosave benchmark»):
  прогнати на Android (mid-tier) + iOS; зібрати p50/p95/p99 для single-append / batched / cursor-rewrite;
  надіслати dump → налаштувати coalesce-вікно (§2.8) і cursor-timer (§2.9).
- [ ] Великий конфлікт (сотні chunk'ів) у diff-editor — рендер/резолюція не лагає на mobile.

---

**Підтримка:** оновлювати при додаванні фіч, які не покриваються автотестами.
Коли feature з ⏳ стає зібраною — зняти позначку і додати в release-чек.
