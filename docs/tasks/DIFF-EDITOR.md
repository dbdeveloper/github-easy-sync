# DIFF-EDITOR — детальна специфікація

> Канонічний документ R7.7 (документ-модель + поведінка редактора), R7.7.a
> (intra-session autosave / REDO-log + cursor-timer) і R7.7.b (recovery dialog),
> а також cleanup-правил, mobile-perf benchmark і round-trip інваріантів.
>
> [`DIFF2_IMPLEMENTATION_PLAN.md`](../DIFF2_IMPLEMENTATION_PLAN.md) тримає
> лише **cross-subsystem інтерфейси** (директорійна розкладка, що переживає
> crash, тригери cleanup, phased-rollout у `R9.1`) і вказівник сюди. Уся
> внутрішня механіка diff-editor — у цьому документі.
>
> Cross-references: [`PSEUDO-MERGE-MODE.md`](../PSEUDO-MERGE-MODE.md) §4.4
> (preserve-all-commits — durable archive **між** sync-кліками). DIFF-EDITOR
> покриває принципово **інший** рівень — intra-session, intra-chunk undo
> всередині одного відкриття DiffPane, який жодного `[Sync]` ще не бачив.

## Зміст

- §1. Документ-модель і поведінка редактора (R7.7 core)
- §2. R7.7.a — Persistent autosave (REDO-log + cursor-timer)
- §3. R7.7.b — Recovery dialog
- §4. Cleanup / TTL (три умови видалення)
- §5. R7.7.c / R7.7.d — interfaces (короткий референс)
- §6. Mobile append benchmark — test button у Settings
- §7. Тестовий план
- §8. Open questions / TBD

---

## Стан імплементації (оновлено 2026-06-02)

Ретрофіт на гілці `diff2`, **§1-model-first** (порядок виправлено: модель §1 —
**передумова** 7-step commit, бо shipped `diff-chunks` side-field десинхронізувався
на вільних edit'ах і `split(editorDoc)` був несоундним).

**Stage 1 — модель §1:**

- ✅ **1a** — `src/diff2/joined-doc.ts`: `build`/`split` (`\0`-термінатор, `\1`-роздільник),
  collision fail-closed (§1.3). Round-trip byte-exact (§1.5).
- ✅ **1b.0** — `src/diff2/editor-model.ts`: чистий CM6-doc + впорядкований `Segment[]`,
  що мапиться через **кожну** транзакцію (`mapStructure`, assoc-правило §1.8.a). Шов
  `toEditorModel`/`fromEditorModel` поверх 1a.
- ✅ **1b.1** — `diff-pane.ts` на новій моделі: structure-based рендер (маркери/фарбування/
  word-diff), sibling-wins gutter (`line-numbers.ts`, §1.10), chunk-actions як doc-edit'и,
  sentinel `transactionFilter` (§1.3 edit-time), collision-check у в'ю. `getResolvedBase()`
  = `split(...).base`. Мертву `diff-chunks`-модель видалено.
- ✅ **1b.2** — sentinel `transactionFilter` (вкл. у 1b.1): блок вставки `\0`/`\1`.
- ✅ **1b.3** — selection rules §1.7 (`selection-rules.ts`): фільтр легалізує виділення
  (anchor у ver → clamp; normal→ver head → snap за межі групи); Ctrl/Cmd-A у ver →
  лише блок. Collapsed каретка не чіпається.
- ✅ **1b.4a** — активація порожніх ver §1.8.a: `activeEmptyVer` стан + marker `data-action`
  (focus-ver1/ver2 лише коли порожній) + клік→активація + `EmptyVerActiveWidget`. Typing
  росте активований ver; clear на content-gain / caret-leave.
- ✅ **1b.4b** — keyboard «стоп на порожньому ver» при стрілках §1.8 (`diff-pane.ts`
  `emptyVerArrowNav` + `findEmptyVerSkipped`): plain ↑/↓ зупиняється на порожньому ver
  (геометрія делегована `view.moveVertically` → wrap-aware); вхід ставить колонку 0 + reuse
  `activeEmptyVer`/widget (1b.4a); повторна стрілка лишає блок. Pure-вирішувач + state-переходи
  тестовані; фінальний geometry-крок — manual (happy-dom без layout).
- ✅ **1b.5** — auto-collapse §1.6 (`collapseGuard` у `diff-pane.ts`): вільний edit, що робить
  `ver1==ver2` byte-exact, дописує колапс у ТУ Ж транзакцію (`[tr, spec]` + `setDiffPaneState`):
  обидва порожні → remove (`neither`); однаковий непорожній → apply ver1 (`ours`). Combined →
  single Ctrl+Z (коли з'явиться history у Phase 5).
- ✅ **1b.6a** — гліф `↵` §1.6.a.1 (`decorations.ts` + `NewlineGlyphWidget`): ghost-`↵` на
  кінці кожного рядка крім останнього (= на кожному реальному `\n`); не в doc, не копіюється.
  CSS `.diff2-newline-glyph`.
- ✅ **1b.6b** — normalization §1.6.a.2 (`diff-pane.ts`): `normalizeGuard` (focus-leave) дописує
  `\n`, коли каретка покидає непорожній ver-блок без trailing `\n`, що не останній у документі
  (combined-transaction); + apply-time нормалізація в `relayout` (`normalizeItems`). Останній
  елемент документа лишається EOL-less. Запобігає злиттю контенту при split (correctness).
- ✅ **1b.7** — hotkeys §1.9 (`diff-pane.ts` `hotkeys()` + `hotkeyTarget`): `Ctrl+Enter` apply,
  `Ctrl+Backspace` remove, `Ctrl+Shift+Enter` both, `Ctrl+Shift+Backspace` neither,
  `Ctrl+Shift+.` join (md-only). Активні лише коли каретка у ver-блоці (інакше inert).

  **✅ Stage 1 ЗАВЕРШЕНО ПОВНІСТЮ** — модель §1 + уся поведінка редактора, **без відкладань**
  (1b.4b теж зроблено). Усі §1.1–§1.10 реалізовані.

**Stage 1.h — review hardening** (deep multi-agent review + TDD): кожна знахідка спершу стала
тестом (`tests/diff2/stage1-review-findings.test.ts`), тоді фікс:

- **(A)** auto-collapse `collapseGuard` — `[tr,spec]` резолвив у original-coords (CM6
  `mergeTransaction(sequential=false)`) → **RangeError на grow-collapse / desync на delete**.
  Фікс: один spec через `tr.changes.compose(collapseCS)`.
- **(B)** commit-boundary **fail-closed**: `fromEditorModel` асертить, що structure тайлить
  `[0,doc.length]` (gap/overlap → throw), `getResolvedBase()` всередині try/catch у в'ю →
  весь клас silent-corruption (multi-cursor, boundary-edits) стає гучною помилкою.
- **(E)** commit-boundary **нормалізація** §1.6.a.2 у `fromEditorModel` (не лише focus-leave) →
  `[← Back]` без виходу каретки більше не зливає контент; focus-leave-guard демоутнуто до
  візуальної зручності.
- **(D)** `resolveText` "both" — guard `v1.endsWith("\n")` (як `joinBlockquoteText`) → EOL-less
  ver1 не зливається з ver2.
- **(C)** `buildDecorationSet` `pushBlock` — block-widget'и лише на межі рядка → EOL-less
  same-line ver1/ver2 не дає mid-line widget.

**Stage 1.t — chaos/coverage hardening** (exhaustive edge-probing + TDD):

- **Boundary-insert bug (finding B deeper root):** `mapStructure` губив текст, вставлений на
  межі сегмента (друк на поч. документа). Фікс: `growSegmentIndex`/`growIndexFor` нарощують
  сегмент, що містить позицію edit'у (спільні для field+collapseGuard).
- **#3 empty→`\n`:** `getResolved` повертає `"\n"` для порожньої сторони (не `""`) — base/sibling
  diff2 завжди мали контент, тож 0-byte тригернув би SYNC2 §2.9 zero-byte-restore (відкотив би
  видалення). `"\n"` = канонічний мінімальний непорожній файл (узгоджено з `normalizeText`).
- **defaultKeymap + history + undo/redo:** додано `defaultKeymap` (delete-line, word-arrows,
  Home/End, PageUp/Down, Backspace/Delete/Enter) + `history({newGroupDelay:0})` + `historyKeymap`;
  мої Prec.high keymap'и (Mod-a, ↑/↓, Ctrl+…) виграють. **`structureHistory`** (`invertedEffects`)
  версіонує structure-field на undo/redo — інакше undo chunk-action/collapse відкочував би doc,
  а structure лишалась би resolved (desync). Покрито інтеграційними тестами (undo-redo.test).
- **Normal-normalization fix:** §1.6.a.2 нормалізація тепер **тільки** для ver-блоків (commit) і
  для **резолвленого** item (`ensureNlIfFollowed`); pre-existing normal-сегменти не чіпаються
  (інакше collapse групи між двома normal давав зайвий порожній рядок — знайдено через
  variant-3 replace тест).
- **Покриття:** довгі рядки/великі доки (10×200 ver, 300 рядків) + **250-step seeded fuzz**;
  selection-shapes §1.7 (multi-line у ver, cross-boundary); sentinel-guard edit-time; Ctrl+A
  (block vs whole-doc); leading/trailing empty-ver на межах доку; undo/redo (free edit,
  chunk-action, collapse single-undo, variant-3 replace).

*Поточний стан редагування:* live + безпечне + повна §1 модель (selection §1.7, sentinel §1.3,
auto-collapse §1.6, гліф `↵` §1.6.a.1, normalization §1.6.a.2 + **commit-boundary**,
hotkeys §1.9), **fail-closed на коміті**, **empty→`\n`**. DiffPane ще НЕ вбудований у бандл
(`main.js` не змінюється; Phase 6 entry-points).

**Відкрите перед Phase 6:** `defaultKeymap`+`history` **додано** (вище). Лишається
**layout-залежне** (happy-dom не може) → у **manual/Playwright чек-лист**: PgUp/PgDn/Ctrl+Home/End
навігація (зокрема на приховані порожні ver на межах), реальний wrap 200-симв. рядка при ширині
30, Home/End на загорнутих візуальних рядках, delete-to-EOL (Ctrl+K — не в defaultKeymap, поки
не прив'язано). Чек-лист — **для всього плагіна** (не лише редактора), окремий док для manual-тестерів.

**Послідовність далі — переглянуто (chicken-and-egg):** 7-step commit залежить від
autosave-каталогу (`done.json` у `.diff2-autosave/<id>/`, TOCTOU звіряє `meta.baseShaAtStart`,
recovery сканує каталог), який створює session-start протокол. Тому спільний фундамент —
**окремо й першим**; 7-step і live-autosave обидва на ньому (можна паралельно). history-log/cursor
самому коміту НЕ потрібні — лише meta+snapshots+done.json.

- **Stage 2.0 — autosave-каталог фундамент (спільний): ✅ ЗРОБЛЕНО (2026-06-02).**
  `src/diff2/autosave-store.ts` — `fnv1a64` (lane-based 64-bit на звичайних числах: tsconfig
  target=ES6 не має BigInt-літералів, тож 4×16-біт лімби; коректність пінять published-вектори)
    + `deriveAutosaveId(kind,p1,p2)` (§2.4.1: sort+`\0`+16-hex, детермінований+симетричний) +
      `trackedAutosaveId` + `startSession` (§2.5.a: mkdir → snapshots → cursor → порожній history →
      **meta LAST** через `atomicWriteFile`+`calculateGitBlobSHA`) + `readMeta` + `classifyOpen`
      (§2.5.b — **лише detection**, повертає `fresh|reuse|mismatch`; recovery-дія та cleanup — Stage 3).
      `joinAlgoVersion`/`joinAlgoOptions` (Stage 2.0; **пізніше замінено на `joinedDocSha`** — 3b-1). Greenfield (не wired у
      main.js, як trash 9a). Тести: `autosave-id` (12, FNV-вектори+властивості), `autosave-session-start`
      (9, протокол+classifyOpen), `crash-resilience/autosave-session-start-crash` (6, per-step kill →
      **meta-last інваріант**: meta present ⇔ сесія повна; на будь-якому crash → reopen="fresh").
      diff2 набір 434, повний 1168, build зелений.
- **Stage 2.1 — 7-step pair-atomic commit: ✅ ЗРОБЛЕНО (2026-06-02).**
  `src/diff2/exit-commit.ts` (greenfield tested core; НЕ wired у view — §5.0.e modal,
  Step 0 `committing`-guard, Step 8 detach/historyClear, startSession-at-mount = Phase 6;
  наївний `exit-protocol.ts` лишається до того wiring). `commit7Step` — §5.0 кроки 2–7:
  `done.json` barrier (atomic, хешує ТІ САМІ байти, що стейджить) → stage обидва `.sync-tmp`
  (parallel) → originals→`.sync-bak` (**SEQUENTIAL by design** §5.0.b E/F) → `.sync-tmp`→final
  (**SEQUENTIAL** H/I) → drop bak → 6.5 proactive sibling-cleanup (gated `target===meta.siblingPath`
  ⇒ save-to-alt пропускає) → rmdir. `targetBasePath/targetSiblingPath` default=meta; Step 4
  self-skip для неіснуючого target ⇒ new-file і save-to-alt уніфіковані (alt-naming — Phase 6).
  `classifyToctou` — Step 1.5 detection-only (`ok|mismatch`+flags+SHAs; modal — Phase 6).
  `recoverCommit` — §5.0.a/b як **чиста функція стану диска**: SHA-класифікація трьох слотів
  кожної сторони (`old|new|foreign|tmpNew|tmpTorn|absent`) → 3-way dispatch (обидва hasNew →
  **forward** D–K; foreign final → **fallback**; інакше A–C → **rollback**, сесія виживає;
  no done.json → no-commit). **§5.0.b 11-рядкова матриця реалізована саме цим dispatch'ем —
  він доказово відтворює дію кожного рядка** (не 11 окремих хендлерів). Тести: `exit-commit`
  (8: happy desktop+mobile, identical→6.5, save-to-alt, done.json hash-consistency, TOCTOU),
  `crash-resilience/exit-commit-recovery-matrix` (17: hand-craft кожен A–K + foreign-fallback +
  6.5-in-recovery + no-commit + injection→row-H + mobile row-D/foreign).
  **Гарантія: коміт АТОМАРНИЙ** (crash ⇒ обидві сторони або жодна; A–C лишають originals) —
  але **редагування ще НЕ crash-safe**: rollback повертає до session-start байтів, бо
  `history.jsonl` replay лише у Stage 3.
  **Carry-forward зі Stage 2.0-review (статус):** (1) `classifyToctou`/`classifyOpen` **кидають**
  на зниклому файлі — **ВИРІШЕНО свідомою консистентністю** (той самий вибір, документовано в
  header; Phase-6 caller робить `try/catch`); (2) `reuse` re-check наявності snapshot-файлів і
  (3) «start over» `rmdir` ПЕРЕД `startSession` — **Stage 3** (не 2.1); (4) orphan `.sync-{tmp,bak}`
  без meta — `AtomicWriteRecovery.sweep` (Phase 11). recoverCommit closure доведено лише над
  crash-reachable станами (bak ⇒ обидва tmp✓ ⇒ forward, тож rollback-рядки bak-free).
- **Stage 3 — live autosave: ✅ ЗРОБЛЕНО (2026-06-02).** REDO-log `history.jsonl` (§2.6–§2.8) +
  cursor (§2.9) + replay/assess (§3) + cleanup (§4.2). «REDO» = forward-replay, НЕ CM6-`redo()`.
  Тестовані ядра; реальні таймери (§2.8/§2.9 debounce), модалки (§3.2/§3.2.a), onload-trigger
  (§4.2/§5.0.a iteration) — Phase 6/11.
    - **Gate-спайк:** `history-replay-structure-spike` довів, що ChangeSet-only replay НЕ відновлює
      Rep-A structure → **format B** (structure у кожному блоці). §2.6 reconciled.
    - **3a:** `history-log.ts` — `fnv1a32` + `{seq,at,change,structure,sum}` serialize/parse/verify +
      `HistoryWriter` (queue/flush/cap + `replayDispatch` annotation). 13 тестів.
    - **3b-1:** `joinedDocSha` meta-міграція (прибрано `joinAlgoVersion`) + `classifyReopen` (§3.1:
      `resume|library-drift|vault-changed|corrupt|sentinel|fresh`; single-read інваріант; snapshot-
      integrity закриває Stage-2.0-review #2).
    - **3b-2:** `history-replay.ts` — `scanHistory` (єдине джерело trustworthy-prefix) + `assessHistory`
      (§3.5) + `replayHistory` (§3.3, structure напряму з блоку, `replayDispatch`); **undo-after-replay**
      fidelity доведено оракулом «replay N → undo k == replay N−k». 11 тестів.
    - **3b-3:** `cursor-store.ts` — persist (atomic safeRename) / read (degrade→null) / clamp (§2.9). 11.
    - **3c:** `autosave-cleanup.ts` — §4.2 `classifySweep` (7 умов + done.json→defer-to-commit; vault-
      changed НЕ свіпиться) + `sweepAll` (idempotent §4.3). 13.
    - **Стрес:** `history-replay-stress` (100KB/20-груп, replay==live + split-correctness: normal→обидва,
      ver2-only→sibling, resolve→обидва).
    - **Stage-1.x (B) ✅:** §1.7 Variant-3 free-edit резолв (§1.7.a(0)) — ВИПРАВЛЕНО
      (`detectSpanningResolve`/`rebuildSpanningResolve` + tiling-assert). + доказ
      save/reopen byte-стабільності (`save-reopen-stability.test.ts`; `build∘split≠identity`
      — benign внутрішня метрика, не save/reopen-проблема за §1.5).

Stage 2.1 та Stage 3 спираються на 2.0; порядок між ними вільний.

**Phase 6 / Stage W1 — WIRED у живий view ✅ (2026-06-04).** Greenfield-модулі
2.0/2.1 більше не «на полиці» — `DiffEditView` тепер веде реальний autosave/commit:

- **W1a (pre-existing):** `DiffPane.getResolved()` уже мав empty→`\n` guard на обидві
  сторони; `getResolvedBase()` делегує.
- **id-helper:** `autosaveIdForEntry(entry)` (`synthetic-detector.ts`) — двогілковий
  (tracked→`trackedAutosaveId(record.id)` / synthetic→`deriveAutosaveId`), єдиний для
  mount+reopen. Тест `autosave-id-for-entry`.
- **onload recovery driver:** `recoverAutosaveDirs(vault)` (`onload-recovery.ts`),
  викликається в `initSync2` **ПЕРЕД** `AtomicWriteRecovery.sweep` (commit7Step стейджить
  через ті самі `.sync-{tmp,bak}` суфікси — лише `recoverCommit` done.json-coordinated
  відновлює ПАРУ атомарно). Filesystem-driven (id = ім'я каталогу), тож resolved-mid-crash
  tracked-конфлікт усе одно відновлюється. `sweepAll` GC'ить §4.2-stale → `defer-to-commit`
  → `recoverCommit`. Тест `onload-recovery` (keep/sweep/defer routing + rollback-preserves).
- **mount:** `startSession` при відкритті detail (§2.5.a). W1 без resume-діалогу — prior dir
  discard+fresh (history ще нема), АЛЕ done.json-каталог НЕ чіпається (bail; recovery owns).
- **exit (`[←]`):** `executeExitProtocol`→`classifyToctou` (abort-stay на mismatch; modal=W5)
  →`commit7Step`. e2e `diff-edit-view-commit` (converge→sibling cleaned+dir torn down;
  non-converged→both written; base-rewritten→TOCTOU mismatch+dir survives).
- **Наївний `exit-protocol.ts` ВИДАЛЕНО** (W1 swap замінив єдиного викликача).

**Phase 6 — стан (2026-06-04):** W1 ✅ (onload recovery + 7-step commit), W4 ✅
(W4a replay-core; W4b модаль; W4c `classifyReopen`-wiring A–D + **симетричний §3.2.a**),
W2 ✅ (per-transaction history-feed → recovery-replay тепер **ЖИВИЙ**),
**W5 ✅** (§5.0.e симетричний `[← back]` TOCTOU: one-side тихий `commitUnchangedSide`+log;
both → `SaveToAltModal`+`commitToAlt`, fail-closed на існуючому імені; force-overwrite прибрано
— `exit-commit.ts`+`recovery-dialog.ts`, dispatch `resolveToctouExit`),
**W3 ✅** (§2.9 cursor 2-слот ping-pong: `cursor-store.ts` read-both→write-stale-slot/max-seq-read,
`startSession` пише `cursor-a` seq0, `classifySweep` cond-3 = a OR b; `cursor-timer.ts`
`CursorScheduler` throttle 2500/6000 + `DiffPane.onSelectionChange` feed; wire у `DiffEditView`
— stop при `exit` ПЕРЕД commit-await),
**Step-0 ✅** (committing re-entrancy guard у `exitDetailView`, try/finally-скид),
**Step-8 ✅** (return detail→list; CM6-history чиститься через `view.destroy()` при dispose —
`historyClear` API не існує й не потрібен; doc §5.0 Step-8 виправлено). **Лишилось:**
entry-points (file-menu, diff-ribbon, **status-bar TODO §6-7**, post-sync modal) + Phase 7/8/9b/10/11.

**Manual/Playwright покриття** (layout-залежне + mobile + наскрізний UI, чого не ловлять
автотести) — у [`docs/MANUAL-TEST-CHECKLIST.md`](../MANUAL-TEST-CHECKLIST.md) (English, для всього плагіна).

**Ратифіковані рішення:** DEFAULT `diffLines`, не `newlineIsToken` — інакше ламає §1.2;
line-wrap завжди ON ⇒ `↵` скрізь (§1.6.a); sibling-wins нумерація (§1.10). (Версію diff
у `meta.json` НЕ зберігаємо — replay-валідність гарантує `joinedDocSha`, §2.5.)

**Phase 5/6 prep — autosave-значення ЗАПІНЕНО бенчмарком (Android mid-tier, 2026-06-03):**
`history append single p95 = 3.10 ms` → §6.2 band `<10ms` → **history.jsonl per-transaction,
БЕЗ coalesce** (§2.8). `cursor rewrite p95 = 28.01 ms` → band `20–80ms` → **cursor-timer
2500 ms active / 6000 ms navigation** (§2.9). Бенчмарк-кнопку з Settings прибрано (своє
відпрацювала). Wiring (Phase 6) стартує на цих значеннях.

**Cursor persistence — 2-слот ping-pong, РЕАЛІЗОВАНО W3 (2026-06-04, §2.9):** замість
atomic temp+rename (`rename` p95≈28ms + zero-cursor вікно) — `cursor-a.json`/`cursor-b.json`
з монотонним `seq`. `persistCursor` читає ОБИДВА слоти → пише **стейл (lower-seq)** слот простим
`adapter.write` (≈3ms); `readCursor` бере **max валідний `seq`** (torn-слот не парситься → інший
виграє). **Інваріант crash-safety:** max-seq слот (recovery-fallback) НІКОЛИ не перезаписується —
plain write безпечний саме тому. `startSession` пише `cursor-a` (seq 0); `classifySweep` cond-3 =
`cursor-a` OR `cursor-b` (нема обох → sweep). Cadence — `cursor-timer.ts` `CursorScheduler`
(throttle, не debounce: typing 2500 / nav 6000); `DiffPane.onSelectionChange` живить nav-сигнал,
`onRecord` — typing; `DiffEditView` зупиняє таймер ПЕРШИМ рядком `exitDetailView` (до commit-await).

---

## §1. Документ-модель і поведінка редактора (R7.7 core)

### §1.1 Що це і чому це можна зробити просто

**DiffPane** оперує одним віртуальним документом, який, фактично, складається з
об'єднаних по рядкам (full-join) **двох** реальних файлів:

**file 1** (base):

| ## | row      |
|----|----------|
| 1  | line 0\n |
| 2  | line 1\n |
| 3  | line 2\n |
| 4  | line 3\n |
| 5  | line 4\n |
| 6  | \n\n     |
| 7  | line 5\n |

**file 2** (sibling):

| # | row           |
|---|---------------|
| 1 | line 0\n      |
| 2 | \n\n          |
| 3 | line 1\n      |
| 4 | other line\n  |
| 5 | yet another\n |
| 6 | line 3\n      |
| 7 | line 5\n      |
| 8 | line 6\n      |
| 9 | \n            |

**Joined document** (внутрішнє представлення DiffPane):

| # | diff-lines                            |
|---|---------------------------------------|
| 1 | line 0\n\0                            |
| 2 | \1\n\n\0                              |
| 3 | line 1\n\0                            |
| 4 | line 2\n\1other line\nyet another\n\0 |
| 5 | line 3\n\0                            |
| 6 | line 4\n\n\1\0                        |
| 7 | line 5\n\0                            |
| 8 | \1line 6\n\n\0                        |

Кожен рядок — або **звичайний** (без `\1`), або **diff-рядок** (з рівно одним
`\1`). Те, як ці два типи комбінуються, дає весь UX редактора (див. §1.6–§1.10).

### §1.2 Типи рядків і термінатор

**`\0` (U+0000)** — термінатор рядка у внутрішньому представленні. **НЕ**
відображається користувачу і **НЕ** входить у байти vault-файлу. Internal sentinel.

**Кожен рядок** обов'язково містить ≥1 символ (зазвичай мінімум `\n` перед
`\0`). Порожніх рядків (`\0` без передуючого символу) не існує.

**Normal-рядок** (без `\1`):

- Формат: `<text>\n\0`
- Вміщує **рівно один** текстовий рядок з оригіналу.
- Значення цього рядка **спільне** для file1 і file2 (саме тому в нього нема
  alternative version).
- Видимий у DiffPane як звичайний markdown/text рядок.

**Diff-рядок** (з рівно одним `\1`):

- Формат: `<ver1>\1<ver2>\0`
- `<ver1>` — **ver-блок 1**, послідовність з 0..N текстових рядків (кожен з
  `\n`). Може бути порожнім.
- `<ver2>` — аналогічно, ver-блок з file 2.
- Виглядає в UI як two-sided diff chunk з кнопками apply/remove зверху, знизу
  і посередині (§1.10).

**Ver-блок** — 0, 1 або кілька текстових рядків, які корелюють позиційно з
ver-блоком на тому ж місці у другому файлі. "Блок рядків, який можна перенести
з одного файлу в інший, не зачіпаючи решту."

Joined-документ — послідовність `<line1><line2>...<lineN>`, де кожен `<lineK>` —
normal- або diff-рядок, термінований `\0`.

### §1.3 Роздільник `\x01` — fail-closed на колізію

**Фіксовано: `` (SOH, Start of Heading, U+0001).**

**НЕ `ÿ` (U+00FF):** `ÿ` — легітимна Latin-1 літера "ÿ" (small y with diaeresis);
зустрічається в європейських текстах (французькі, голландські назви тощо). Захист
на байтовому рівні ("`0xFF` — заборонений UTF-8 байт") не допомагає, бо JS strings
— UTF-16, і `ÿ` — валідний codepoint.

`` — control char, у markdown/text/code файлах user-vault'у практично не
зустрічається.

**Collision policy — fail-closed:**

Перед побудовою joined-документу diff-editor перевіряє байти base і sibling
на наявність ``:

```
if base.includes("") || sibling.includes(""):
    new Notice(
        "This file contains a control character (SOH, U+0001) " +
        "that is incompatible with the internal diff editor. " +
        "Open it in your external diff tool (R6) or default Obsidian editor."
    )
    return  // DiffPane не відкриваємо
```

Не escape-имо. Не fall-back-имо на альтернативний роздільник. Конфлікт лишається
у списку — користувач сам обирає альтернативний шлях (`[Open in external tool]`
або default Obsidian editor).

Жорстко навмисно: silent escape породжує round-trip-помилки, які важко
діагностувати. `` у markdown-vault'і — або corrupt file, або binary
mis-detection; в обох випадках "не відкривати diff" — правильна відповідь.

**Колізія може виникнути НЕ лише на старті сесії, а й під час редагування.**
Session-start check (вище) ловить сентинели у вхідних `base`/`sibling`. Але
`split(currentEditorDoc)` на Step 2 7-step commit (§5.0) парсить **відредагований**
буфер: якщо під час редагування у документ потрапить `\0`/`\1` (paste binary-ish
контенту, IME, clipboard round-trip, decoration leak), `split` тихо мис-парсить
(другий `\1` у рядку зливається у sibling), і corrupt-байти запишуться у vault.
Round-trip-тест цього не ловить — `build` такого ніколи не продукує; виникає лише
при ручному edit. **Локус мітигації (обидва шари, defense-in-depth):**

- **Phase 1b** — CM6 `transactionFilter`, що **відхиляє** будь-яку зміну, яка
  вносить `\0` або `\1` у документ (sentinel ніколи не з'являється у буфері).
- **Етап 2** — на commit-time повторно прогнати `findSentinelCollision` на
  **виході** `split()`; при колізії — abort + Notice, а не запис corrupt-байтів.

(Реалізація — у відповідних фазах; `joined-doc.ts` Етапу 1a лише фіксує контракт:
`split` бере *перший* `\1`, тож > 1 сентинеля на рядок = недетермінований парс.)

### §1.4 Побудова joined-документу: `jsdiff` (`diff` npm package)

**Бібліотека:** `diff` v5.x (npm package, **не** `diff3`). Та сама, що кандидат
для R7.4 word-level highlighting — один пакет на дві задачі.

**Чому `diff`, а не `diff3`:** у diff-editor показуємо ДВІ сторони (base +
sibling). Three-way merge з common ancestor — окремий pipeline у
`src/sync2/three-way-merge.ts` (для auto-merge attempt у Phase A PSEUDO-MERGE-MODE).
У DiffPane ми вже знаємо, що auto-merge провалився (тому sibling існує) — нам
тут потрібен просто двосторонній лінійний diff для візуалізації.

**Алгоритм побудови `build(base, sibling) → joined`:**

1. `diff.diffLines(base, sibling, { newlineIsToken: true })` → масив chunks
   `Array<{added?, removed?, value, count}>`.
2. Прохід по chunks, генерація послідовності рядків:
    - chunk БЕЗ `added` і БЕЗ `removed` (common) → series of normal-рядків,
      по одному `<line>\n\0` для кожного `\n`-фрагменту в `chunk.value`.
    - суміжна пара `removed` + `added` → один diff-рядок:
      `<removed.value>\1<added.value>\0`.
    - одинокий `removed` (sibling видалив текст, що був у base) → diff-рядок
      `<removed.value>\1\0` (ver2 порожній).
    - одинокий `added` (sibling додав текст, якого нема в base) → diff-рядок
      `\1<added.value>\0` (ver1 порожній).
3. Якщо `chunk.value` (у normal-секції) не закінчується на `\n` — файл без
   trailing newline. Останній рядок генерується без `\n` перед `\0`. Це валідний
   стан (правило §1.2: ≥1 символ перед `\0`, не обов'язково `\n`).

**Зворотня операція `split(joined) → (base, sibling)`:**

1. Розбити `joined` за `\0`-роздільниками → список рядків.
2. Для кожного рядка:
    - якщо `\1` відсутній → normal-рядок, додати до обох виходів.
    - якщо `\1` присутній → розщепити по `\1`: ліва частина у base-output,
      права у sibling-output.
3. Конкатенувати base-output → base; sibling-output → sibling.

### §1.5 Round-trip інваріант + версія бібліотеки

**Інваріант:** `split(build(base, sibling)) === (base, sibling)` **byte-exact**
для будь-яких `(base, sibling)`, що пройшли §1.3 collision-check.

Цей інваріант — load-bearing для R7.7.a: history-log накатується **поверх
свіжо-побудованого** joined-документу з оригінальних `base` і `sibling`. Якщо
`build()` не детермінований АБО різні версії `diff` бібліотеки дають різні
chunk-boundaries → ChangeSet'и з логу apply'ються до не-тих offsets → recovery
видає garbage.

**Відбиток у `meta.json` (§2.5):** замість версії-рядка зберігаємо **`joinedDocSha`** —
git-blob SHA рядка `build(base, sibling)`:

```json
{
  "joinedDocSha": "f0e1d2c3..."
}
```

**На recovery** (§3.5 "library-drift"): replay валідний ⟺ `SHA(build(currentInput))
=== meta.joinedDocSha`. Не збігається при незмінних входах → diff-бібліотека дала
інший joined-doc → **start fresh без modal** (offset'и не відтворяться; restore зі
snapshot теж ні; обробка — §3.1 / §3.5 / §8 #8). Стара пара `joinAlgoVersion`/
`joinAlgoOptions` — **ВИДАЛЕНА** (3b-1).

**Unit-тест round-trip** (`tests/diff2/build-split-roundtrip.test.ts`):

- Corpus з 30+ пар (markdown notes, code files, configs, README-style).
- Для кожної пари: `assert.deepStrictEqual(split(build(a, b)), {base: a, sibling: b})`.
- Edge cases: порожні файли, файли без trailing `\n`, файли з лише `\n`,
  файли з emojis (multi-byte UTF-8), CRLF (нагадаю: PSEUDO-MERGE-MODE §8 — sync2
  нормалізує CRLF→LF перед conflict-detection, тому до diff2 ці файли приходять
  уже з LF).

### §1.6 Операції резолюції diff-рядка

Користувач може зрезолвити окремий diff-рядок (`<ver1>\1<ver2>\0`) однією з
4 операцій:

1. **Вибрати ver1** (`[apply ↓]` на `<<<<<` маркері, або `[remove ↑]` на `>>>>>`
   — еквівалентно): видалити `\1` і всі символи після нього аж до `\0`.
   Результат: `<ver1>\0`. Це віртуальний рядок (може містити `\n` всередині),
   розщеплюється у series normal-рядків (нижче).
2. **Вибрати ver2** (`[apply ↑]` на `>>>>>` маркері, або `[remove ↓]` на `<<<<<`
   — еквівалентно): видалити все від початку рядка аж до `\1` включно. Результат:
   `<ver2>\0`.
3. **Об'єднати обидва** (`[apply both ↓↑]` на `=====`): видалити тільки `\1`.
   Результат: `<ver1><ver2>\0`.
4. **Видалити обидва** (`[remove both ↓↑]` на `=====`): видалити цілий diff-рядок
   (зокрема `\0`). Результат: порожньо (рядок зникає).

Після операцій 1–3 отриманий **віртуальний** рядок (один `\0` в кінці, але з
0..N `\n` всередині) **розщеплюється** на normal-рядки:

```
"line1\nline2\nline3\n\0"  →  "line1\n\0", "line2\n\0", "line3\n\0"
```

Або (без trailing `\n` — file без EOL):

```
"line1\nline2\0"  →  "line1\n\0", "line2\0"
```

Кожен normal-рядок вставляється послідовно замість зрезолвленого diff-рядка.

**Окрема операція `[join (remote)]`** (тільки для markdown файлів) на `=====`:
видаляє `\1` і огортає `<ver2>` у `> blockquote`-секцію з префіксом "Changes
from `<remote deviceLabel>` at `<timestamp>`:". Деталі — у `DIFF2_IMPLEMENTATION_PLAN.md`
R7.5.

**Invariant: diff-рядок з `ver1 == ver2` byte-exact не існує.**

За визначенням, diff-рядок `<ver1>\1<ver2>\0` де `ver1` і `ver2` **byte-identical**
— це "немає різниці", тобто **resolved конфлікт**, отже сам diff-рядок зайвий
і повинен зникнути. Це включає **обидва** випадки:

- `ver1 == ver2 == ""` (обидва порожні) — `\1\0`
- `ver1 == ver2 == "<same content>"` — наприклад, користувач набирав диференційно
  у обох ver-блоках і випадково / навмисно зробив їх однаковими: "ver 1" → "ver"
  у ver1, а "ver 2" → "ver" у ver2.

`build(base, sibling)` через `diff.diffLines()` ніколи не генерує такий diff-рядок
(no-diff chunks не з'являються у diff-output — це базова властивість diff
бібліотеки). Інваріант може порушитись лише під час **ручного редагування** у
DiffPane.

**Auto-collapse rule (post-dispatch listener):** після кожного CM6 transaction
dispatch'у, який змінює ver-block content (тобто будь-який edit у ver1 або ver2),
перевіряємо byte-equality affected ver-блоків:

```
if (ver1Bytes === ver2Bytes):
    if (ver1Bytes.length === 0):
        // обидва порожні → operation 4 (remove both)
        autoTrigger("[remove both]")
    else:
        // обидва однакові + non-empty → operations 1 і 2 дають той самий результат
        // вибираємо operation 1 для consistency (визначеність)
        autoTrigger("[apply ↓]" on top marker)  // == "[remove ↑]" on bottom
```

**Реалізація через CM6 state-effect**:

- Auto-collapse триггериться окремим CM6 effect, який combine-иться у ту ж саму
  transaction, що ініціював зміну (через `extend`/`appendTransaction` mechanism).
- Семантично — це **одна** transaction з точки зору CM6 history.
- Користувач бачить **single Ctrl+Z**, який повертає до стану перед edit-and-collapse
  (а не два дискретні Ctrl+Z: "undo collapse" + "undo edit").

**UX escape hatch — undo + reorder edits.** Якщо користувачу auto-collapse не
сподобався (наприклад, він планував додати ще щось, але випадково ввів те,
що зробило ver1 == ver2), він просто натискає `Ctrl+Z` — оскільки collapse і
edit — це одна transaction, undo повертає до стану ДО edit (з diff-рядком на
місці). Тоді користувач може внести зміни в **іншій послідовності** (наприклад,
спочатку додати disambiguating-символ до ver1, потім модифікувати ver2 — у
такому порядку байт-equality не досягається на жодному кроці, collapse не
тригериться). Це робить auto-collapse безпечним: ніколи не втрачаємо
користувацький намір незворотньо.

**Чому byte-exact, а не whitespace-tolerant:**

- "Trailing whitespace ignore" — це specific UX choice, який не має очевидної
  поведінки (де межі toleration? lowercase? Unicode normalize?).
- Якщо користувач хоче об'єднати ver-блоки, що відрізняються лише пробілами, —
  експлицитна `[apply both]` або manual edit.
- Byte-exact дає predictable, тестабельну поведінку без сюрпризів.

### §1.6.a Line-termination visualization + empty-line normalization

Внутрішня модель (§1.2) вимагає, щоб **кожен** рядок усередині ver-блока
закінчувався на `\n`. Виняток: **останній** рядок ver-блока може бути без
`\n` (якщо оригінальний файл не мав trailing newline у цьому місці).

У "сирій" UI це створює проблему: якщо користувач натиснув `Del` (або
`Fn+Backspace` на macOS) у кінці рядка і випадково видалив `\n` — він не
бачить різниці між "рядок з контентом без `\n`" і "порожній рядок". Аналогічно
не видно, що рядок повністю порожній (нуль символів).

#### §1.6.a.0 Line-wrapping — завжди ввімкнено (load-bearing для §1.6.a.1)

**Diff-editor рендериться з `EditorView.lineWrapping` завжди ввімкненим.**
Не toggle, не setting — hardcoded (так само, як у поточному `diff-pane.ts`).
Довгі рядки (markdown-абзаци, рядки коду, base64-вставки) «загортаються» на
кілька візуальних рядків, без горизонтального скролу. Резолюція конфлікту —
це порівняння двох версій рядок-у-рядок; горизонтальний скрол ховав би
праву частину diff'у і робив порівняння неможливим на mobile.

**Прямий наслідок для `↵` (§1.6.a.1):** коли wrap увімкнено, один реальний
`\n` і soft-wrap (візуальне загортання довгого рядка) **виглядають однаково**
— обидва починають новий візуальний рядок. Користувач не може відрізнити
«тут закінчився рядок» від «тут просто загорнулось». Єдиний спосіб зняти цю
двозначність — позначати **кожен реальний `\n` гліфом `↵`**, і то по **всьому**
документу (а не лише у фокусному ver-блоці), бо читання/порівняння охоплює
весь конфлікт. Тому правило §1.6.a.1 нижче — «гліф скрізь», а не «гліф у
фокусі». `↵`-скрізь — це **функція від** wrap-on; вони зчеплені.

**Наслідок для навігації (§1.8) і виділення (§1.7):** обидва визначені на
**документ-моделі** (document lines + сегменти normal/ver1/ver2), НЕ на
візуальних wrap-рядках. Soft-wrap додає лише візуальні рядки всередині одного
document-line; перетин межі ver-блока (entry/exit, §1.8) тригериться на
document-line-межі, що збігається з межею сегмента, а не на кожному
візуальному переносі. `[down]` усередині загорнутого довгого рядка просто
переходить на наступний візуальний фрагмент того ж document-line — без
ver-block-переходу. (Стандартна CM6-поведінка `moveVertically`.)

#### §1.6.a.1 Візуалізація `\n` — гліф `↵` у ВСІХ рядках

Оскільки wrap завжди ввімкнено (§1.6.a.0), CM6 decoration рендерить кожен
реальний `\n` як видимий **glyph** після контенту рядка — у **всіх** рядках
DiffPane (normal-рядки + ver1 + ver2), незалежно від focus:

- Символ: **`↵`** (U+21B5 DOWNWARDS ARROW WITH CORNER LEFTWARDS) — стандартна
  editor-конвенція для line break.
- Glyph рендериться як ghost-character (не входить у документ-модель, не
  селектується, не копіюється у clipboard). Mark-decoration з
  `class:"diff2-newline-glyph"` + CSS `::after` чи widget-decoration.
- **Останній рядок файлу без trailing `\n`** гліфа НЕ отримує — *відсутність*
  `↵` на останньому рядку сигналізує «немає trailing newline» (консистентно
  з §1.2: останній рядок може бути без `\n`).
- Decorations viewport-only (CM6 декорує лише видимі рядки) → рендер `↵` по
  всьому документу не має perf-вартості навіть на великих файлах.

**Чому скрізь, а не лише у фокусному ver-блоці (зміна від попереднього
дизайну):** з wrap-on двозначність `\n`-vs-soft-wrap існує **скрізь**, де є
довгий рядок — і в read-only ver-блоках, і в normal-рядках, не лише там, де
курсор. Старе правило «гліф лише у фокусі» (для зменшення візуального шуму)
залишало решту документа двозначною. Користувач, що *порівнює* дві сторони,
має бачити точні межі рядків обох версій одночасно.

**Optional refinement (не обов'язково для v1):** фокусний ver-блок може
підсвічувати свої `↵` яскравіше (окремий CSS-клас), бо саме там редагуються
trailing-`\n` рішення (§1.6.a.2). Базова вимога — uniform ghost-`↵` скрізь.

#### §1.6.a.2 Diff-editor-specific normalization rule — ONE uniform rule

**Універсальний text-representation інваріант** (НЕ diff-editor-specific):
між двома рядками контенту у будь-якому редакторі завжди стоїть `\n` — це
структурно так. Видалити `\n` між двома рядками = злити їх у один. Це
автоматично; нічого додатково не обробляємо.

**Diff-editor правило — одне і uniform:**

> Якщо **останній рядок ver-блока** не закінчується на `\n`, **І** після
> diff-рядка у joined-документі є ще елементи (тобто diff-рядок **не**
> останній у документі), то **до цього останнього рядка автоматично
> додається `\n`** — незалежно від того, порожній він чи з контентом.

Тобто єдине, що дивимось — **наявність `\n` у кінці останнього рядка ver-блока**
та **позицію diff-рядка у документі**. Все. Жодних qualifier-ів типу
"empty / non-empty".

Чому це працює і для порожнього і для непорожнього last-line:

- `"abc"` (контент без `\n`) → `"abc\n"`. Останній рядок отримав терминатор.
- `""` (порожньо, нічого) → `"\n"`. Тепер це один валідний empty-line з `\n`.
- `"abc\n"` (вже з `\n`) → правило не fire, нічого не змінюється.

`split()` потім дає чисту concatenation з наступним normal-рядком — без злиття,
без втрати структури.

**Коли тригериться:**

1. **На focus-leave ver-блока** (caret рухається у normal-рядок, інший
   ver-блок, чи поза DiffPane). `↵` glyph (§1.6.a.1) видимий скрізь, тож
   користувач свідомо бачить trailing-`\n` стан і може experiment-ити з ним
   до того, як normalization спрацює на focus-leave.
2. **При `[apply]` operation** (§1.6 op 1/2): якщо resolved virtual line
   `<ver>` не закінчується на `\n` і resolved diff-рядок НЕ останній у
   документі, те ж саме правило додає `\n`.

**Приклади:**

```
<<<<<
aaaaaa↵
cccccc           ← останній рядок ver-блока без \n
=====
[normal-рядок далі]
                 ← diff-рядок followed by normal-рядок → "cccccc" → "cccccc\n"
```

```
<<<<<
aaaaaa↵
                 ← останній рядок ver-блока — порожній (0 chars)
=====
[normal-рядок далі]
                 ← правило fire: empty-trailing → "\n"; ver-блок стає
                   "aaaaaa\n\n" (одна валідна empty middle line з \n)
```

```
<<<<<
aaaaaa↵
cccccc           ← останній; без \n
=====
                 ← diff-рядок — last element of document → правило НЕ fire
                   → "cccccc" лишається без \n (valid last-line-of-file)
```

**Що НЕ робимо:** жодних окремих "collapse trailing" чи "preserve middle"
правил. Один тригер, одна дія: "add `\n` if missing AND document continues
after this diff-line."

**Інтерпретація "останнього рядка" і колапс ver-блока:**

- **Ver-блок візуально колапсує** (висота = 0, marker-рядки торкаються) **тільки**
  коли його контент = **0 символів** (`ver = ""`). Ні більше, ні менше.
- При будь-якому не-нульовому контенті ver-блок видимий і має визначений
  "останній рядок".
- `\n` трактується **як терминатор** останнього рядка (не як separator-of-lines):
    - `ver = "abc\n"` → 1 рядок "abc" з терминатором; cursor-after-`\n` —
      "потенційна позиція", не окремий рядок моделі.
    - `ver = "abc\n\n"` → 2 рядки: "abc" і "" (порожній з терминатором).
    - `ver = "abc"` → 1 рядок "abc" БЕЗ терминатора → правило fire → "abc\n".
    - `ver = ""` → 0 рядків → ver-блок колапсований → правило **не fire**.
    - `ver = "\n"` → 1 порожній рядок з терминатором → правило не fire.

**Наслідок для natural empty ver-block з `build()`:** якщо `diff.diffLines()`
згенерував `ver1 = ""` (sibling-only добавлення), ver-блок візуально нульової
висоти (між marker-рядками `<<<<<` і `=====` нічого нема). При focus-traversal
без edit-у через нього — ver1 лишається `""` (0 chars), правило не fire-ить;
семантичне значення зберігається. Якщо користувач натиснув [down] у нього,
ver-block тимчасово "розгортається" візуально (CM6 декорація показує 1-line
container для caret), але контент моделі лишається `""`. Тільки коли користувач
ВВЕДЕ хоча б один символ, ver1 перейде у > 0 chars → ver-block стане справді
видимим → правило далі fire-ить за загальною логікою. **No dirty flag mitigation
needed.**

#### §1.6.a.3 Single-transaction normalization

Diff-editor normalize-effect (§1.6.a.2) + **§1.6 `ver1 == ver2` collapse
check** — combine-яться у одну CM6 transaction через `appendTransaction`.
Семантично — **один Ctrl+Z** скасовує і користувацький edit, і
normalize-effect + auto-collapse.

UX escape hatch (§1.6) діє і тут: якщо normalization дала несподіваний
результат, `Ctrl+Z` + reorder edits.

### §1.7 Правила виділення (selection)

**Принцип:** DiffPane — **два редактори в одному**. Звичайні рядки формують
основний редактор. Кожен ver-блок — окремий sub-редактор. Виділення (selection)
не можна змішувати між ними.

**Легальні виділення:**

- *Варіант 1.* Обидва кінці на normal-рядках, **підряд**:
  ```
  зви[чайний рядок 1\n\0
  звичайний рядок] 2\n\0
  ```
- *Варіант 2.* Обидва кінці **всередині одного ver-блоку**:
  ```
  ve[r-блок 1\n(multi]line)\1ver-блок 2\n\0
  ```
- *Варіант 3.* Обидва кінці на normal-рядках, **через diff-рядок** (diff-рядок
  візуально пропускається):
  ```
  звичай[ний рядок 2\n\0
  ver-блок 1\1ver-блок 2\0
  звичайний ря]док 3\n\0
  ```

**Заборонені виділення (4, 5, 6):**

- *Варіант 4.* Старт на normal, кінець на ver-блоці.
- *Варіант 5.* Старт на ver1-блоці, кінець на ver2-блоці того ж diff-рядка.
- *Варіант 6.* Старт на ver-блоці, кінець на normal.

Усі три ламали б `(ver1, ver2)` структуру, унеможливлюючи кнопки. Активно
блокуємо на рівні CM6 selection handler-а.

**Як цього досягаємо:**

1. **Клавіатура (Shift + arrows / Shift + PgUp/PgDn):** старт на normal-рядку,
   спроба продовжити Shift+down на diff-рядок → виділення автоматично перескакує
   на наступний після diff-рядка normal. Diff-рядок ховається під виділенням.
2. **Миша:** click на normal, drag вниз — при потраплянні mouse-pointer у зону
   diff-рядка selection зупиняється на останньому символі попереднього normal,
   продовжує тільки коли вийшов з diff-рядка на наступний normal.
3. **Усередині ver-блоку:** selection не виходить за межі цього блоку. Навіть
   `Ctrl+A` (`Cmd+A`) виділяє **весь текст одного ver-блоку**, не весь файл.

**Узагальнення:** клавіатура перестрибує diff-рядок цілком; миша "ховається"
під ним; Ctrl+A всередині ver-блоку виділяє лише цей блок.

### §1.7.a ВІДКРИТІ ПРОБЛЕМИ (до вирішення)

**(0) ✅ ВИПРАВЛЕНО (2026-06-02) — Варіант-3 spanning replace.** Варіант-3 заміна —
**банальна текстова заміна**: виділення з normal-рядка через diff-рядок до
наступного normal-рядка, замінене словом, дає рівно той самий результат, ніби
diff-рядка не було (`nor[…diff…]string 2` + `TEST` → `norTESTstring 2`), і
потрапляє в **обидва** файли (конфлікт зник).

- **Тест:** `tests/diff2/free-edit-resolve-bug.test.ts` (un-skipped; basic +
  two-group span + boundary-tie). Fix у `diff-pane.ts`: `detectSpanningResolve` +
  `rebuildSpanningResolve` (гілка в `collapseGuard` ПЕРЕД generic mapStructure;
  i=first-match left-normal, j=last-match right-normal) + `assertTiling`
  (exported) у внутрішній collapse-шлях (mis-tile → гучний throw).
- **NB (хибна тривога, не плутати):** `build∘split == identity` на ВНУТРІШНЬОМУ
  joined-рядку НЕ тримається (хаотична правка може змусити `build` косметично
  пере-групувати чанки; `\0` там — законний термінатор лише внутрішнього
  представлення). Це **НЕ** проблема save/reopen: за §1.5 `split(build(X))==X`
  обидва представлення split-яться в ТІ САМІ файли. Доведено
  `tests/diff2/save-reopen-stability.test.ts` (fuzz → save → reopen-as-fresh-pane
  → resave = byte-identical, fixpoint). Файли НІКОЛИ не містять `\0`/`\1` (вони —
  вихід `split`, `\0`→`\n`).
- **Root cause (вимір через експортовані `mapStructure`/`growIndexFor`):**
  `mapStructure` мапить КОЖЕН сегмент незалежно й НЕ вміє обробити одну зміну,
  що перекриває/видаляє ЦІЛІ сегменти. Для `[from,to]` через normal→ver1→ver2→
  normal лишаються zero-width ver-огризки на старій позиції + **діра** між
  сегментами (caret-0: вставлений `TEST` падає у `[4,8)`, не покриту жодним
  сегментом) АБО перекриття/безлад (caret-at-end). Результат залежить від
  (нерелевантної) позиції каретки. `currentItems` ріже doc по сегментах →
  пропускає діру → `collapsed.doc` без `TEST` → тиха втрата. Внутрішній
  collapse-шлях (`mapStructure→currentItems→relayout`) НЕ має tiling-assert
  (на відміну від `fromEditorModel`).
- **Fix-алгоритм (дедикована гілка, НЕ чіпати generic `mapStructure` —
  blast-radius = весь редактор):** при doc-зміні `[from,to]`, де обидва кінці в
  normal-space і діапазон повністю містить ≥1 diff-групу (legalize гарантує
  повне перекриття): `i`=сегмент із `from`, `j`=сегмент із `to`; rebuild —
  сегменти до `i` без змін; `segments[i..j]` (normals + перекриті групи) → ОДИН
  normal-сегмент `[segments[i].from, segments[i].from + (segments[j].to −
  segments[i].from + delta)]` (вцілілий префікс + вставлений текст + вцілілий
  суфікс, групи зникають); сегменти після `j` зсунути на delta; emit
  `setDiffPaneState` з цією структурою. **+ додати tiling-assert** у внутрішній
  collapse-шлях (mis-tile → гучний throw, не тиха втрата).

**(1) ✅ ВИПРАВЛЕНО (2026-06-02) — конфлікт на МЕЖІ документа (перший/останній
рядок = diff).** Модель: **перед першим і після останнього рядка є віртуальний
порожній normal-рядок** — **ВИКЛЮЧНО для охоплення diff-рядків при SELECTION**.
**Фокус/каретка в цей віртуальний рядок НІКОЛИ не потрапляє** (він не навіговний;
це лише selection-span helper). Стосується БУДЬ-ЯКОГО виділення, що сягає межі —
`Ctrl+A`, `shift+PgUp/PgDn`, `shift+Ctrl+Home/End`.

**Init-каретка (§1.8.a, окреме від віртуального normal):** якщо перший рядок —
diff, init-каретка `(0,0)` потрапляє В **ver1** (а НЕ у віртуальний normal):
порожній ver1 → активується/expand (`initialEmptyVerAt0`, тест `init-empty-ver`);
non-empty ver1 → каретка в його `(0,0)` (= 0,0 редактора), друк росте ver1 (base)
— працює без додаткового коду (перевірено). Жодних складних edge-формул.

- **Реалізація (edge-handling, без матеріалізації):** `rebuildSpanningResolve`
  трактує відсутність left-normal як віртуальний край ЛИШЕ коли `fromA===0`
  (істинний doc-start), а відсутність right-normal — коли `toA===oldLen`
  (doc-end). Тоді merged-region = `[0 / structure[li].from … oldLen /
  structure[ri].to]`. Тести: conflict-on-first-line, conflict-on-last-line,
  Ctrl+A-whole-doc (`free-edit-resolve-bug.test.ts`).
- **Розглянуті альтернативи представлення (НЕ обрані — інвазивні, зайві):**
  (a) логічні рядки −1 і N(=кількість рядків); (b) фізично line 0 = віртуальний,
  реальні з 1. Обидві потребували б renumbering / матеріалізації віртуальних
  сегментів (зачіпає build/split/toEditorModel/line-numbers/усі offset'и).
  Edge-handling дає ту саму семантику дешевше.
- **Інваріант (реафірмовано, вже в `legalizeRange`):** виділення ВСЕРЕДИНІ
  ver-блоку НІКОЛИ не виходить за його межі (Варіант-2: anchor у ver → clamp
  head у `[ver.from, ver.to]`), що б не робили (shift-extend, drag, shift+PgUp/Dn).
- **Layout-залежне → manual:** реальна геометрія shift+PgUp/PgDn/Home/End, що
  сягає межі (happy-dom без layout). Логіка (legalize до межі = normal-space;
  resolve на межі) — покрита unit-тестами вище.

**(2) Copy/Paste виділення, що містить diff-рядок.** Що кладемо в clipboard,
коли Варіант-3 виділення покриває diff?

**Підхід (вирішено) — ОДИН plain-text формат** (без custom-MIME/binary →
mobile-safe, працює всюди), коректний МАЙЖЕ ЗАВЖДИ. Diff-частина рендериться як
git-conflict з маркерами `<<<<<` / `=====` / `>>>>>` (**рівно 5 символів** `<`/
`=`/`>` — наша традиція, НЕ 7 як у git; парсер вимагає саме 5), КОЖЕН рядок несе
**префікс = 3 пробіли** (`"   "`), а ВЕСЬ payload обгорнутий у markdown
**fenced code-block** з info-string **`github-easy-sync-copy`** на відкривному
фенсі (нижче `·` = пробіл для наочності):

````
```github-easy-sync-copy
···normal string 1\n
···<<<<<\n
···ver1 string 1\n
···ver1 string 2\n
···=====\n
···ver2 string 1\n
···>>>>>\n
···normal string 2\n
```
````

**Префікс-правило:** рівно **3 пробіли** — канонічно; **4 теж приймаємо**
(толеруємо зайвий indent від зовнішнього редактора); **≤2 пробіли → весь блок
іде в normal strings** (fail-closed). 3 пробіли обрані бо: не плутаються з
markdown-indented-code (4+) у звичайному тексті, але всередині нашого фенсу
зрізаються чисто; ≤2 = щось підрізало payload → не довіряємо.
**Навіщо саме така обгортка:** info-string `github-easy-sync-copy` робить ПОДВІЙНУ
роботу — (а) валідний markdown code-блок (деінде рендериться акуратно, з міткою
мови), і (б) однозначна **сигнатура «наш copy»**: парсер вимагає РІВНО цей
відкривний фенс (не потрібен окремий флаг). **Paste у НАШ редактор:** збіг
`` ```github-easy-sync-copy `` → fence + префікс зрізаються, маркери парсяться →
реконструкція normal+diff-strings (ver-блоки можуть бути multi-line). Наш редактор
НЕ вставить цей блок дослівно — зліпить з нього конфлікт. **Paste деінде:**
лишається валідний code-блок із префіксами — нешкідливо, вичистить пізніше.
(Розглянути версію в info-string — `github-easy-sync-copy` vs `…-v1` — для
майбутньої еволюції формату.)

**Розпізнаємо ЛИШЕ нашу сигнатуру (уточнено).** Оскільки info-string
`github-easy-sync-copy` — це НЕ звичайний code-block, а наш унікальний маркер,
конфлікт реконструюється **тільки** коли paste починається рівно з
`` ```github-easy-sync-copy ``. Усе інше — звичайний ``` code-block (реальний код
користувача), чужий git-conflict текст без нашого фенсу, будь-що — вставляється
**як normal strings** (жодної diff-реконструкції, жодних випадкових конфліктів).
(Це скасовує ранішу ідею «зовнішній marker-текст теж парситься»: сигнатура-фенс
робить розпізнавання однозначним і безпечним.)

**Fail-safe парсингу (строго, fail-closed):** навіть за наявності нашого фенсу —
якщо префікс / `<<<<<` / `=====` / `>>>>>` **не там, де очікуються** (розбіжність
хоча б на ОДИН символ) → **вставляємо УСЕ як normal strings**. Конфлікт
відновлюється лише при ІДЕАЛЬНО well-formed payload; будь-яке відхилення → plain
normal-текст.

**In-memory модель** (для самого парсера / round-trip) — `lines[]`, де елемент =
масив: `[normal]` (довжина 1) або `[ver1, ver2]` (довжина 2 → diff-БЛОК; кожен
ver — цілий блок, може містити кілька `\n`):

```json
{
  "lines": [
    [
      "normal line1\n"
    ],
    [
      "diff-ver1-line-a\ndiff-ver1-line-b\n",
      "diff-ver2-line\n"
    ],
    [
      "normal line2\n"
    ]
  ]
}
```

**Обов'язковий тест (коли реалізуємо copy з diff-string):** **вирізати** один
конфлікт (cut — delete регіону з diff-групою) і **вставити** його в інше місце
(paste нашого internal-payload → відтворення ver1/ver2 на новій позиції). Обидві
операції мають потрапити в **REDO (`history.jsonl`)** і ТОЧНО відновитись на
replay. Лягає на **format B**: paste-tx-блок зберігає post-paste structure з
новою групою → `replayHistory` її відновлює; cut-tx-блок — structure без неї.
(Увага: cut diff-групи — це по суті той самий spanning-delete, що й §1.7.a(0);
тож (0) має бути пофікшено ПЕРШИМ, інакше cut втрачатиме/плутатиме structure.)
**Опційне desktop-покращення — другий clipboard-тип (progressive enhancement).**
`navigator.clipboard.write([new ClipboardItem({...})])` на desktop (Electron/
Chromium) дозволяє КІЛЬКА типів одразу: `text/plain` + «наш» (`text/html` зі
схованим `lines[]`-JSON у HTML-коментарі / `data-`-атрибуті, АБО web-custom-format
`web application/x-diff2-conflict`). Тоді:

- paste у наш редактор бере **rich-type** → точна реконструкція без парсингу
  тексту; misparse-ризик зникає;
- `text/plain` можна зробити **чистим читабельним** (git-маркери БЕЗ ugly-префіксу
  й навіть без fence) — для людей/інших редакторів;
- префікс+fence лишаються **fallback** для платформ без rich-type.
  **АЛЕ** на mobile (Capacitor WKWebView/Android) rich-типи ненадійні/відсутні →
  Capacitor Clipboard зазвичай лише text/plain. Тому **text/plain-шлях (fence+
  префікс+маркери) лишається CANONICAL і обов'язковим** (на mobile — єдиний); другий
  тип — суто desktop-полиш. **Рекомендація:** базу (одинарний text/plain) робимо
  завжди; rich-type додаємо ЯКЩО префікс-засмічення / misparse стануть на практиці
  дратувати — не блокуватись.

Вирішити (лишилось): поведінка при неповних/вкладених маркерах (fail-closed →
normal); як екранувати реальний контент, що сам містить рядок `` ``` `` всередині
ver/normal (вкладений фенс — напр. подвоєний фенс або більше backtick'ів);
чи кодувати ver==ver (не має існувати, §1.6). Префікс — **вирішено: 3 пробіли**
(4 ок, ≤2 → normal).

### §1.8 Plain navigation курсора (НЕ skip)

Якщо курсор рухається **БЕЗ Shift** (просто arrows / Home / End / PgUp / PgDn /
click) — diff-рядок **НЕ пропускається**. Натомість — очевидний "вхід / вихід"
з ver-блоків:

1. Курсор на будь-якому символі normal-рядка перед diff-рядком, `[down]` →
   курсор у **перший рядок ver1-блоку, позиція символа така ж яка була в normal-рядку**.
    - Якщо ver1 порожній (`\1<ver2>\0` форма) — він "проявляється" візуально
      (CM6 декорація показує порожній контейнер заввишки в один рядок), щоб
      користувач міг туди писати. Коли користувач натисне ще раз `[down]`
      (без редагування) — ver1 знову "схлопнеться" як порожній і курсор
      перейде до ver2.
2. Курсор у ver1-блоці, `[down]` → курсор у **першому рядку ver2-блоку** (ті ж
   ефекти; порожній ver2 проявляється).
3. Курсор у ver2-блоці, `[down]` → курсор на **першому normal-рядку після**
   diff-рядка.
4. `[up]` — дзеркально (normal → ver2 → ver1 → normal).

**Plain caret** живе у єдиному лінійному просторі "normal + ver1 + ver2 + normal …",
а **selection** живе у двох ізольованих просторах ("normal-only" + "single-ver-block-only").

**Focus-leave normalization тригериться при кожному переході caret через
межу ver-блока** (§1.6.a.2): порожній trailing line collapse-иться, порожні
middle lines отримують `\n`. Тобто переходи `ver1 → ver2`, `ver1 → normal-перед`,
`ver2 → normal-після` (і клікові аналоги) тригерять normalization-pass на
залишеному ver-блоці. Це **частина** тієї ж CM6 transaction, що виконує
navigation, тож одне Ctrl+Z скасовує і navigation, і normalize-effects.

### §1.8.a Activation of empty ver-блоків через mouse / touch

Marker-зони `<<<<<` і `>>>>>` стають click-чутливими **тільки** коли
відповідний ver-блок **порожній**. З контентом — клік на видиму ver-текст
рядка тривіальний і інтуїтивний, marker зайвий як hit target.

```
       клік по chars      [apply ↓][remove ↓] (...)
       <<<<<              ↑ ці кнопки мають свою dispatch
       ↑
       active hit-zone ТІЛЬКИ якщо ver1 нижче порожній
       (інакше клікни на сам ver1-текст)
```

**Правила:**

| Клік на                                             | Стан ver-блока   | Дія                                                                                                          |
|-----------------------------------------------------|------------------|--------------------------------------------------------------------------------------------------------------|
| `<<<<<` chars (з пробілом після) у верхньому marker | ver1 порожній    | Expand до 1-line input container; focus caret у ver1.                                                        |
| `<<<<<` chars                                       | ver1 НЕ порожній | **Neutral / no-op** — користувач клікає прямо на видимий ver1-текст.                                         |
| `>>>>>` chars (з пробілом після) у нижньому marker  | ver2 порожній    | Симетрично: expand ver2; focus caret у ver2.                                                                 |
| `>>>>>` chars                                       | ver2 НЕ порожній | **Neutral / no-op** — клікни на видимий ver2-текст.                                                          |
| `=====` chars у середньому marker                   | будь-який        | **Neutral / no-op** — `=====` має свої `[apply both]` / `[remove both]` / `[join]` кнопки; не focus-trigger. |
| `[apply ↓]` / `[remove ↓]` / etc. кнопки            | будь-який        | Свій button handler — chunk-action dispatch (§1.6). НЕ focus-activate.                                       |
| Будь-яке інше місце marker-рядка (whitespace)       | будь-який        | No-op.                                                                                                       |

**Invariant: diff-рядок ніколи не існує з `ver1 == ver2` byte-exact** (§1.6,
включає both-empty випадок). Тому хоча б один з ver-блоків завжди має
**відмінний** контент (якщо обидва порожні — diff-рядок вже auto-collapse'нувся).
Це означає, що `<<<<<` і `>>>>>` зони можуть бути одночасно "neutral" (якщо
обидва ver-блоки непорожні) АБО рівно одна з них активна (якщо саме один з
ver-блоків порожній). Активований hit-target — завжди саме той marker, чий
ver-блок порожній.

**Hit-zone implementation** — у CM6 marker-row block-widget DOM child elements
мають state-залежний `data-action`. Кожна re-render діаграми (при tx, що
змінює ver1/ver2 content) переобчислює active/neutral state:

```html
<!-- ver1 порожній → focus-target active -->
<div class="diff2-marker-row diff2-marker-top">
    <span class="diff2-marker-chars" data-action="focus-ver1"><<<<< </span>
    ...
</div>

<!-- ver1 з контентом → marker chars inert -->
<div class="diff2-marker-row diff2-marker-top">
    <span class="diff2-marker-chars" data-action="none"><<<<< </span>
    ...
</div>
```

Click handler перевіряє `data-action`:

- `focus-ver1` / `focus-ver2` → expand + caret focus
- `none` → no-op (default browser behavior, тобто нічого)

Touch event-и автоматично mapped CM6-ом до click — mobile pattern той самий.

**Жодних змін у §1.9 button-row keyboard navigation:** `[up]`/`[down]` як
пропускали marker-рядки, так і пропускають. `<<<<<`/`>>>>>` як focus target —
**тільки для кліку/тапу**, не для клавіатури. Клавіатура використовує лише
§1.8 (entry/exit empty ver-blocks автоматичний).

### §1.9 Button rows + клавіатурні hotkeys

Над, посередині і під кожним diff-рядком рендеряться **рядки кнопок** (CM6
block-widget decorations, не справжні рядки документу):

```
<<<<< [apply ↓][remove ↓] ({local deviceLabel})       ← above ver1
ver1 (multiline)
===== [apply both ↓↑][remove both ↓↑][join ({remote})] ← between
ver2 (multiline)
>>>>> [apply ↑][remove ↑] ({remote deviceLabel})      ← below ver2
```

**Навігація:**

- `[up]` / `[down]` (без Shift) **пропускають** button rows (вони не входять у
  text-flow, лише у візуальну подачу).
- Button rows доступні **тільки кліком миші**.

**Hotkeys** (активні лише коли курсор у ver-блоці):

| Hotkey                 | Дія                         |
|------------------------|-----------------------------|
| `Ctrl+Enter`           | `[apply]` цього блоку       |
| `Ctrl+Backspace`       | `[remove]` цього блоку      |
| `Ctrl+Shift+Enter`     | `[apply both]`              |
| `Ctrl+Shift+Backspace` | `[remove both]`             |
| `Ctrl+Shift+.`         | `[join (remote)]` (md only) |

(На Mac `Ctrl` = `⌃`, не `Cmd`. Навмисно — `Cmd+Backspace` зайнятий системою.
`Ctrl+Backspace` зручний на обох платформах.)

Hotkey-підказки відображаються як alt-text при наведенні на кнопку.

### §1.10 Нумерація рядків (gutter) — "sibling-wins"

DiffPane показує **одну** колонку номерів за схемою **sibling-wins**: документ
нумерується так, ніби sibling — фінальний результат. Тобто наскрізна
послідовність = `normal + ver2` (sibling-файл), а `ver1` нумерується
**паралельно**, продовжуючись від рядка вище, і свій лічильник у наскрізну
послідовність **не** віддає.

**Правило** (прохід по `structure` за doc-рядками; `n` — наскрізний лічильник):

- **normal-рядок**: `n++`; показати `n`.
- **ver2-рядок** (remote-only): `n++`; показати `n`. (sibling рухає наскрізний `n`)
- **ver1-рядок** (local-only): показати `(n_на_початку_блоку + зсув_у_ver1)`;
  наскрізний `n` **не** змінює.
- Після diff-блока `n` зсунутий на к-сть рядків ver2; наступний normal
  продовжується звідти (тобто "з ver2").

Приклад (`base = a b c d e`, `sibling = a P Q R c S e`):

```
 1 │ a
   │ <<<<<
 2 │ b      ← ver1, паралельно від a(1)+1
   │ =====
 2 │ P      ← ver2, наскрізний
 3 │ Q
 4 │ R
   │ >>>>>
 5 │ c      ← продовжується з ver2
   │ <<<<<
 6 │ d      ← ver1, паралельно від c(5)+1
   │ =====
 6 │ S      ← ver2
   │ >>>>>
 7 │ e
```

- **Marker-рядки** (`<<<<<` / `=====` / `>>>>>`) — block-widgets, **НЕ** doc-рядки
  → номерів не мають; gutter навпроти них порожній.
- **Line-wrap** (§1.6.a.0): загорнутий довгий рядок має **один** номер;
  continuation-візуальні-рядки — порожній gutter. Це і **сигнал переносу**:
  один номер на кілька візуальних рядків ⇒ рядок загорнуто. Доповнює гліф `↵`
  (що маркує *реальні* кінці рядків): `↵` → справжній розрив; номер+порожній
  gutter нижче → soft-wrap. Разом — однозначно.
- **Live + конвергенція**: лічильники перераховуються зі `structure` на
  **кожній** транзакції. У міру резолюції кожен diff-блок стає normal-сегментом
  і вливається в наскрізний лічильник; коли **всі** конфлікти розв'язані
  (ver1/ver2 не лишилось) — нумерація стає чистою послідовною `1..N` = **реальні
  номери фінального файлу**. Тобто провізорність sibling-wins транзиторна й
  **сама зникає** в процесі; кінцевий стан завжди коректний.

**Рішення (2026-06-01):** обрано sibling-wins (а не дві колонки `local#|remote#`
git-академічного unified-diff, і не git-реальні local# на ver1). Свідомо
прагматично: проста зрозуміла схема. Застереження: presumption "sibling =
результат" — не істина нашої pseudo-merge моделі (сторону обирає користувач),
тож ver1-номери провізорні. Дані в моделі (`Segment[]` роль+межі) дозволяють
**тривіально** перемкнутись на git-академічну чи дві колонки пізніше — рішення
зворотне.

**Реалізація:** НЕ вбудований `lineNumbers()` (він дав би наскрізну 1,2,3,4) —
кастомний gutter, що читає `structure`. Рендер — крок 1b.1.

---

## §2. R7.7.a — Persistent autosave (REDO-log + cursor-timer)

### §2.1 Scope і границі

**Покриваємо:** intra-session, intra-chunk undo всередині однієї resolve-сесії
DiffPane. Сценарій:

1. Користувач відкриває конфлікт `X`, редагує 10 хв (натиснув `[apply]` на
   трьох chunks, вручну дописав абзац у четвертому).
2. Obsidian killed (low-memory на iOS, battery die, OS restart, force quit).
3. Через 2 години відкриває той самий конфлікт.
4. **Recovery dialog** (§3) пропонує `[Continue editing]`.
5. Натиснув → DiffPane у стані за ~1 секунду до crash; cursor приблизно там,
   де був; `Ctrl+Z` повертає до chunk-2, chunk-1, etc.

**НЕ покриваємо:** durable archive **між** sync-кліками — це PSEUDO-MERGE-MODE
§4.4. Між цими рівнями немає overlap-у.

### §2.2 Принцип: vault недоторканий до `[←]`

Файли `base` і `sibling` у vault фізично **НЕ перезаписуються** під час
редагування у DiffPane. Запис у vault — **тільки** при `[←]` (write base +
proactive sibling cleanup, R7.11 та §5).

Load-bearing for two reasons:

1. **Recovery математично можливий тільки якщо вхідні файли незмінні** —
   history-log накатується поверх свіжо-побудованого `build(base, sibling)`.
2. **Tab close `[x]` має чітку семантику "викинути сесію"** — vault лишається
   у pre-session стані, без слідів проміжного редагування.

### §2.3 Гранулярність REDO-блоку = 1 CM6 transaction

Кожна CM6 transaction = один REDO-блок у логу. Природна одиниця `Ctrl+Z` —
користувач сприймає кожен undo-step як одне "повернутись".

**Конфігурація:** `history({ newGroupDelay: 0 })` (per Phase 5 spike findings —
`tests/diff2/spikes/`).

Default `newGroupDelay` (~500ms) групує consecutive transactions у один
undo-group — неприйнятно для diff-editor: програмні chunk-action dispatches
([apply] / [remove]) повинні бути окремими Ctrl+Z-steps.

**In-memory UNDO стек** — vanilla CM6 historyField, живе **тільки в RAM**. На
crash зникає. На recovery — відновлюється природним шляхом: `view.dispatch(tx)`
для кожного replayed-блока автоматично записує undoable step у CM6 historyField.

### §2.4 Директорійна розкладка

```
<vault>/
└── .diff2-autosave/
    ├── <conflictId-1>/
    │   ├── meta.json
    │   ├── history.jsonl       ← constant name
    │   ├── cursor-a.json      ← 2-slot ping-pong (§2.9)
    │   ├── cursor-b.json
    │   ├── base.snapshot       ← byte-copy of basePath at session start
    │   ├── sibling.snapshot    ← byte-copy of siblingPath at session start
    │   └── done.json           ← optional, present ONLY during [← back] commit
    ├── <conflictId-2>/
    │   ├── meta.json
    │   ├── history.jsonl
    │   ├── cursor-a.json      ← 2-slot ping-pong (§2.9)
    │   ├── cursor-b.json
    │   ├── base.snapshot
    │   └── sibling.snapshot
    └── <conflictId-3>/
        ├── meta.json
        ├── history.jsonl
        ├── cursor-a.json
        ├── cursor-b.json
        ├── base.snapshot
        └── sibling.snapshot
```

**П'ять обов'язкових файлів** + **один optional**:

- `meta.json` — пишеться **раз** при старті сесії; не модифікується (§2.5).
  Відсутність → §4.2 cleanup (1).
- `history.jsonl` — append-only лог CM6 transactions (§2.6–§2.8). **Constant
  ім'я**, не передається через meta.json (один на сесію — `.diff2-autosave/<id>/`
  завжди створюється з нуля). Відсутність → §4.2 cleanup (2).
- `cursor-a.json` / `cursor-b.json` — позиція курсора, **2-слот ping-pong** —
  механіку (slots, `seq`, recovery) див. **§2.9** (єдине джерело). На старті сесії
  пишеться `cursor-a.json` (`seq 0`); відсутність **обох** слотів → §4.2 cleanup (3).
- `base.snapshot` — byte-exact copy of `basePath` content at session start.
  Пишеться **раз** на старті, не модифікується. Це **"ground truth"**
  baseline: усі recovery / TOCTOU перевірки порівнюють поточний vault state
  до цих snapshots, не до stored SHAs. Відсутність → §4.2 cleanup (4).
- `sibling.snapshot` — analogously для `siblingPath`. Відсутність → §4.2 cleanup (5).
- `done.json` — **optional**. Пишеться тільки на старті `[← back]` commit
  (§5.0 step 2). Містить pre-computed `expectedBaseSha` + `expectedSiblingSha`.
  **Присутність — це сигнал "commit-in-progress, roll-forward via §5.0 recovery"**;
  §4.2 cleanup НЕ запускається, поки done.json лежить. Після успішного commit
  (step 7) done.json зникає разом з рештою через `rmdir(autosave-dir)`.

**Чому snapshots замість stored SHAs у meta.json:**

- **Ground truth для recovery / TOCTOU**: коли vault змінився під час
  редагування — у нас лишається оригінал що user реально бачив на старті;
  recovery dialog може показати informed options (форма — §3.2.a) замість silent wipe.
- **Простіша meta.json**: без полів `baseShaAtStart`, `siblingShaAtStart`,
  `historyFile`. Менше state, менше сумнівних операцій (SHA recompute з
  byte-snapshots завжди правильний).
- **Constant filenames** для всіх runtime файлів — менше fragility (не
  потрібно tracking назву history-файлу через meta).
- **Robust до edge case** "vault змінився під час сесії": не вибираємо
  одне з двох (cleanup user-work АБО overwrite vault), а даємо користувачу
  усвідомлений вибір через recovery modal з повним діагностичним контекстом.

Storage overhead (2x file size per session) — для типового markdown-vault'у
30-300 kB на сесію. Negligible.

**`<conflictId>`** — три можливі джерела залежно від типу сесії:

| Kind                                                     | Джерело id                                                         | Form                |
|----------------------------------------------------------|--------------------------------------------------------------------|---------------------|
| **Tracked conflict** (ConflictStore record exists, R2.2) | UUID assigned ConflictStore'ом при `create()`. Opaque, не з paths. | `tracked-<uuid>`    |
| **Synthetic conflict** (sibling-only, R2.2 Правило 3)    | Deterministic hash з `(basePath, siblingPath)` pair (§2.4.1).      | `synthetic-<16hex>` |
| **R2.1 Compare-any-two** (arbitrary file pair, Phase 8)  | Deterministic hash з `(pathA, pathB)` pair, sorted (§2.4.1).       | `compare-<16hex>`   |

#### §2.4.1 Уніфікована формула deriveAutosaveId

Для non-tracked сесій (synthetic + compare) використовуємо **одну функцію**:

```typescript
function deriveAutosaveId(
    kind: "synthetic" | "compare",
    path1: string,
    path2: string,
): string {
    // Sort для order-canonicalization: (A, B) і (B, A) → той самий id
    // Critical для compare — користувач міг вибрати файли у будь-якому
    // порядку через picker. Для synthetic — теж symmetric, хоча на
    // практиці siblingPath завжди derive-ний з basePath, тож order
    // фіксований.
    const [first, second] = [path1, path2].sort();

    // `\0` як delimiter запобігає path-collision ambiguity:
    // ("foo", "bar") vs ("foob", "ar") vs ("fooba", "r") → різні хеші
    // (бо `\0` не зустрічається у valid path).
    const hash = fnv1a64(first + "\0" + second)
        .toString(16)
        .padStart(16, "0");

    return `${kind}-${hash}`;
}
```

**Чому `fnv1a64` (64-bit), а не 32-bit:**

- 32-bit = 8 hex chars = 4 billion buckets. При типовому usage (десятки
  одночасних сесій) — collision rate негайно. Але **paranoid-safe** important
  для diff2 — collision = два різні file pairs шлядать у один autosave dir =
  data loss.
- 64-bit = 16 hex chars. Collision probability negligible на будь-якому
  realistic vault size. Overhead 8 додаткових chars у directory name — copey.

**Чому sort + delimiter (не просто concat):**

- Без sort: `("a.md", "b.md")` ≠ `("b.md", "a.md")` → два різні compare-сесії
  → user resume не знаходить попередню роботу.
- Без delimiter: `"foo" + "bar"` = `"fooba" + "r"` → collision.

**Чому synthetic conflicts теж через цю формулу** (а не просто `hash(siblingPath)`):

- Однорідність — один helper для всіх non-tracked. Менше шансів на divergence
  у тестах і коді.
- Симетричний паттерн — якщо колись синтез ID для synthetic зміниться (наприклад,
  додамо нову форму sibling naming), формула не зламається.

**Invariant** (Phase 1 `synthetic-detector.ts` имплементатор зобов'язаний
дотриматись):

- `deriveAutosaveId("synthetic", basePath, siblingPath)` — **deterministic**,
  pure function of path arguments only. Жодних `Date.now()` / mtime / random.
- `deriveAutosaveId(k, a, b) === deriveAutosaveId(k, b, a)` — order-independent.
- Verified unit-тестом `autosave-id-stable-and-symmetric.test.ts`: build IDs
  для серії pair'ів двічі + у reversed order → усі співпадають.

**Single-detail-area invariant — один активний diff-editor у момент часу.**

**Це навмисний design choice, не технічне обмеження.** Користувач відкриває
й редагує **одну пару файлів** у diff-editor одночасно. Хоче переглянути
інший конфлікт чи compare? — closes поточну сесію, відкриває нову.

**Чому це feature, а не bug:**

1. **Фокус на одній задачі.** Резолюція конфлікту або порівняння двох файлів
   — це акт concentration. Multiple editor tabs змусили б користувача
   "перемикатись" між контекстами, втрачаючи track.
2. **Передбачувана autosave-семантика.** Один active editor = одна
   `<conflictId>` модифікується в момент часу = жодних concurrency-edge cases
   на recovery files.
3. **Простіша cognitive model.** "Я редагую цей конфлікт. Завершу — візьму
   наступний." vs "У мене 5 tabs з різними конфліктами, який зараз активний?"
4. **Без втрати work на accidental clicks.** Випадковий клік на інший
   conflict у списку (чи context-menu Compare) не може стерти 30 хвилин
   роботи — система явно вимагає закриття поточної сесії.

Архітектурна реалізація (Phase 0): **single registerView** → один leaf у
workspace типу `DIFF_EDIT_VIEW_TYPE`. Усередині leaf-а layout з conflicts
list + **detail-area**, де живе DiffPane. Тільки **один** conflict
edits-ається у detail-area в момент часу.

**Усі entry points маршрутизуються через цей єдиний leaf**:

| Entry point                                   | Дія                                                      |
|-----------------------------------------------|----------------------------------------------------------|
| Click conflict у diff2 list                   | Populate detail-area з конфліктом                        |
| Context-menu `Compare with…` (R2.1)           | Open/reveal leaf → populate detail-area з compare-сесією |
| File-menu `Resolve conflict` на sibling-файлі | Open/reveal leaf → populate detail-area з конфліктом     |
| Command palette `Show history of this file`   | Open/reveal leaf → populate detail-area з history-сесією |

**Inherent properties цієї архітектури:**

- Concurrency на autosave files **неможлива** — тільки одна `<conflictId>`
  активна в момент часу.
- Жодних race-conditions на cursor ping-pong writes (§2.9) чи `history.jsonl` appends.
- Single-tab-per-id invariant **inherent**, не потребує enforcement коду.

**Поведінка при invoke entry point з активним detail-area:**

```typescript
function openInDetailArea(newConflictId: string, displayName: string) {
    const currentSession = detailArea.currentSession;
    if (currentSession && currentSession.conflictId === newConflictId) {
        // Уже відкритий цей самий конфлікт — просто focus leaf + scroll up
        revealLeaf(diff2Leaf);
        return;
    }
    if (currentSession && currentSession.hasUnflushedChanges()) {
        // Інша сесія активна з unsaved changes
        new Notice(
            `Close current edit first ([← back] or [×]) to open: ${displayName}`
        );
        revealLeaf(diff2Leaf);  // показуємо тому що user явно ткнув
        return;
    }
    // detail-area вільна або з clean state → populate
    detailArea.load(newConflictId, ...);
}
```

UX-flow:

- Користувач має активну сесію конфлікту X, з history-блоками у RAM.
- Робить context-menu Compare on (A, B) → бачить Notice "Close current edit
  first to open: compare(A, B)"
- Він `[← back]` АБО `[×]` на конфлікт X.
- Detail-area стає вільна.
- Compare можна знов invoke → відкриється.

**Чому НЕ дозволяємо force-replace з discard:** користувач міг витратити 30
хвилин на конфлікт X, і випадковий context-menu клік не повинен втратити цю
роботу. Explicit close = explicit intent.

**Detection list of in-progress autosave sessions** — на disk-рівні через scan
`.diff2-autosave/` (О(N) by кількість директорій; типово N ≤ 5). У runtime ж
завжди тільки одна "active session" — це `detailArea.currentSession`. Без
in-memory index.

**Накопичення autosave dirs з минулих сесій — допустимо.** На диску може
лежати десятки `<conflictId>/` директорій від crash-нутих сесій минулого
(різні конфлікти, різні compare-пари, history-сесії). Вони живуть, поки
не зміниться SHA вхідних файлів (§4 cleanup), і не впливають на runtime
(тільки одна активна за раз). Recovery dialog (§3) показується при
відкритті того конфлікту, чий autosave ще валідний.

### §2.5 `meta.json` — схема і lifecycle

**Пишеться ОДИН РАЗ** при `openDiffPane(conflictId)` (старт сесії).
**КРИТИЧНО**: meta.json пишеться **ОСТАННІМ** у session-start protocol —
ПІСЛЯ створення обох snapshots + cursor-a.json + порожній history.jsonl.
Це дає strong invariant: **наявність meta.json гарантує наявність + валідність
всіх інших файлів та їх SHAs**.

Atomic-write (temp + rename), щоб torn-write не лишив пів-валідний файл.

Чому "один раз": усе, що змінюється під час сесії (cursor, edits) — або в
окремому файлі (cursor-a/b.json, §2.9), або в append-log (history.jsonl). Snapshots
ніколи не змінюються, бо це frozen baseline.

**Схема:**

```json
{
  "v": 1,
  "createdAt": "2026-05-29T14:32:11.842Z",
  "conflictId": "<same as parent directory name>",
  "basePath": "Notes/work/meeting-2026-05-28.md",
  "siblingPath": "Notes/work/meeting-2026-05-28.conflict-from-iphone-1716987131842.md",
  "baseShaAtStart": "a1b2c3d4...",
  "siblingShaAtStart": "e5f6g7h8...",
  "joinedDocSha": "f0e1d2c3..."
}
```

**Поля:**

- `v` — schema version. Bump при будь-якій incompatible зміні.
- `createdAt` — ISO timestamp старту сесії. Recovery dialog показує
  human-readable "X minutes ago".
- `conflictId` — duplicate of directory name; для cross-check.
- `basePath` / `siblingPath` — vault-relative paths.
- `baseShaAtStart` / `siblingShaAtStart` — git-blob SHA байтів **на момент
  snapshot creation**. **Не модифікуються** — це reference value для
  fast TOCTOU/recovery check без необхідності читати весь snapshot.
  Sanity-check на recovery: `sha(read("base.snapshot")) === meta.baseShaAtStart`
  має триматись; якщо ні — corruption → §4.2 cleanup.
- `joinedDocSha` — git-blob SHA рядка `build(base, sibling)` (`\0`/`\1` joined-doc).
  **Gate валідності replay**: replay проти входів `I` валідний ⟺ `SHA(build(I)) ===
  joinedDocSha`. Замінює стару пару `joinAlgoVersion`/`joinAlgoOptions` (рації — нота
  нижче). Ортогональний до input-SHA (ті керують вибором ДІАЛОГУ §3.2/§3.2.a).

**Примітка:** `historyFile` поле більше **не існує** — `history.jsonl` має
constant ім'я (§2.4).

> **`joinedDocSha` замість `joinAlgoVersion`/`joinAlgoOptions` — ✅ РЕАЛІЗОВАНО (3b-1,
> 2026-06-02; поле `joinedDocSha` у `AutosaveMeta`). Нижче — рації; бульйти "Як
> реалізувати"/"Наслідок" відбивають уже-виконаний план.**
>
> `joinAlgoVersion` був лише **проксі** до справжнього питання: *чи `build(base,
> sibling)` відтворює ТОЙ САМИЙ joined-doc, проти якого записувалась історія?*
> Replay позиціонує кожен `ChangeSet`/`structure` саме проти цього joined-doc —
> якщо `build` дасть інший вихід (інша версія diff-бібліотеки АБО навіть та сама
> версія з іншою поведінкою), усі offset'и зсунуться → replay зіпсує результат.
> Версія-рядок: (а) хибно тривожить при bump'і, що НЕ змінює вихід; (б) хибно
> довіряє при same-version divergence. Тому замість версії зберігаємо **прямий
> відбиток артефакту**:
>
> - **Схема:** прибрати `joinAlgoVersion` + `joinAlgoOptions`; додати
    > `joinedDocSha` = `calculateGitBlobSHA(utf8(build(base, sibling)))` — git-blob
    > SHA **joined-рядка** (`\0`/`\1` форма; вона серіалізує І clean-doc, І
    > structure-partition — точно те, проти чого позиціонована історія). Та сама
    > hash-функція, що для вхідних SHA (консистентність). НЕ хешувати `(doc,
>   structure)` окремо — joined-рядок є канонічним єдиним fingerprint'ом.
> - **Інваріант replay:** *replay проти входів `I` валідний ⟺ `SHA(build(I)) ===
>   meta.joinedDocSha`.*
> - **Ортогональність:** `joinedDocSha` — gate ВАЛІДНОСТІ replay; `baseShaAtStart`/
    > `siblingShaAtStart` — вибір ДІАЛОГУ (§3.2 чистий resume vs §3.2.a vault змінився).
    > Вони можуть РОЗХОДИТИСЬ: whitespace-only зміна входу, яку `diffLines` згортає,
    > лишає `joinedDocSha` рівним, хоча input-SHA інші → replay реально валідний, і
    > керує саме `joinedDocSha`. Зберігаємо ОБИДВА; `joinedDocSha` замінює лише версію.
> - **§3.2.a restore (Continue) теж під gate'ом:** при library-drift
    > `build(snapshot, snapshot)` ТЕЖ ≠ `joinedDocSha` → replay зі snapshot'ів так
    > само несоундний. Gate `SHA(build(snapshot)) === joinedDocSha` і в restore-шляху;
>   якщо ні → snapshot не врятує → start fresh.
> - **Детермінізм + trade:** працює, бо `build` — чиста детермінована функція
    > `(base, sibling)` + бібліотеки. Gate міняє рідкісний *спекулятивний* start-over
    > (якби build колись став недетермінованим) на *ніколи не псувати replay тихо* —
    > і spurious start-over коштує лише WIP, ніколи не входи (входи незмінні). Не
    > «оптимізувати» gate геть.
> - **Ordering dependency:** `build()` кидає на `\0`/`\1` collision (§1.3). Обчислення
    > `joinedDocSha` у session-start припускає collision-free вхід — тобто
    > `findSentinelCollision` (mount-шлях, §1.3) вже відпрацював. Або ставити
    > обчислення за тим самим guard'ом.
> - **Як реалізувати (sequencing):** оскільки `joinedDocSha` споживає reopen-логіка
    > 3b, реалізувати ЯК ЧАСТИНУ 3b, а не пізніше — і **НЕ кодувати `joinAlgoVersion`-гілку
    > в 3b** (її ж видаляємо). `startSession` обчислює `build()` раз; щоб не рахувати
    > двічі, прокинути joined-doc, який mount-шлях вже будує, у `startSession`.
> - **Наслідок:** видалити рядок `joinAlgoVersion ≠ поточна` з §3.5; переписати
    > §3.1 reopen-гілку навколо інваріанта вище. Опційно лишити версію-рядок як
    > **diagnostics-only** поле (НІКОЛИ не для рішення) заради дружнього повідомлення
    > «diff не вдалося відтворити» — але за замовчуванням прибрати.

#### §2.5.a Session-start protocol — ordering guarantee

При `openDiffPane(conflictId)` для **нової** сесії (autosave-dir не існує)
init виконується у строгому порядку, де **meta.json пишеться ОСТАННІМ**:

```
Step  1. mkdir .diff2-autosave/<conflictId>/  (idempotent)

Step  2. baseBytes    = await vault.adapter.readBinary(basePath)
Step  3. siblingBytes = await vault.adapter.readBinary(siblingPath)
Step  4. baseShaAtStart    = sha(baseBytes)     // in-memory hash
Step  5. siblingShaAtStart = sha(siblingBytes)

Step  5.5 (§2.5 joinedDocSha). joined = build(decode(baseBytes), decode(siblingBytes))
          joinedDocSha = sha(utf8(joined))
          // ВСЕ in-memory, ДО будь-якого disk-write. meta.json write-once
          // immutable і несе joinedDocSha → build + hash МУСЯТЬ передувати
          // step 10. build() кидає на \0/\1 collision — collision-free гарантує
          // findSentinelCollision у mount-шляху (§1.3), який біжить ПЕРЕД цим.
          //
          // SINGLE-READ INVARIANT (TOCTOU): baseShaAtStart, siblingShaAtStart,
          // joinedDocSha І обидва snapshot'и МУСЯТЬ бути похідними від ОДНОГО
          // читання вхідних файлів (тих самих буферів baseBytes/siblingBytes зі
          // step 2-3). Перечитування vault між ними → файл міг змінитись →
          // SHA-и розсинхронізуються і meta стає внутрішньо суперечливим. Тому
          // build бере decode(baseBytes), а НЕ окремий adapter.read.
          // Оптимізація «не білдити двічі» (mount уже будує joined для рендера)
          // допустима ЛИШЕ якщо mount передасть startSession І байти, І joined з
          // того САМОГО read; інакше — startSession читає раз і білдить сам
          // (подвійний build — дешева перф-дрібниця проти ризику десинхрону).

Step  6. atomicWriteFile(.diff2-autosave/<conflictId>/base.snapshot,    baseBytes)
Step  7. atomicWriteFile(.diff2-autosave/<conflictId>/sibling.snapshot, siblingBytes)

Step  8. atomicWriteFile(.diff2-autosave/<conflictId>/cursor-a.json,
                          JSON.stringify({v:1, seq:0, anchor:0, head:0, scrollTop:0, savedAt: now()}))
                          // 2-slot ping-pong (§2.9); cursor-b.json зʼявляється на 1-му flush

Step  9. atomicWriteFile(.diff2-autosave/<conflictId>/history.jsonl, "")  // empty file

Step 10. atomicWriteFile(.diff2-autosave/<conflictId>/meta.json, {
             v: 1,
             createdAt: now(),
             conflictId,
             basePath,
             siblingPath,
             baseShaAtStart,    // bytes-binding: гарантовано match snapshot
             siblingShaAtStart,
             joinedDocSha,      // §2.5: замінив joinAlgoVersion/joinAlgoOptions (3b-1)
         })
         // ← COMMIT POINT. Якщо crash до цього кроку — на recovery нема
         //    meta.json → cleanup (умова 1 §4.2) → fresh session.
         //    Якщо crash після — meta.json гарантовано має валідні SHAs
         //    що match snapshots (because SHAs computed з in-memory bytes,
         //    written у snapshots у steps 6-7).
```

**Strong invariant**: `meta.json exists ⇒ всі п'ять обов'язкових файлів існують
і SHAs у meta точно match snapshot bytes.` Це дозволяє recovery code на пізніших
етапах **довіряти** meta.json без додаткової sanity-перевірки sha-of-snapshot —
якщо тільки storage не corrupted (rare).

(Recovery §4.2 умова 5 sanity-check `sha(read("base.snapshot")) === meta.baseShaAtStart`
все ще запускається як defence in depth — для catch'у дискових bit-flip.)

#### §2.5.b Reuse-snapshot optimization при reopen після crash

При `openDiffPane(conflictId)` якщо у `.diff2-autosave/<conflictId>/`
існує валідний meta.json + snapshots (це може статись тільки після crash
чи tab-switch — нормальне `[← back]` цю директорію видалило б):

```
parse meta.json
currentBaseSha    = sha(vault[basePath])
currentSiblingSha = sha(vault[siblingPath])

if (currentBaseSha === meta.baseShaAtStart
    AND currentSiblingSha === meta.siblingShaAtStart):
    → Vault unchanged since session start (relative до crash point).
    → **Reuse existing snapshots** — не перезаписуємо, не recompute.
    → Скіп step "copy basePath → base.snapshot" (вже актуальне).
    → Continue з recovery flow §3 (show "Resume previous edit session?" dialog).

else:
    → Vault changed during edit session.
    → НЕ перезаписуємо snapshots і НЕ перезаписуємо meta — стара версія
      залишається ground-truth.
    → Trigger §3.2.a recovery dialog (форма — див. §3.2.a).
```

**Чому це важлива оптимізація:** після crash зазвичай vault unchanged (типовий
випадок: low-memory kill, користувач відразу перевідкриває). Skip re-copy
снапшотів великих файлів економить I/O на старті recovery. Для робастності —
sanity-check `sha(read("base.snapshot")) === meta.baseShaAtStart` на старті
ВСЕ ОДНО запускаємо (cheap і catches storage corruption).

### §2.6 `history.jsonl` — формат REDO-блоку

**NDJSON** (Newline-Delimited JSON): один redo-блок = один рядок. Append-only.
Файл росте, existing content не модифікується.

> **Pre-Rep-A reconciliation (Stage 3, 2026-06-02).** Оригінальний §2.6 (до §1
> Rep-A) мав `{seq,at,change,sum}` — лише `ChangeSet.toJSON()`. **Gate-спайк
> `tests/diff2/spikes/history-replay-structure-spike.test.ts` довів, що
> change-only НЕ відновлює `Segment[]` structure**: (a) chunk-action диспатчить
> `setDiffPaneState` (повна заміна doc + нова structure) — ефект, не derivable
> з doc; (b) free-edit при активному empty-ver залежить від `activeEmptyVer`
> через `growIndexFor`, якого replay не має → росте не той сегмент. **Тільки
> плоский free-edit** відновлюється через `mapStructure`. Тому блок зберігає
> **structure у КОЖНОМУ блоці** (format B — bulletproof, version-independent,
> у дусі Rep-A «structure авторитетна»), а не лише в effect-блоках (format C,
> який провалює empty-ver-typing). Replay: `update({changes, effects:
> setDiffPaneState.of({structure})})` — задає structure напряму, replay стає
> чистою функцією логу (без залежності від відтворення caret/activeEmptyVer).

**Формат рядка:**

```json
{
  "seq": 1,
  "at": "2026-05-29T14:32:15.103Z",
  "change": <ChangeSet.toJSON>,
  "structure": <Segment[]>,"sum": "7b2a"
}
```

**Поля:**

- `seq` — монотонний номер блоку від 1. Для діагностики (replay лінійний —
  читаємо файл згори донизу). Можна пропустити при пошкодженні.
- `at` — ISO timestamp коли transaction відбулась.
- `change` — `ChangeSet.toJSON()` для цієї CM6 transaction. JSON-сумісний
  об'єкт без circular refs / functions (verified у Phase 5 spike).
- `structure` — post-transaction `Segment[]` (`{role,group,from,to}[]`) — стан
  structure-field ПІСЛЯ цієї transaction. Replay задає його напряму через
  `setDiffPaneState`, тож ролі ver1/ver2/normal відновлюються точно (gate-спайк).
- `sum` — checksum для виявлення torn-write або disk-corruption. Рахується над
  серіалізацією `change` **і** `structure` (обидва впливають на replay).

**Checksum (`sum`):**

Простий алгоритм, не криптостійкий. Кандидат: FNV-1a 32-bit над JSON-серіалізацією
поля `change` (з тими ж options, що при write). Hex-encoded.

Точний вибір алгоритму — implementor; контракт: `recompute(block.change) === block.sum`
→ блок OK; інакше → блок corrupt, replay зупиняється на цьому блоці.

**Чому не зберігаємо cursor у блоці:** він в окремому файлі (§2.9), оновлюється
по таймеру — окрема життєва логіка, окрема crash-window. Якщо б ми зберігали
cursor у кожному redo-блоці, він "застрягав би" на момент останньої transaction
і не оновлювався під час навігації.

### §2.7 Append через `vault.adapter.append`

**API підтверджено:** `vault.adapter.append(normalizedPath, data, options?)`
існує в `DataAdapter` (`obsidian.d.ts:996`).

**Доказ що працює на mobile:** наш `src/logger.ts:131` використовує цей API
для logger; logger mobile-safe (iOS + Android). Pattern "NDJSON-рядок + `\n` per
call" — proven у production. Не потрібно ні read-modify-write, ні file handles,
ні OS-level append-mode.

### §2.8 Coalesce window — flush triggers

> **РАТИФІКОВАНО бенчмарком (Android mid-tier, 2026-06-03): coalesce НЕ використовуємо —
> append per CM6 transaction.** `single-append p95 = 3.10 ms` (max 23.70, n=200) → band
> §6.2 `< 10 ms` → «Append per CM6 transaction, no coalesce. Найпростіша імплементація.»
> `HistoryWriter` flush'ить кожну транзакцію негайно (queue cap=1 за фактом). Таблиця
> нижче (idle/typing-pause/queue-cap машинерія) **збережена як contingency-дизайн** на
> випадок, якщо на іншій платформі p95 виросте — production-шлях її не активує.

**Contingency-дизайн (НЕ активний):** тримати in-memory pending-queue redo-блоків,
flush по одній з чотирьох умов:

| Тригер                            | Інтервал / умова                                                             | Раціонал                                                                                                                       |
|-----------------------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| 1. **Inter-keystroke idle**       | ≥150 ms з останньої tx                                                       | Користувач зробив паузу в межах "набору". Невелика — щоб не накопичити багато; основний intra-burst tripwire.                  |
| 2. **Typing-pause to navigation** | ≥500 ms з останньої tx ТА відбулась navigation event (caret move без change) | Користувач перестав друкувати і "вийшов" у режим навігації. Цей сценарій займає ~80% сесії; його flush — головний.             |
| 3. **Queue cap**                  | queue ≥10 блоків                                                             | Safety net на випадок безперервного "stress typing" — щоб RAM не залишався не-flushed.                                         |
| 4. **Explicit close**             | Перед `[←]` / `[x]` exit                                                     | Гарантує, що останні до-500ms не загубляться при штатному виході. Flush обов'язково ДО vault-write і ДО `rmdir(autosave-dir)`. |

При flush — один `adapter.append` пише конкатенацію pending-блоків:
`block1\n` + `block2\n` + ... + `blockN\n`. NDJSON природно стрімовий.

**Crash window для history-log:**

- Найгірший випадок: 500 ms (typing-pause-to-nav window), за умови що queue не
  заповнився раніше. Зазвичай — ≤150 ms.
- Користувач втрачає максимум ~5 keystrokes (на швидкості 10 keystroke/sec).

**Це НЕ суперечить принципу "REDO-блок одразу пишеться на диск"** з оригінального
R7.7.a. 150-500 ms — не "ой я забув"-throttle, а нормальний micro-batching.
Семантично — той самий append-only лог.

**Рішення прийняте (2026-06-03):** Android-бенчмарк дав `p95 = 3.10 ms` → coalesce
**викинуто**, append per-transaction (див. банер угорі §2.8). Значення 150/500/10
лишаються лише як contingency на випадок регресу швидкості на іншій платформі.

### §2.9 cursor — окремий файл, 2-слот ping-pong (timer-based)

> **ЄДИНЕ ДЖЕРЕЛО для cursor-механіки.** Усі інші розділи лише іменують файли
> (`cursor-a.json`/`cursor-b.json`) або посилаються сюди — не повторюють логіку.
> **Code-lag:** дизайн РАТИФІКОВАНО, але код `cursor-store.ts` ще atomic single-file
> (`cursor.json`); ping-pong rewrite = **W3** (marker у файлі). Доки канон випереджає код.

**Окремий файл** для cursor position. **Створюється одразу при старті сесії**
(slot `cursor-a.json`, `seq:0`, `anchor:0, head:0, scrollTop:0`) — щоб після
старту в директорії були всі обов'язкові файли. Після ініціалізації —
перезаписується по таймеру через **2-слотовий ping-pong** (нижче; РАТИФІКОВАНО
2026-06-04 — замінює atomic temp+rename). Не входить у history-log, не залежить
від CM6 transactions.

**Чому окремо:**

- REDO-блоки append-only і прив'язані до **modifications**. Якщо б cursor сидів
  у кожному redo-блоці, він "застрягав би" на момент останньої modification, а
  не реальну позицію курсора у момент crash.
- Користувач ~80% сесії — навігує, не друкує. Навігація не тригерить history-log
  writes (нема нічого записувати), але cursor під час навігації все ж змінюється —
  отже окремий timer-driven файл.
- Окремий файл легко skip-нути при recovery, якщо він corrupt — просто не
  встановлюємо cursor, fall back на natural-after-replay position.

**Схема (кожен slot — `cursor-a.json` / `cursor-b.json`):**

```json
{
  "v": 1,
  "seq": 42,
  "anchor": 1247,
  "head": 1247,
  "scrollTop": 8420,
  "savedAt": "2026-05-29T14:33:42.119Z"
}
```

**Поля:**

- `seq` — монотонний лічильник запису. **Єдиний ключ відновлення** (recovery
  бере slot з найбільшим валідним `seq`). Не залежить від годинника.
- `anchor` / `head` — позиції caret у документі (`view.state.selection.main`).
  Для звичайного caret `anchor === head`; для активного selection — різні.
- `scrollTop` — позиція scroll (опційно; UX-bonus, recovery працює і без нього).
- `savedAt` — ISO timestamp останнього таймер-flush. Лише для діагностики
  staleness / tiebreak (НЕ ключ відновлення — годинник ненадійний).

**Запис — 2-слотовий ping-pong (РАТИФІКОВАНО 2026-06-04).** Замість atomic
temp+rename (на Capacitor `rename` коштує p95≈28ms ТА має вузьке zero-cursor
вікно між `remove(dst)` і `rename`) — пишемо у НЕактивний з двох слотів простим
`adapter.write` (свіжий write ≈3ms — як history-append, §6 benchmark):

```typescript
async function persistCursor() {
    const a = await readSlot("cursor-a.json"); // null якщо нема / torn / bad JSON
    const b = await readSlot("cursor-b.json");
    const seqA = a?.seq ?? -1, seqB = b?.seq ?? -1;
    // Пишемо у слот зі СТАРІШИМ seq (стейл); новий seq = max+1.
    const slot = seqA <= seqB ? "cursor-a.json" : "cursor-b.json";
    const next = {...currentCursor, seq: Math.max(seqA, seqB) + 1};
    await vault.adapter.write(
        `.diff2-autosave/${conflictId}/${slot}`, JSON.stringify(next),
    );
}
```

**Чому це безпечно (атомарність без rename):** завжди рівно ≤2 слоти,
перезаписуються in-place. Пишемо у слот зі старішим `seq` → активний (новіший)
слот лишається ЦІЛИМ. Crash посеред write → torn-слот має старіший seq, recovery
бере інший (цілий, новіший). Жодного `remove`/`rename`, жодного zero-cursor
вікна, жодного накопичення (на відміну від безмежного `cursor-N`).

**Таймер (РАТИФІКОВАНО бенчмарком, Android 2026-06-03):** **2500 ms active /
6000 ms navigation** (§6.2). Бенчмарк мірив atomic-rewrite (p95≈28ms); ping-pong
write дешевший (≈3ms), але cadence лишаємо — recovery-точність на 2.5с достатня,
а курсор некритичний (torn/відсутній → natural-after-replay). Дешевший write —
запас на майбутнє (можна частіше без jank, якщо знадобиться).

| Режим           | Інтервал (запінено) | Раціонал                                                                                                          |
|-----------------|---------------------|-------------------------------------------------------------------------------------------------------------------|
| Active typing   | **2500 ms**         | Користувач друкує, cursor рухається швидко. Коротший інтервал → точніший recovery, але 28ms rewrite ⇒ не частіше. |
| Pure navigation | **6000 ms**         | Користувач лише сканує / читає. Cursor зрушується повільніше; рідше переходить у нову позицію.                    |

**Як визначаємо "active typing" vs "pure navigation":** простий debounce — кожна
CM6 transaction скидає таймер у "active" режим на ≥3 секунди. Після 3 секунд без
transactions — переходимо в "navigation" таймер.

**Дві умови запису (gate — §8 #9, battery):** таймер (а) працює **ЛИШЕ коли редактор
у фокусі редагування** (не-фокус / Obsidian backgrounded → таймер не тикає), і (б) пише
слот **ЛИШЕ якщо позиція (anchor/head/scrollTop) змінилась** із попереднього запису
(dirty-check) — інакше no-op. Тож idle / background не дають ні зайвих writes, ні
battery-drain; окремої "pause when backgrounded" логіки не треба.

**Crash window для cursor:**

- Active typing: до 2 сек назад. У найгіршому випадку cursor десь на 5-10
  символів назад. Користувач не помітить.
- Pure navigation: до 5 сек назад. Cursor може бути на пару рядків назад.
  Прийнятно.
- **Pathological case:** користувач натиснув `[Home]` / `[End]` / `Ctrl+End`
  одразу перед crash, ще до того, як cursor-timer спрацював, → активний
  cursor-слот лишається на попередній позиції. Recovery поставить cursor "не
  туди". Acceptable trade-off: цей сценарій рідкісний, і користувач легко
  переходить заново (`[End]` → 1 keystroke). Інтервал 0.5 сек чи менше не
  врятував би в реальному use.

**Recovery поведінка:**

1. Спершу replay history-log (§3.3).
2. Прочитати ОБИДВА слоти `cursor-a.json` / `cursor-b.json`; кожен parse'иться
   незалежно (torn/bad-JSON → відкинути). Узяти валідний слот з **найбільшим
   `seq`**. Якщо є → set `view.state.selection` згідно з `{anchor, head}`. Якщо
   `anchor > doc.length` → clamp to `doc.length` (документ міг скоротитись через
   replay).
3. Якщо `scrollTop` присутній → `view.scrollDOM.scrollTop = saved.scrollTop`.
4. Якщо ЖОДНОГО валідного слота нема → не set-имо selection; CM6 поставить
   caret природним шляхом (після останньої заміни — наближення §2.9 fallback).

**Якщо обидва слоти відсутні/corrupt**: recovery працює, cursor "де природно
опинився після replay" (зазвичай — кінець останньої зміни). Прийнятно як fallback
(курсор некритичний).

### §2.10 Підсумок: що, коли і куди пишеться

```
┌─────────────────────────────────┬──────────────────────────────────┐
│ Подія                           │ Дія на диск                      │
├─────────────────────────────────┼──────────────────────────────────┤
│ openDiffPane(conflictId)        │ Write meta.json (once, atomic)   │
│                                 │ + Write cursor-a.json (seq 0)    │
│ CM6 transaction (apply/edit)    │ Append history-block per tx      │
│                                 │ (NO coalesce — bench 3ms, §2.8)  │
│ Active typing every 2500 ms     │ ping-pong write cursor slot §2.9 │
│ Navigation every 6000 ms        │ ping-pong write cursor slot §2.9 │
│ `[←]` exit (7-step §5.0)        │ Flush queue → write done.json    │
│                                 │ (SHAs) → write sync-tmp pair →   │
│                                 │ rename pair to .sync-bak →       │
│                                 │ rename sync-tmp to originals →   │
│                                 │ delete .sync-bak → R7.11 sibling │
│                                 │ cleanup → rmdir autosave-dir     │
│ `[x]` tab close                 │ Flush queue (optional, no-op) →  │
│                                 │ rmdir autosave-dir               │
│ Crash                           │ Nothing happens; on-disk state   │
│                                 │ survives                         │
└─────────────────────────────────┴──────────────────────────────────┘
```

---

## §3. R7.7.b — Recovery dialog

### §3.1 Trigger

На вході в `openDiffPane(conflictId)`:

```
1. Read base bytes from vault, compute SHA → currentBaseSha
2. Read sibling bytes from vault, compute SHA → currentSiblingSha
3. Check existence of .diff2-autosave/<conflictId>/meta.json:
   - absent → fresh session, no dialog (create autosave dir from scratch:
     copy basePath → base.snapshot, copy siblingPath → sibling.snapshot,
     write meta.json, init cursor-a.json (seq 0) — §2.9 ping-pong)
   - present → read meta.json
     - JSON.parse fails → cleanup `<conflictId>/`; fresh session
     - sanity-check: sha(read("base.snapshot")) === meta.baseShaAtStart
       AND sha(read("sibling.snapshot")) === meta.siblingShaAtStart
       → If false → corruption; cleanup; fresh session (§4.2 condition 5)
     - **replay-validity gate** (§2.5 `joinedDocSha`):
       `SHA(build(currentBase, currentSibling)) === meta.joinedDocSha`?
       → НЕ збігається І входи незмінні → **library-drift** → start fresh без діалогу
         (restore зі snapshot теж не відтворить; §3.5 / §8 #8). Збігається → продовжуємо нижче.
     - **NEW branch — snapshot vs current vault check:**
       - If currentBaseSha === meta.baseShaAtStart
         AND currentSiblingSha === meta.siblingShaAtStart
         → Vault unchanged since session start → §3.2 normal recovery dialog
       - Else (one or both vault files changed during session/offline)
         → §3.2.a snapshot-mismatch recovery dialog
```

### §3.2 Modal — контракт UX (ЄДИНИЙ recovery-modal)

`ResumeRecoveryModal` — один модаль для будь-якої перерваної сесії (resume І §3.2.a
one-side-changed). `*` маркує файл, що змінився у Vault під сесією (на чистому resume `*` нема).

```
┌───────────────────────────────────────────────────────────────────┐
│  Resume previous edit session?                              [×]   │
│                                                                   │
│  We found an unfinished edit session for:                         │
│  * base:  Notes/work/meeting.md                                   │
│  sibling: Notes/work/meeting.conflict-from-iphone-….md            │
│                                                                   │
│  Started:   12 minutes ago                                        │
│  Edits:     17 saved                                              │
│  Last:      14:32:15                                              │
│                                                                   │
│  * this file changed in the vault since the last editing session. │
│                                                                   │
│       [ Continue editing ]   [ Start over ]   [ Cancel ]          │
└───────────────────────────────────────────────────────────────────┘
```

**Кнопки:**

- **[Continue editing]** — primary. Дія залежить від reopen-стану: resume → replay
  REDO-log + cursor (§3.3, KEEP dir); §3.2.a one-side → перенести правку (механіка §3.2.a).
- **[Start over]** — wipe `.diff2-autosave/<conflictId>/`, fresh session з vault-state.
- **[Cancel]** / **[×]** — назад у list view; autosave **лишається** на диску.

`*`-маркер + зноска з'являються лише коли сторона змінилась (§3.2.a one-side); на чистому
resume їх нема.

### §3.2.a Vault-changed recovery — СИМЕТРИЧНО, реюзає §3.2 modal

Редактор працює і з парою base+sibling, і з **довільними file1/file2** (напр. Compare) —
**жодна сторона не привілейована**, тож відновлення симетричне. На reopen дивимось, ЯКІ
vault-файли змінились під сесією (`SHA(side) ≠ meta`):

- **Жодна не змінилась** (resume) → §3.2 `ResumeRecoveryModal`; Continue = replay-resume.
- **Рівно ОДНА сторона змінилась** → **той самий §3.2 modal** (`*` маркує змінений файл —
  без окремого лякливого «files changed»-діалогу: це просто відновлення від збою). Типово:
  після збою користувач відредагував САМ один файл напряму (§7). Стан резолюції
  (повне/часткове) **не має значення**. Дія Continue — нижче.
- **ОБИДВІ змінились** → **тихо нова сесія, без діалогу** (`reopenAction`:
  `discard-fresh "both-changed"`): правки повністю застаріли, зберігати нема що.

**Continue-механіка (one-side) — СЕСІЯ ПЕРЕСТВОРЮЄТЬСЯ (НЕ auto-merge), СИМЕТРИЧНО:**
записуємо відновлений вміст у сторону, чий **vault-файл НЕ змінився** (зберігаємо там
правку); за зміненою стороною лишаємо новий vault-вміст (її restored-вміст відкидається).

1. `resolved = getResolved()` — реплей у **DETACHED** pane (`{base, sibling}` / `{file1, file2}`);
2. перезаписати **незмінну** сторону її restored-вмістом (`atomicWriteFile`; вільно
   мутабельна §4.2/§5.2); змінену **НЕ чіпаємо**:
   - змінився base → пишемо `resolved.sibling` у `siblingPath`;
   - змінився sibling → **дзеркально** `resolved.base` у `basePath`;
3. `rmdir` стару сесію → `startSession` → нова diff-сесія: нова версія зміненої сторони vs
   restored-вміст незмінної.

- **[Start over]** → `rmdir` (нічого не пишемо) → `startSession` з поточного vault.
- **[Cancel]** → назад у list (dialog-first: нічого не змонтовано); autosave лишається.

**Чому безпечно й просто:** усе **diff2-layer** — нема merge-base, нема auto-merge (нова
сесія порівнює локально; запис у незмінну сторону — легітимна §4.2-мутація, що auto-merge
НЕ тригерить, §4.1/§6). Recreate'нута сесія має snapshots == поточний vault, тож на
`[← back]` exit-TOCTOU (§5.0) у §3.2.a-шляху **не спрацьовує**.

### §3.3 Continue editing — replay algorithm

```
1. Build joined doc from the SESSION-START SNAPSHOTS (NOT current vault bytes):
   doc = build(read("base.snapshot"), read("sibling.snapshot"))
   — recorded ChangeSets are offsets into the snapshot-built clean doc; current
   bytes may differ (cosmetic, or §3.2.a vault-changed) and mis-apply them.
   (§3.2.a opt(1) already reads snapshots; W4a correctness pin.)
2. Initialize EditorState with doc, history({newGroupDelay: 0}), other extensions
3. Open file: history.jsonl (path from meta.historyFile)
4. Read line-by-line:
   a. line.trim() === "" → skip
   b. JSON.parse(line) → block; if fails → "corrupt", break
   c. Validate: recompute(block.change) === block.sum; if false → break
   d. ChangeSet.fromJSON(view.state, block.change) → cs
   e. view.dispatch(view.state.update({changes: cs, sequential: true}))
5. If reached EOF без corrupt → "all N edits restored"
6. If stopped mid-stream (corrupt block K) → "recovered K of N edits"
   - Show non-blocking Notice
   - State є post-block-(K-1)
7. Apply cursor (§2.9 2-slot ping-pong) if present:
   a. Read cursor-a.json + cursor-b.json; pick the valid (parseable) slot with
      the MAX `seq`. If neither is valid → skip cursor apply.
   c. anchor = clamp(saved.anchor, 0, doc.length)
   d. head = clamp(saved.head, 0, doc.length)
   e. view.dispatch({selection: {anchor, head}})
   f. if saved.scrollTop → view.scrollDOM.scrollTop = saved.scrollTop
```

**Чому `view.dispatch` (не direct state mutation):** dispatch автоматично пише
undoable step у CM6 historyField. Після replay історія undo така ж, як перед
crash — `Ctrl+Z` йде назад послідовно.

### §3.4 Start over — wipe + fresh

```
1. await vault.adapter.rmdir(`.diff2-autosave/${conflictId}`, true)  // recursive
2. Continue normal openDiffPane flow:
   - build joined doc з current base + sibling (тут current = коректно: fresh-session
     snapshots стають = current vault)
   - new meta.json + new history.jsonl + new base.snapshot/sibling.snapshot +
     new cursor-a.json (seq 0)
   - DiffPane opens fresh
```

### §3.5 Edge cases — повна таблиця

| Випадок                                                                           | Поведінка                                                                                                                                                                                                                           |
|-----------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `meta.json` присутній, `history.jsonl` відсутній                                  | Cleanup `<conflictId>/` цілком (§4.2 умова 2); fresh session без modal.                                                                                                                                                             |
| `meta.json` валідний, `history.jsonl` має 0 рядків                                | Modal **не показуємо** (фактично нема edits); видалити stale autosave; fresh session.                                                                                                                                               |
| `meta.json` corrupt JSON                                                          | Cleanup `<conflictId>/` цілком, fresh session (§4.2 умова 1).                                                                                                                                                                       |
| обидва cursor-слоти (cursor-a/b) відсутні | Cleanup `<conflictId>/` цілком (§4.2 умова 3); fresh session.                                                                                                                                                                       |
| `meta.json` валідний, перший блок `history.jsonl` corrupt                         | Modal показує "0 edits saved" + warning "previous session corrupt"; `[Continue]` disabled; доступний лише `[Start over]`.                                                                                                           |
| `meta.json` + redo OK, обидва cursor-слоти corrupt | Modal показуємо normally; `[Continue]` replay-ить redo; cursor — natural (§2.9). Logged warning.                                                                                                               |
| `meta.json` + redo OK, cursor-слот має `anchor > doc.length` | Clamp до `doc.length` (§2.9). Cursor у кінці документу.                                                                                                                                                                                    |
| Замінено base / sibling (SHA mismatch) між sessions                               | Cleanup (§4.2 умова 5); fresh session; modal не показуємо.                                                                                                                                                                          |
| `SHA(base) === SHA(sibling)` (auto-resolved)                                      | Cleanup (§4.2 умова 6); конфлікт фактично зник.                                                                                                                                                                                     |
| **library-drift** — `SHA(build(input)) ≠ meta.joinedDocSha` при незмінних входах (§2.5 gate; `joinAlgoVersion` ВИДАЛЕНО — 3b-1) | replay неможливий → **start fresh без modal** (restore зі snapshot теж не врятує). Жодного confirm-prompt. |
| `basePath` / `siblingPath` зник з vault                                           | Cleanup на onload sweep (§4.2 умова 4).                                                                                                                                                                                             |

---

## §4. Cleanup / TTL

### §4.1 Принцип: history-logs живуть вічно, поки релевантні

Користувач має право:

- Залишити конфлікт незакритим на тижні чи місяці.
- Мати десятки `<conflictId>/` одночасно.
- Повернутись до будь-якого в будь-який час.

**Безкоштовно**, поки SHA вхідних файлів не змінились і запис конфлікту існує.
Дисковий слід — кілька kB на сесію (cursor-a/b.json ~200 байт each, meta.json ~500 байт,
history-jsonl — пропорційний edit-кількості, типово 1-50 kB).

### §4.2 Onload sweep — умови видалення

**Pre-check (precedence):** якщо у `<conflictId>/` присутній `done.json` —
це commit-in-progress; **НЕ** запускаємо §4.2 cleanup, натомі сть викликаємо
§5.0.a recovery sweep (roll-forward або rollback залежно від стану vault).
Тільки якщо §5.0.a fall-through на default fallback → переходимо до §4.2.

При plugin onload (інтегровано у `onloadRecoverySweep` — Phase 11 плану, R8.2)
для кожної директорії `<conflictId>/` у `.diff2-autosave/` БЕЗ done.json
перевіряємо:

```
for each <conflictId>/ in .diff2-autosave/:
    cleanup-причини (OR-сум — досить однієї):
        (1) в директорії немає meta.json
            (АБО meta.json не парситься як JSON)
        (2) в директорії немає history.jsonl (constant name)
        (3) в директорії немає ЖОДНОГО cursor-слота (cursor-a.json / cursor-b.json)
            (cursor-a створюється при старті сесії — §2.9 ping-pong; якщо жодного
             нема — щось пішло не так на старті, лікуємо cleanup-ом)
        (4) в директорії немає base.snapshot АБО sibling.snapshot
            (snapshots обов'язкові; відсутність = corrupted autosave)
        (5) SHA snapshot-файлів НЕ матчиться з записаним у meta
            (sha(read("base.snapshot")) ≠ meta.baseShaAtStart АБО
             sha(read("sibling.snapshot")) ≠ meta.siblingShaAtStart)
            — corruption detection; meta і snapshots мають бути узгодженими
        (6) одного з вхідних файлів немає у vault
            (basePath АБО siblingPath НЕ exist)
        (7) SHA обидвох вхідних файлів у vault однакові
            (SHA(vault[basePath]) === SHA(vault[siblingPath]))
            — конфлікт фактично self-resolved у vault; autosave безглуздий
    if any of (1)-(7):
        vault.adapter.rmdir(`.diff2-autosave/${conflictId}`, true)
        log info "swept autosave: <conflictId> (reason: <N>)"
```

**Важлива зміна порівняно з попереднім дизайном**: умова "SHA(vault[basePath]) ≠
meta.baseShaAtStart" **більше НЕ cleanup-тригер**. Раніше — wipe autosave якщо
vault змінився. Тепер: vault-mismatch — це **trigger для recovery dialog** (§3.2.a),
де користувач сам вибирає (Continue / Start over / Cancel), а не silent wipe.
Завдяки snapshots ми відновлюємо роботу й несемо restored-вміст незмінної сторони далі (§3.2.a).

**Чому умова (6) — `SHA(base) === SHA(sibling)`** включена окремо: якщо файли
зрівнялись (через sync2 auto-merge на drain, ручне зведення, чи зовнішнє
редагування) — конфлікту нема. Жодна з умов (1)-(5) це сама по собі не
покриває (вхідні файли можуть лишатись на місці з оригінальними SHAs);
треба експліцитна перевірка.

**Note про "конфлікт зник з ConflictStore" як окрему умову:** покривається
сценаріями (4), (5), (6) на практиці — конфлікт зникає або через delete
файлу (4), або через зміну SHAs (5), або через зведення SHAs (6). Окрема
"conflictId not in store" умова — redundant у нормальному flow; пропускаємо.

### §4.3 Sweep idempotent

Повторні sweep-и безпечні. Wired через єдину точку `onloadRecoverySweep` (R8.2).

### §4.4 Manual cleanup

`.diff2-autosave/` лежить у vault і видимий у file explorer (як `.trash/`,
`.conflicts/`). Видалення вручну допустимо. Наступне відкриття будь-якого
конфлікту почнеться як fresh session.

---

## §5. `[← back]` exit algorithm + R7.7.c/R7.7.d interfaces

### §5.0 `[← back]` — 7-step pair-atomic commit з `done.json` barrier

`[← back]` — це **точка коміту** обох сторін конфлікту назад у vault. Замість
наївного "записати буфер у один файл", алгоритм використовує `split()` (§1.4)
для отримання **обидвох** виходів і pair-atomic 2-phase commit protocol з
`done.json` як commit barrier.

**Чому 2-phase commit, а не два послідовних `atomicWriteFile`:** простий
sequential підхід може загубити користувацькі edits ver2-сторони при crash
між write base і write sibling — користувач натиснув `[← back]`, базовий
файл оновився, а sibling лишився старим, на наступному відкритті ver2-edits
silent зникають. 7-step protocol з pre-computed SHAs у `done.json` робить
recovery **deterministic**: на reopen знаємо точно, який стан target і
можемо roll-forward завершити commit.

**Naming convention** — `stagingPathFor()` з `src/sync2/atomic-write.ts`,
існуючий pattern: insert suffix перед extension:

- `"Folder/note.md"` → `"Folder/note.sync-tmp.md"` / `"Folder/note.sync-bak.md"`
- `".gitignore"` → `".gitignore.sync-tmp"` / `".gitignore.sync-bak"` (без ext → append)
- `"file.tar.gz"` → `"file.tar.sync-tmp.gz"` (insert before LAST ext)

Усі стейджинг файли видимі в Obsidian file explorer і indexed (на відміну
від схеми "append after ext", яка б їх скрити при "Show all file types: false").

**`done.json` — commit barrier з pre-computed expected SHAs:**

```json
{
  "v": 1,
  "writtenAt": "2026-05-29T14:45:00.000Z",
  "expectedBaseSha": "<git-blob-sha hex>",
  "expectedSiblingSha": "<git-blob-sha hex>"
}
```

Пишеться atomic temp+rename, БЕЗПОСЕРЕДНЬО перед staging files. Її наявність
сигналізує "commit-in-progress, roll-forward via recovery". Її відсутність →
"no commit started" (autosave-recovery працює як завжди).

**UI guard (Step 0):** при першому кліку на `[← back]` view-state set-ить
`committing = true`; button disabled; повторні кліки rejected до завершення
commit (success / error). Без цього guard'а другий клік під час in-flight
commit (тобто між step 2 і step 7) міг би стартувати другий пройдення, що дає
undefined vault state.

```typescript
async function onBackClick() {
    if (this.state.committing) return;  // ignore
    this.state.committing = true;
    this.state.buttonEnabled = false;
    try {
        await commit7Step();  // §5.0 steps 1-8
    } catch (e) {
        new Notice(`Exit commit failed: ${e.message}. Try again or check log.`);
        this.state.committing = false;
        this.state.buttonEnabled = true;
        // autosave-dir + done.json лишаються; next openDiffPane → §5.0.a roll-forward
    }
    // на success — повертаємось detail→LIST view (Step 8), view НЕ закривається.
    // committing скидається у `finally` (на ВСІХ виходах: success / fail / cancel
    // / no-session), не лише в catch.
}
```

**Реалізовано (Step-0):** `DiffEditView.exitDetailView` — `if (this.committing) return;`
першим рядком, `committing=true`, тіло в `try { … } finally { committing=false; }` (скид на
всіх шляхах). Button-disable (візуальний) **свідомо пропущено**: flag прибирає реальну шкоду
(два конкурентні `commit7Step`), common-path ms-scale, довгий §5.0.e-шлях блокується модаллю,
а toolbar re-render'иться (persistent button-handle немає).

**7-step algorithm (з TOCTOU check на Step 1.5):**

```
Step 1. Flush pending history-queue (§2.8). RAM-state stable.

Step 1.5. **TOCTOU check** — verify input files не змінились ззовні під час сесії.
    currentBaseSha    = sha(vault[basePath])
    currentSiblingSha = sha(vault[siblingPath])
    
    // Порівнюємо до meta-stored SHAs (які за §2.5.a session-start
    // protocol гарантовано match snapshot bytes).
    if (currentBaseSha !== meta.baseShaAtStart
        OR currentSiblingSha !== meta.siblingShaAtStart):
        → НЕ через 7-step. Застосувати симетричне правило §5.0.e:
          • рівно одна змінилась → ТИХО single-side write (у незмінну) + rmdir + close + log;
          • обидві → save-to-alt модалка (editbox; Save/Discard/Cancel).
          (force-overwrite / abort-stay прибрано — змінений файл НІКОЛИ не затираємо.)
    
    else: SHAs match → vault state такий самий як при openDiffPane → continue Step 2.
    
    // Note: §3.2.a (vault-changed reopen) НЕ лишає stale-сесію відкритою — усі три
    // вибори dialog-first (Cancel → list; Continue/Start over → `startSession` →
    // нова сесія, snapshots == поточний vault). Тож у §3.2.a-шляху Step-1.5 TOCTOU
    // вже не спрацьовує. Цей check ловить ЛИШЕ зовнішню зміну base/sibling під ЖИВОЮ
    // сесією (sync2 pull / інший device) між openDiffPane і `[← back]`.

Step 2. (baseBytes, siblingBytes) = split(currentEditorDoc)
        expectedBaseSha = sha(baseBytes)
        expectedSiblingSha = sha(siblingBytes)
        atomicWriteFile(.diff2-autosave/<conflictId>/done.json, {
            v: 1,
            writtenAt: now(),
            expectedBaseSha,
            expectedSiblingSha,
        })
        — done.json завжди atomic temp+rename; partial write неможливий.

Step 3. await vault.adapter.writeBinary(stagingPathFor(basePath, "tmp"), baseBytes)
        await vault.adapter.writeBinary(stagingPathFor(siblingPath, "tmp"), siblingBytes)
        — Parallel (Promise.all) — це безпечно, файли в різних paths.
        — Crash тут: один або обидва staging files можуть бути incomplete.
          Detection: sha(disk file) ≠ done.json.expectedSha → re-execute.

Step 4. await safeRename(basePath, stagingPathFor(basePath, "bak"))
        await safeRename(siblingPath, stagingPathFor(siblingPath, "bak"))
        — POSIX-atomic rename на одному фsfs; mobile-safe через safeRename.
        — **SEQUENTIAL BY DESIGN — load-bearing.** State matrix §5.0.b
          distinguishes E (base.bak done first) від F (sibling.bak done first).
          Якщо renames у Promise.all, crash mid-execution може дати state, який
          matrix не enumerate-ить (обидва частково started). **Не оптимізувати
          у Promise.all.** Implementor зобов'язаний додати у код коментар:
          `// SEQUENTIAL by design — see DIFF-EDITOR.md §5.0.b E vs F. Do not Promise.all.`

Step 5. await safeRename(stagingPathFor(basePath, "tmp"), basePath)
        await safeRename(stagingPathFor(siblingPath, "tmp"), siblingPath)
        — Commit point: тепер vault бачить нові bytes.
        — **SEQUENTIAL BY DESIGN — load-bearing.** State matrix §5.0.b states
          H (base committed first) vs I (sibling first). Той самий коментар у коді.

Step 6. await vault.adapter.remove(stagingPathFor(basePath, "bak"))
        await vault.adapter.remove(stagingPathFor(siblingPath, "bak"))
        — Cleanup backup. Parallel.

Step 6.5. if (expectedBaseSha === expectedSiblingSha):
              await vault.adapter.remove(siblingPath)
          — R7.11 proactive sibling cleanup. Конфлікт фактично закритий:
            sibling-bytes identical to base. adapter-level (не vault.delete),
            щоб не тригерити TrashStore і працювати для .obsidian/* config-dir-у.

Step 7. await vault.adapter.rmdir(`.diff2-autosave/${conflictId}`, true)
        — meta.json + history.jsonl + cursor-a/b.json + done.json зникають разом.

Step 8. return detail → LIST view (R2.2).
        NB: there is NO `historyClear` effect in @codemirror/commands, and none
        is needed — render() disposes the DiffPane and `view.destroy()` discards
        its CM6 history. "detachLeaf" was misleading: the view is NOT closed,
        only detail→list. (Realised: the exitDetailView success tail.)
```

**Чому окремий step 2 (compute SHAs + write done.json) перед step 3:**
рекордимо очікувані SHA **до** першого write на диск. Recovery знаючи expected
SHAs може verify partial writes і вирішити: "цей файл уже cleanly записаний,
залишається лише завершити commit" vs "цей файл torn-written, треба перепрошити".

### §5.0.a Recovery sweep на onload — detection і roll-forward

При plugin onload, додатково до §4.2 cleanup умов, сканем `.diff2-autosave/`:

```
for each <conflictId>/ in .diff2-autosave/:
    if done.json NOT present:
        → нормальна autosave-сесія; standard §4.2 cleanup logic.
        → continue.

    // done.json present → commit-in-progress detected
    parse done.json → (expectedBaseSha, expectedSiblingSha)
    read meta.json → (basePath, siblingPath)

    state-detection (existence + SHA-match):
        baseFinal = vault.exists(basePath) && sha(read(basePath))
        baseTmp = vault.exists(<basePath>.sync-tmp.<ext>) && sha(read(...))
        baseBak = vault.exists(<basePath>.sync-bak.<ext>)
        siblingFinal = analogously
        siblingTmp / siblingBak = analogously

    case analysis (table нижче §5.0.b)
```

### §5.0.b Recovery state table — повна decision matrix

Колонки: для base і sibling — стан `final` (оригінал шлях), `tmp` (sync-tmp),
`bak` (sync-bak). Значення: `–` (відсутній), `old` (старі bytes, SHA ≠ expected),
`new` (нові, SHA === expected), `tmp✓` (sync-tmp з SHA === expected), `tmp✗`
(sync-tmp з SHA ≠ expected — incomplete write), `bak` (sync-bak існує).

| # | base.final | base.tmp | base.bak | sibling.final | sibling.tmp | sibling.bak | State                                            | Action                                                                                                      |
|---|------------|----------|----------|---------------|-------------|-------------|--------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| A | old        | –        | –        | old           | –           | –           | Crash між step 2 done.json і step 3 первий write | Видалити `done.json`. Поточна сесія валідна; на reopen — звичайний recovery dialog (§3).                    |
| B | old        | tmp✗     | –        | old           | tmp✗        | –           | Crash під час step 3 (torn write обох)           | Видалити обидва sync-tmp, видалити done.json. Reopen → звичайний recovery dialog.                           |
| C | old        | tmp✗     | –        | old           | tmp✓        | –           | Crash під час step 3 (один torn-written)         | Те ж саме: delete partial state, rollback to autosave.                                                      |
| D | old        | tmp✓     | –        | old           | tmp✓        | –           | Crash між step 3 і step 4                        | **Roll-forward**: продовжити з step 4 (rename originals → .sync-bak; rename sync-tmp → originals; cleanup). |
| E | –          | tmp✓     | bak      | old           | tmp✓        | –           | Crash під час step 4 (один rename done)          | Resume step 4: rename siblingFinal → sibling.sync-bak. Then continue step 5+.                               |
| F | old        | tmp✓     | –        | –             | tmp✓        | bak         | Crash під час step 4 (other rename done)         | Resume step 4: rename baseFinal → base.sync-bak. Then continue.                                             |
| G | –          | tmp✓     | bak      | –             | tmp✓        | bak         | Crash між step 4 і step 5                        | Roll-forward: продовжити з step 5 (rename sync-tmp → final; cleanup .sync-bak; rmdir autosave).             |
| H | new        | –        | bak      | –             | tmp✓        | bak         | Crash під час step 5 (один rename done)          | Resume step 5: rename sibling.sync-tmp → siblingFinal. Then continue.                                       |
| I | –          | tmp✓     | bak      | new           | –           | bak         | Crash під час step 5 (other rename done)         | Resume: rename base.sync-tmp → baseFinal.                                                                   |
| J | new        | –        | bak      | new           | –           | bak         | Crash між step 5 і step 6                        | Resume step 6: delete обидві .sync-bak; continue з step 6.5/7.                                              |
| K | new        | –        | –        | new           | –           | –           | Crash між step 6 і step 7                        | Resume step 6.5 + 7: SHA-match check → видалити sibling якщо match; rmdir autosave-dir.                     |

**Default fallback** (state не матчить жодну з A-K): **видалити done.json + sync-tmp + sync-bak files; trigger §4.2
cleanup для autosave-dir.** Це безпечно — користувач втрачає сесію, але vault не corrupted.

Один важливий нюанс: на crash станах D-J все ще можливо, що `expectedBaseSha`
не дорівнює `sha(read(basePath))` тому що базовий файл був замінений ззовні
(інший device sync, чи manual edit) між crash і reopen. Це detected при
step 4 — `safeRename(basePath, ...)` would перейменувати чужу-нову версію.
**Перевіряємо ДО step 4**: якщо basePath.exists і SHA(read) ≠ meta.baseShaAtStart
→ зовнішня модифікація → abort roll-forward, fall to default fallback (cleanup).

### §5.0.c orphan sync-tmp/sync-bak без `.diff2-autosave/` запису

Якщо знаходимо `<path>.sync-tmp.<ext>` або `<path>.sync-bak.<ext>` у vault,
але немає відповідного `meta.json` в `.diff2-autosave/*/` (basePath/siblingPath
mismatch) — це **orphan** від існуючого `AtomicWriteRecovery.sweep` (PSEUDO-MERGE-MODE
§9.5). Не торкаємось — sync2 sweep сам розрулить.

Diff2 recovery sweep торкає тільки `<path>.sync-{tmp,bak}.<ext>` файли,
**які матчаться з якимось `.diff2-autosave/<conflictId>/meta.json`** (basePath
або siblingPath збігається). Інші — sync2-зона.

### §5.0.d Що відбувається на наступному drain (PSEUDO-MERGE-MODE Phase A)

Після успішного завершення `[← back]` (step 7 виконано):

| Стан vault                                | Phase A branch                            | Результат                                                                 |
|-------------------------------------------|-------------------------------------------|---------------------------------------------------------------------------|
| Sibling видалений (step 6.5 спрацював)    | "sibling was deleted by user" branch (§5) | Drop record + push base-bytes на main + sync2 finalizes.                  |
| Sibling лишився, `siblingSha === baseSha` | "engine-deletable" branch (§5)            | Drop record + delete sibling + push. **Резервний шлях**.                  |
| Sibling лишився, `siblingSha !== baseSha` | Conflict tracking branch (§4)             | Конфлікт живе далі. У наступному DiffPane менше diff-рядків — є progress. |

**Round-trip коректність:** `split()` ↔ `build()` (§1.5 інваріант) гарантує,
що повторне відкриття конфлікту після partial-resolve `[← back]` показує
**рівно той самий progress**, який користувач залишив.

### §5.0.e `[← back]` exit when vault changed — symmetric, the SAME rule as §3.2.a

`classifyToctou` (Step 1.5) порівнює поточні base/sibling зі snapshot'ами. Це **той самий
«vault змінився під сесією»**, що й §3.2.a-reopen → **те саме симетричне правило** (записати
`getResolved()`-вміст у **НЕзмінну** сторону; обидві змінені → save-to-alt). Різниця лише в
часі (exit, не reopen) і в тому, що **після** (close замість recreate):

Реалізовано (W5) у `exit-commit.ts` (`commitUnchangedSide`/`commitToAlt`/
`AltTargetExistsError`) + `recovery-dialog.ts` (`SaveToAltModal`), dispatch у
`DiffEditView.resolveToctouExit`. Дискримінант — `baseChanged`/`siblingChanged` з `classifyToctou`:

- **Жодна не змінилась** → нормальний `commit7Step` (7-step pair-atomic, обидві сторони).
- **Рівно ОДНА змінилась** (XOR) → `commitUnchangedSide` — **ТИХО** (без Notice — лише
  `logger.info`): один `atomicWriteFile` `getResolved()`-вмісту у НЕзмінну сторону (змінився
  base → пишемо `resolved.sibling` у `siblingPath`; змінився sibling → дзеркально `resolved.base`
  у `basePath`); змінену сторону лишаємо «як є»; `rmdir` сесії; закриваємось у list. Конфлікт
  триває (нова версія зміненої сторони vs наш resolved незмінної) → користувач дорозв'яже потім.
  Той самий write, що §3.2.a Continue, але **close замість recreate**. НЕ через 7-step (single
  file → один atomic write достатньо, без `done.json`). Якщо після запису `SHA(base)==SHA(sibling)`
  — конфлікт реально закритий → наступний Phase A його drop'не (Step-6.5 тут НЕ дублюємо).
- **ОБИДВІ змінились** → `SaveToAltModal` (тут таки питаємо — незрозуміло, що узгоджували):
  > «Saved files changed — keep your resolution? Save your resolution under a different name,
  >  or discard it. The changed files are left untouched.» + **editbox** (prefilled
  >  `meta.basePath`) → `[Save]` / `[Discard]` / `[Cancel]` (+ ×).
  - **[Save]** з назвою `newName` → `commitToAlt`: якщо резолюція **зійшлась**
    (`resolved.base === resolved.sibling`) → пишемо **ТІЛЬКИ** `newName` (один файл); якщо
    **частковий** конфлікт → `newName` (base) **+** sibling під назвою, **похідною** від `newName`
    через `buildSiblingPath` (`*.conflict-from-*`) → синтетична конфлікт-пара триває під новою
    назвою. base пишемо ПЕРШИМ (краш лишає названий файл, не orphan-sibling). Оригінали (обидва
    змінені ззовні) **недоторкані**.

    **FAIL-CLOSED** (advisor): prefill — це `meta.basePath`, тож не-редагований `[Save]` затер
    би змінений-ззовні оригінал. Тому `commitToAlt` кидає `AltTargetExistsError`, якщо `newName`
    (чи похідний sibling) вже існує; модаль ще й inline-валідує на `[Save]` (не закривається на
    колізії). Це і є той самий інваріант «змінений файл НІКОЛИ не затираємо».

    **НЕ через `commit7Step`** (хоч `Commit7Options.targetBasePath/Path` і є): `recoverCommit`
    класифікує сторони за `meta.basePath/siblingPath`, а `done.json` не несе target-шляхів — тож
    alt-path commit структурно невідновлюваний (зовнішні оригінали → `foreign` → чистить не ті
    staging-слоти). Plain `atomicWriteFile` сам по собі crash-safe, а оригінали недоторкані у
    будь-якому разі — тож full pair-atomicity тут не потрібна (Occam).
  - **[Discard]** → `rmdir` сесії, close (робота відкинута, `logger.info`). **[Cancel]/[×]** →
    лишитись у редакторі.

**force-overwrite ВИДАЛЕНО** — ми НІКОЛИ не затираємо змінений ззовні файл (one-side пише лише
в НЕзмінну сторону; both-changed fail-close'иться на існуючому імені). (Стара форма §5.0.e —
save-to-alt / force / cancel для будь-якого mismatch — superseded цим правилом.)

### §5.0.f — Mid-edit vault-change detection — ВІДХИЛЕНО (§8 #12)

> **РІШЕННЯ (НЕ реалізуємо):** проактивний `vault.on('modify')` banner не потрібен.
> Користувач — власник свого Vault. Наш plugin НЕ модифікує активно-редаговані
> base/sibling при pull'і (нові дані → НОВИЙ sibling, не зміна наявного); зміна під
> сесією = інший plugin (не наша відповідальність) або сам користувач (його справа).
> Єдиний backstop — TOCTOU на `[← back]` (§5.0 Step-1.5). Код нижче — лише ілюстрація
> відхиленої альтернативи.

Поточний spec робить TOCTOU check **тільки** на `[← back]`. Відхилена альтернатива —
proactively detect зміни **під час** редагування:

```typescript
this.app.vault.on("modify", (file) => {
    if (file.path === meta.basePath || file.path === meta.siblingPath) {
        if (currentSha !== meta.shaAtStart) {
            showBannerInDiffPane(
                "⚠ Vault files changed since you opened this. " +
                "[← back] will trigger reconciliation modal. " +
                "Or [×] to discard your work and reload."
            );
        }
    }
});
```

Це дає user heads-up посеред edit-у, замість сюрпризу на `[← back]`. Скоуп
для post-v1.

### §5.1 R7.7.c / R7.7.d cliffsnotes

Деталі семантики виходу і tab-switching —
[`DIFF2_IMPLEMENTATION_PLAN.md`](../DIFF2_IMPLEMENTATION_PLAN.md) R7.7.c та R7.7.d.

**`[← back]`** — повний algorithm у §5.0 вище. Підсумок: flush queue → split →
atomicWriteFile base + sibling → optional sibling-remove on SHA-match → rmdir
autosave-dir → close.

**`[×]` tab close** (discard and exit):

1. CM6 buffer drops з RAM.
2. `rmdir(.diff2-autosave/<conflictId>, recursive)` — забирає всі три файли.
3. Vault-файл лишається у session-start state.

**Crash / Obsidian killed / battery die** (involuntary exit):

1. CM6 buffer lost (RAM).
2. `.diff2-autosave/<conflictId>/` SURVIVES.
    - history-log: до 500 ms staler than RAM (pending-queue lost).
    - cursor.json: до 2 sec staler (active typing) або 5 sec (navigation).
3. Next openDiffPane → recovery dialog (§3).

**Tab switching у межах Obsidian (НЕ tab close):** leaf лишається живим у
background, CM6 буфер у пам'яті переживає, coalesce-flush + cursor-timer
продовжують працювати. Тільки **явне** закриття tab-у видаляє autosave.

**`workspace.on('quit')` / `app.on('quit')`** — НЕ wire як alias до tab-close.
Це б тихо стирало autosave при кожному звичайному Cmd+Q, ламаючи саме той
сценарій (clean shutdown ≈ crash з погляду DiffPane).

---

## §6. Mobile append benchmark — Settings test button

> **ВІДПРАЦЮВАВ І ПРИБРАНИЙ (2026-06-03).** Кнопку Settings → "Run mobile autosave
> benchmark" (+ `src/diff2/autosave-benchmark.ts` + тест) було додано, прогнано на Android
> mid-tier, і **видалено** — тимчасовий prep-інструмент, що своє відпрацював. Результат:
> `single-append p95 = 3.10 ms`, `cursor-rewrite p95 = 28.01 ms` (n=200, block=641B) →
> запінено per-transaction-no-coalesce (§2.8) + cursor 2500/6000 ms (§2.9). Специфікація
> нижче лишається на випадок повторного заміру (напр. iOS, §6.3) — тоді кнопку відновити з git.

### §6.1 Що вимірюємо

```
1. Створити <vault>/.diff2-perf-test/ директорію.

2. Прокрутити 1000 ітерацій (per-block-append benchmark):
   a. Generate ~200-byte JSON block (типовий history-block).
   b. t0 = performance.now()
   c. await vault.adapter.append(`.diff2-perf-test/single.jsonl`, block + "\n")
   d. t1 = performance.now()
   e. latencies.push(t1 - t0)

3. Прокрутити 100 ітерацій (batched 10x append benchmark):
   a. Generate 10 blocks, concatenate з \n.
   b. t0; append; t1
   c. batchedLatencies.push((t1 - t0) / 10)  // per-block amortized

4. Прокрутити 100 ітерацій (cursor.json atomic-rewrite benchmark):
   a. Generate ~200-byte JSON.
   b. t0
   c. await vault.adapter.write(tmp, data); rename(tmp, cursor.json)
   d. t1; cursorLatencies.push(t1 - t0)

5. Report:
   - p50, p95, p99 (single-append, batched 10x amortized, cursor-rewrite)
   - total wall-time per benchmark
   - throughput (blocks/sec) для single і batched

6. Cleanup: rmdir(.diff2-perf-test/, recursive).

7. Log full result через logger.ts (рівень INFO).

8. Show Notice "Benchmark done; see plugin log for details."
```

### §6.2 Decision rules

Базуючись на single-append p95:

| p95 single-append | Рішення для production                                                                              |
|-------------------|-----------------------------------------------------------------------------------------------------|
| < 10 ms           | Append per CM6 transaction, no coalesce. Найпростіша імплементація.                                 |
| 10–50 ms          | Coalesce 150 ms idle / 500 ms typing-pause / 10 blocks (default plan §2.8). Sweet spot.             |
| 50–200 ms         | Coalesce 300 ms idle / 1000 ms typing-pause / 20 blocks. UX ще ОК.                                  |
| > 200 ms          | **Re-think** — або coalesce на 500 ms / 2000 ms, або writing раз на end-of-session. Critical issue. |

Базуючись на cursor-rewrite p95:

| p95 cursor-rewrite | Рішення для cursor-timer                                                         |
|--------------------|----------------------------------------------------------------------------------|
| < 20 ms            | 1-2 sec active / 3-5 sec navigation (default §2.9).                              |
| 20–80 ms           | 2-3 sec active / 5-8 sec navigation.                                             |
| > 80 ms            | 5 sec active / 10 sec navigation. UX degrades, але recovery все одно прийнятний. |

### §6.3 На якій платформі гнатимемо

- **Android** (mid-tier): ✅ **ПРОГНАНО (2026-06-03)** — Capacitor bridge
  найповільніший, тож це консервативна межа. Результат: `single-append
  p95 = 3.10 ms`, `cursor-rewrite p95 = 28.01 ms` (n=200, block=641B) →
  рішення запінено (§2.8 per-transaction-no-coalesce; §2.9 cursor 2500/6000ms).
- **iOS** (iPhone): не прогнано — APFS зазвичай швидший за Android, тож
  Android-межа покриває. Якщо колись знадобиться — відновити кнопку з git і
  заміряти; нижчі числа лише послаблять вимоги.
- **Desktop**: baseline — не заміряли; очікувано p95 < 5 ms (значно нижче
  Android), тож запінені значення з запасом.

Рішення вже прийняте на Android-даних (найгірший кейс). Кнопку прибрано
(§6 банер).

---

## §7. Тестовий план

### §7.1 Unit (`tests/diff2/`)

| Test                                           | Покриває                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `build-split-roundtrip.test.ts`                | §1.5 round-trip інваріант: corpus з 30+ pair'ів; byte-exact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `collision-detection.test.ts`                  | §1.3 fail-closed: файл містить `\x01` → no DiffPane open + Notice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `selection-rules.test.ts`                      | §1.7 valid (1,2,3) → allowed; invalid (4,5,6) → blocked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `caret-navigation.test.ts`                     | §1.8 plain navigation enter/exit ver-blocks; empty ver-block proactively "appears".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `marker-click-activates-empty-ver.test.ts`     | §1.8.a state-dependent: empty ver1 + click `<<<<<` → focus expand; non-empty ver1 + click `<<<<<` → no-op (data-action="none"); симетрично `>>>>>` для ver2; `=====` завжди neutral; кнопки завжди dispatch chunk-action (не focus).                                                                                                                                                                                                                                                                                                                                            |
| `diff-line-auto-collapse-on-ver-equal.test.ts` | §1.6 invariant: коли byte-equality `ver1 == ver2` досягається будь-яким edit'ом — empty+empty → програмно `[remove both]` (diff-рядок зникає); non-empty+однакові → програмно `[apply ↓]` верхнього marker (зливаються у normal-рядки). Тест-кейси: (a) edit ver1 → empty при empty ver2; (b) edit ver2 → empty при empty ver1; (c) edit ver1 з "ver 1" → "ver" при ver2 = "ver" (already non-empty same); (d) edit ver2 → "ver" з "ver" у ver1; (e) **single Ctrl+Z reverts both edit AND collapse atomically**; (f) UX escape — undo + reorder edits avoids collapse trigger. |
| `newline-glyph-visualization.test.ts`          | §1.6.a.1 `↵` glyph рендериться як CM6 decoration на **кожному** реальному `\n` у **ВСІХ** рядках (normal + ver1 + ver2), незалежно від focus; glyph НЕ селектується/НЕ копіюється; останній рядок файлу без trailing `\n` гліфа НЕ має. Перевіряємо `class:"diff2-newline-glyph"` count == кількість `\n` у doc.                                                                                                                                                                                                                                                                |
| `line-wrapping-always-on.test.ts`              | §1.6.a.0 DiffPane вмикає `EditorView.lineWrapping` завжди (присутній у extensions); навігація/виділення визначені на document-model, не на wrap-рядках — `[down]` усередині загорнутого довгого рядка не тригерить ver-block перехід (§1.8 спрацьовує лише на document-line межі).                                                                                                                                                                                                                                                                                              |
| `auto-add-newline-on-focus-leave.test.ts`      | §1.6.a.2 uniform rule: (a) last line "abc" (no `\n`) + diff-line followed by normal-line → "abc\n"; (b) ver = "" (0 chars, collapsed) + focus traversal → ver stays "" (rule НЕ fire); (c) ver = "\n" + focus traversal → stays "\n" (already terminated); (d) діф-рядок — last in document → no `\n` add (last-line-of-file valid); (e) single Ctrl+Z reverts edits + normalization atomically.                                                                                                                                                                                |
| `apply-triggers-same-newline-rule.test.ts`     | `[apply]` коли `<ver>` без trailing `\n` І resolved diff-рядок НЕ останній → §1.6.a.2 правило додає `\n` до generated last normal-рядка. Last-line-of-document edge case — НЕ додаємо. Жодного окремого apply-specific logic.                                                                                                                                                                                                                                                                                                                                                   |
| `empty-ver-block-collapses-visually.test.ts`   | §1.6.a.2 + §1.8: ver = "" → ver-блок візуально колапсується (height 0); focus enter via [down] → temporary 1-line container проявляється; user не введе ніяких chars → focus leave → ver stays "" → container collapses. User вводить 1 char → ver > 0 → container стає permanent.                                                                                                                                                                                                                                                                                              |
| `hotkeys.test.ts`                              | §1.9 hotkeys fire тільки коли caret у ver-block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `history-log-write.test.ts`                    | §2.6 write block → recompute checksum → matches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `history-log-replay.test.ts`                   | §3.3 round-trip — write N blocks, replay → end state matches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `history-log-torn-write.test.ts`               | §2.6 + §3.3 corrupt block (truncated last line, mid-line corruption, bit-flip in sum).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `coalesce-window.test.ts`                      | §2.8: 5 tx у 100ms → 1 append; idle ≥150ms → flush; nav event after 500ms typing-pause → flush; 10+ blocks → flush.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cursor-timer.test.ts`                         | §2.9: active typing → 1-2s rewrite; nav-only → 3-5s rewrite; debounce switch behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cursor-clamp.test.ts`                         | §3.3 step 7c-d: anchor > doc.length → clamp.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `meta-json-schema.test.ts`                     | §2.5: write + parse round-trip; SHA persistence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `recovery-dialog-trigger.test.ts`              | §3.1 decision tree — усі edge cases §3.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `autosave-id-stable-and-symmetric.test.ts`     | §2.4.1 invariant: `deriveAutosaveId(k, a, b)` deterministic (same args twice → same id; немає timestamps) ТА order-independent (`deriveAutosaveId(k, a, b) === deriveAutosaveId(k, b, a)`). Покриває `kind="synthetic"` і `kind="compare"`.                                                                                                                                                                                                                                                                                                                                     |
| `single-tab-enforcement.test.ts`               | §2.4 invariant: openDiffPane(id) поверх existing tab → focus existing, no second tab.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `reopen-action.test.ts`                       | W4c §3.1: pure `reopenAction` matrix over all 6 classifyReopen statuses (fresh / corrupt / sentinel / resume / library-drift / vault-changed → base-only / sibling-only / both-changed). |
| `w4c-resume.test.ts`                           | W4c §3.2/§3.2.a: `readResumeSession` + replay round-trip; session-recreation outcomes (Continue writes the UNCHANGED side, mirror; Start over). happy-dom + fs-vault. |
| `w2-history-feed.test.ts`                      | W2 §2.6–§2.8: DiffPane `onRecord` → `HistoryWriter` → `history.jsonl` production round-trip; replay-not-recorded guards; resolution-records / selection-doesnt. |

### §7.2 Crash injection (`tests/diff2/crash-resilience/`)

| Test                                              | Crash point                                                                                                                                                                                                                                             | Expected recovery                                                                                                                                                                      |
|---------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `autosave-kill-mid-append.test.ts`                | Kill during `adapter.append` (partial line written).                                                                                                                                                                                                    | Replay stops on corrupt last block; state = pre-block.                                                                                                                                 |
| `autosave-kill-between-flushes.test.ts`           | Kill після flush N, перед flush N+1 (pending-queue lost).                                                                                                                                                                                               | Replay through flush N; state ≤500ms staler than RAM.                                                                                                                                  |
| `autosave-kill-during-cursor-rewrite.test.ts`     | Kill між cursor.tmp і rename → cursor.json. (Old cursor.json лишається, новий — у .tmp untouched.)                                                                                                                                                      | Old cursor.json valid → use it.                                                                                                                                                        |
| `autosave-kill-during-meta-write.test.ts`         | Kill між meta.tmp та rename.                                                                                                                                                                                                                            | onload sweep: no meta → cleanup `<conflictId>/`.                                                                                                                                       |
| `autosave-sha-changed-since-crash.test.ts`        | Crash → user edits basePath outside plugin → reopen.                                                                                                                                                                                                    | SHA mismatch → cleanup + fresh session.                                                                                                                                                |
| `autosave-conflict-resolved-since-crash.test.ts`  | Crash → next drain auto-resolves конфлікт інакше → reopen.                                                                                                                                                                                              | Sweep condition (6) → cleanup; modal не показуємо.                                                                                                                                     |
| `exit-protocol-state-A-thru-K.test.ts` (11 cases) | Crash injection між кожним кроком 2-7 у §5.0.a — кожен з 11 valid states (A–K у §5.0.b decision matrix).                                                                                                                                                | Roll-forward завершує commit для кожного валідного стану; vault і autosave кінцевий стан матчить normal happy-path.                                                                    |
| `exit-protocol-fallback.test.ts`                  | Crash injection у не-валідний стан (наприклад, partial sync-tmp з невалідним SHA + manual edit basePath між crash і reopen).                                                                                                                            | Default fallback: cleanup всіх staging files + done.json + autosave-dir; vault лишається consistent; fresh session при наступному openDiffPane.                                        |
| `exit-protocol-external-modification.test.ts`     | Crash між step 5 (commit point) і step 7. Між crash і reopen — sync2 push змінив basePath на main + інший device pull змінив local.                                                                                                                     | Recovery detect-ить external mod (SHA(basePath) ≠ meta.baseShaAtStart) → abort roll-forward → cleanup; fresh session з new vault state.                                                |
| `toctou-back-arrow-detection.test.ts`             | Open DiffPane → external change (sync2 pull) у basePath АБО siblingPath. `[← back]` → `classifyToctou` Step 1.5. Cover (a) base only; (b) sibling only; (c) both.                                | `classifyToctou` рапортує `baseChanged`/`siblingChanged` коректно для (a)/(b)/(c) → диспетч: one-side = silent single-side write (no modal); both = модалка.                                                                                                   |
| `toctou-one-side-silent.test.ts`                  | `[← back]`, рівно ОДНА сторона змінилась ззовні. Тихо: single-side `atomicWriteFile` `getResolved()`-вмісту у НЕзмінну сторону (base changed→write sibling; sibling changed→write base); змінена недоторкана; rmdir+close; подія в **log**, БЕЗ Notice. | Незмінну сторону перезаписано resolved-вмістом; змінена «як є»; autosave-dir gone; конфлікт триває для re-resolve. |
| `toctou-both-changed-save-to-alt.test.ts`         | `[← back]`, ОБИДВІ змінились → модалка (editbox prefilled `base.ext`). [Save `newName`]: converged → ТІЛЬКИ `newName`; partial → `newName` + derived `*.conflict-from-*` sibling. [Discard]→rmdir+close. [Cancel]→stay. | Alt-paths під `newName` (1 файл або pair); originals недоторкані; autosave-dir gone (Save/Discard) / lives (Cancel). |
| `session-start-protocol-ordering.test.ts`         | §2.5.a session-start: snapshots + cursor + history written BEFORE meta.json. Crash injection між кожним кроком 6-10 → next openDiffPane: якщо meta.json missing → cleanup (умова 1 §4.2); якщо meta.json exists → all other files present + SHAs match. | Strong invariant "meta exists ⇒ everything valid" дотримується.                                                                                                                        |
| `reuse-snapshot-optimization.test.ts`             | §2.5.b: reopen після crash + vault SHA matches meta → skip re-copy snapshots; existing autosave-dir reused; recovery dialog показано (§3.2 normal).                                                                                                     | I/O on session-start значно нижче за full init.                                                                                                                                        |
| `snapshot-mismatch-recovery-dialog.test.ts`       | §3.2.a: ONE vault side changed → §3.2 `ResumeRecoveryModal` (`*` on the changed file). Continue → write restored content to the UNCHANGED side + recreate (mirror: base changed → write sibling; sibling changed → write base); Start over → fresh; Cancel → list. BOTH changed → silent fresh, no modal.                             | Кожен веде до правильного state переходу.                                                                                                                                        |
| `snapshot-sha-corruption-cleanup.test.ts`         | §4.2 умова 5: simulate disk bit-flip у base.snapshot — `sha(read("base.snapshot")) ≠ meta.baseShaAtStart` на cleanup sweep → autosave-dir cleaned + Notice logged.                                                                                      | Defense in depth catches storage-level corruption.                                                                                                                                     |

### §7.3 Integration (`tests/integration/scenarios/diff2/`)

Окремий bucket `o-series-autosave/` (новий під Phase 5):

- `o1-resolve-with-survival.test.ts`: відкрити конфлікт, N edits, simulate
  kill (`throw` у dispatch handler) → reopen → recovery `[Continue]` → end
  state matches → `[←]` завершує штатним шляхом.
- `o2-multiple-parallel-sessions.test.ts`: 3 окремих конфлікти, по черзі
  edit, kill, reopen — кожен recovery незалежний.
- `o3-recovery-after-sync.test.ts`: відкрити, edit, sync (без save) → kill →
  reopen: SHA inputs ≠ → cleanup + fresh.
- `o4-cursor-recovery.test.ts`: edit + cursor у конкретній позиції 1247, kill,
  reopen → cursor у позиції 1247 (з допустимим коливанням до ±10).

### §7.4 Manual / device

- Mobile perf benchmark з §6 — обов'язково перед production-release Phase 5.
- iOS / Android low-memory kill — phyzically force-kill через OS task manager.
- Battery-die simulation — заряд < 1%, дозволити вимкнення.

---

## §8. Open questions / TBD

| #  | Питання                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Default (якщо не вирішимо)                                                                                               |
|----|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| 1  | ~~Lock `diff` library до specific patch / range?~~ **RESOLVED (superseded)** — diff pinned at **v9** (ratified); replay-validity no longer rides on the version. §2.5 `joinedDocSha = SHA(build(base,sibling))` detects library drift DIRECTLY (classifyReopen → `library-drift`), so a chunk-boundary change is caught at reopen, not guarded by a version lock.                                                                                                           | (resolved)                                                                                                               |
| 2  | ~~Checksum algorithm для §2.6: FNV-1a / CRC32 / SHA-256-prefix?~~ **RESOLVED** — `fnv1a32` (hex), implemented in `history-log.ts` (Stage 3a). Fast, no crypto dep.                                                                                                                                                                                                                                                                                                          | (resolved)                                                                                                               |
| 3  | ~~Coalesce window cap — 10 blocks чи інше?~~ **RESOLVED (benchmark, Android 2026-06-03)** — `single-append p95 = 3.10 ms < 10 ms` → coalesce **викинуто**, append per CM6 transaction (§2.8). W2: `HistoryWriter` пише per-transaction через **serialized tail-promise chain** (без QUEUE_CAP) — synchronous enqueue фіксує порядок, burst-edits коалесцяться у наступний flush; `drain()` — exit Step-1 barrier.                                                                                                                                                                | (resolved)                                                                                                               |
| 4  | ~~Single DiffPane tab per conflictId enforcement?~~ **RESOLVED** — §2.4 invariant. Двa tab-и недопустимі (race на autosave).                                                                                                                                                                                                                                                                                                                                                | (resolved)                                                                                                               |
| 5  | ~~Recovery dialog "Edits: N saved" — як рахуємо?~~ **RESOLVED** — рахуємо **REDO-блоки в `history.jsonl`** (= `scanHistory` trustworthy-prefix block-count). W4 — dialog ще не wired, але механізм готовий.                                                                                                                                                                                                                                                                                       | (resolved)                                                                                                              |
| 6  | ~~Окремий nav-log поряд з history-log для cursor?~~ **RESOLVED** — НЕ потрібно; 2-слот ping-pong `cursor-a/b.json` (§2.9) достатньо. | (resolved) |
| 7  | ~~Mobile test button — до / в межах Phase 5?~~ **RESOLVED** — побудовано окремим preflight, прогнано на Android, і **видалено** (values запінено §2.8/§2.9). Не частина Phase 5/6; для iOS re-measure відновити з git.                                                                                                                                                                                                                                                      | (resolved)                                                                                                               |
| 8  | ~~`joinAlgoVersion` mismatch — strict / lenient?~~ **RESOLVED (superseded)** — `joinAlgoVersion` ВИКИНУТО з meta.json; замінено на `joinedDocSha`. Mismatch тепер = classifyReopen's `library-drift` статус. Обробка (W4, узгоджено з §3.1): **start-fresh + warning Notice**, НЕ resume — replay-offsets рахуються проти `baseSiblingToModel(snapshot)`, а зміна diff-lib може дати інший clean-doc, тож replay був би несоундним. (Lib і так пінено v9; drift рідкісний.) | (resolved)                                                                                                               |
| 9  | ~~Cursor-timer paused коли tab not focused / backgrounded?~~ **RESOLVED** — timer працює ЛИШЕ коли редактор у фокусі редагування, і пише слот ЛИШЕ якщо позиція змінилась із попереднього запису (dirty-check). Не-фокус / background → таймер не пише; battery — non-issue. (§2.9.)                                                                                                                                                                                                                                                                                                                                                                                         | (resolved)                                                                                                              |
| 10 | ~~§1.8.a click на `=====` chars — keep as no-op, чи activate ver-blocks?~~ **RESOLVED** — `=====` завжди neutral. `<<<<<` / `>>>>>` чутливі тільки коли відповідний ver-block порожній.                                                                                                                                                                                                                                                                                     | (resolved)                                                                                                               |
| 11 | ~~Recovery-side TOCTOU: якщо crash + vault changed before reopen — wipe autosave + user втрачає всю роботу.~~ **RESOLVED** — §3.2.a recovery dialog тепер дає user-choice (поточна форма — див. §3.2.a) замість silent wipe; snapshots зберігають ground truth.                                                                                                                                                                                | (resolved)                                                                                                               |
| 12 | ~~Проактивний mid-edit banner (§5.0.f) на `vault.on('modify')`?~~ **RESOLVED — НЕ потрібно.** Користувач — власник свого Vault і знає, що робить. Наш plugin **НЕ модифікує** активно-редаговані base/sibling при pull'і з репо (нові дані → НОВИЙ sibling, не зміна наявного); тож зміна base/sibling під сесією — це або інший plugin (не наша відповідальність), або сам користувач (його справа — хай видаляє/перейменовує siblings як хоче). Єдиний backstop — TOCTOU на `[← back]` (§5.0 Step-1.5 → `classifyToctou` aborts-and-stays, WIRED W1).                                                                                                                                                                                                                                        | (resolved)                                                                                                              |

---

**Документ-канон:** оновлювати при будь-яких змінах документ-моделі (§1),
формату history-log або cursor (§2.5–§2.9), recovery-dialog контракту (§3.2),
cleanup правил (§4). Inconsistency між цим документом і кодом — це регресія;
правити одне з двох до синхронізації.
