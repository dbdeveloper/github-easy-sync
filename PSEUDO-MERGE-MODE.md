# PSEUDO-MERGE-MODE.md

> **Status:** живий design-документ. Зафіксовані рішення прийняті в
> ході обговорення на бранчі `diff2` (2026-05-20). Документ
> розвиватиметься разом із реалізацією.
>
> Документ описує **pseudo-merge модель** через conflict-branches на
> GitHub. Це **повна заміна** conflict-resolution layer'у з 2.0.0-beta;
> COMMIT-BATCH layer лишається без змін крім одного user-visible
> removal (manual commit messages).
>
> Зв'язок із `IMPLEMENTATION_PLAN.md` (Diff2 редизайн) — ортогональний:
> Diff2 — це UI/UX шар **поверх** механізму описаного тут. Усе, що в
> IMPLEMENTATION_PLAN.md суперечить цьому документу — застаріле і
> підлягає видаленню. Цей документ має пріоритет.

> **⚠️ Update (Stage 12 cleanup):** `modify-vs-delete` БІЛЬШЕ НЕ
> ConflictKind. Цей конфлікт (local modified, remote deleted)
> **завжди auto-resolves у бік local-modify** — файл resurrect'ить
> на remote при наступному push. Відповідно: всі згадки
> `modify-vs-delete` як kind, `.deleted` placeholder sibling файлу,
> classifier rows 2/4/10/11/12 — historical context нижче, у
> поточному code base не існують. Auto-resolution implement'ується
> у `attemptAutoMerge` через `AutoMergeResult.type === "modify-wins"`
> (`src/sync2/conflict-detection.ts`). `ConflictKind` зараз має
> тільки 2 значення: `"modify-vs-modify" | "delete-vs-modify"`.

> **⚠️ Update (Stage 13 architectural pivot — 2026-05-22):** event-driven
> resolution model скасована. Те, що раніше робив ConflictWatcher
> (виклик `evaluateConflictState` з vault.on listener'а з мутацією
> store), переноситься на **єдину точку: drain-start**. Vault listeners
> залишаються — але **read-only**: лише перерахунок UI counter
> (status bar, ribbon, pre-sync modal). Жодних мутацій store, жодного
> classifier виклику.
>
> **Чому пивот:** real-time event-driven model породжувала клас
> mid-drain race-condition'ів на mobile (Capacitor adapter divergence
> + listener leak between sessions + restored-from-backup siblings на
> onload). Зразу два збої (2026-05-21 incident): 6 phantom duplicate
> conflict записів на mobile + auto-restored siblings після ручного
> видалення. Pivot спрямований на:
> 1. **Зробити filesystem source of truth** — store це cache, не
>    джерело правди. User actions (delete/rename sibling) одразу
>    видимі в counter; resolution застосовується тільки один раз, на початку наступного drain.
> 2. **Скоротити state mutation surface** до однієї точки (drain-start)
>    замість трьох (vault.on + drain-start + drain-end).
> 3. **Прибрати дві окремі recovery sweep процедури** (для атомік-create
>    + для ConflictStore.load) на користь єдиної через
>    `*.sync-bak*` flow (Stage 13 §"ConflictStore — schema і persistence").
>
> **Що змінюється в коді (Phase 4, окремо від цього доку):**
> - `ConflictWatcher.handle` → лише "read-only" `counter.refresh()`; не викликає `evaluateConflictState`.
> - `evaluateConflictState` стає 2-фазним (Phase A: SHA-match cleanup; Phase B: path-close).
> - Drain-end sweep видаляється! Залишається лише drain-start (з guard `if (store.records.length > 0)`).
> - Onload sweep НЕ викликає `evaluateConflictState` — це робить перший, після Onload, drain.
> - `ConflictStore.create` стейджить sibling як `*.sync-bak*` у vault (через `atomicWriteFile`).
> - `ConflictStore.load` НЕ відновлює sibling з backup — missing sibling = resolution signal.
> - Classifier row 3 (`!baseExists + modify-vs-modify`) → `noop` (раніше `delete-wins-cascade`), щоб "delete base then rename sibling onto base" workflow працював.
>
> **Які секції цього доку переписуються через Stage 13:**
> - §"Архітектурний поділ" — таблиця оновлена.
> - §"Архітектура push: split-push у processBatch (β)" — drain pseudocode оновлено (drain-end видалено).
> - §"ConflictStore — schema і persistence" — 3-step protocol переписаний на `*.sync-bak*`.
> - §"Unified state evaluation — `evaluateConflictState()`" — classifier стає 2-фазним.
> - §"Counter formula + vault.on listeners role" — нова секція.
> - §"Edge case: live vault сконвергував до remote" — оновлено для drain-start-only.
> - §"Recovery sweeps" — секція B оновлена.
> - §"Decisions made" — додано рішення #26-#35.
> - §"Implementation outline" — додано Stage 13.
>
> Секції що не змінюються через цей pivot: Auto-merge attempt,
> Conflict detection entry points, Edit-while-in-conflict,
> pullIfNeeded для in-conflict paths, Finalize, Multi-device,
> Branch naming, GitHub REST mechanics — pivot впливає лише на
> resolution detection, не на push pipeline.
> 
> Відтепер всі commit message – наперед визначені (не змінюються користувачем) і змінюються залежно від мети коміту. 
> Запропоновані hardcoded формати:
> 
> |                         Контекст                          |             Commit message              |
> |-----------------------------------------------------------|-----------------------------------------|
> | User-driven batch (syncAll, syncFile)                     | "sync ({deviceLabel})"                  |
> | Synthetic resolution batch (Phase B)                      | "resolve conflict ({deviceLabel})"      |
> | Conflict-branch intermediate commits (push-side step 4/5) | "conflict ({deviceLabel})"              |
> | Marker commit на branch перед merge                       | "final state ({deviceLabel})"           |
> | Merge-commit (finalize)                                   | "merge conflict-branch ({deviceLabel})" |

---

## 🔴 Що змінюється для користувача

> **Єдиний user-visible removal з 2.0.0-beta:** прибираються
> **manual commit messages**. Команди `Sync with GitHub (custom
> message)…` і `Sync current file with GitHub (custom message)…` —
> зникають. Лишаються 2 з 4 команд: `Sync with GitHub` і
> `Sync current file with GitHub`. Усі коміти мають тільки автоматичні
> назви (commit messages), які генеруються за вказаною вище схемою.
> Можливість змінити commit message з settings – зникає.
>
> **Решта нової pseudo-merge функціональності — "під капотом":**
> conflict-branch на GitHub, event listener для resolution, нові
> sibling-файли при multi-device конфліктах. Користувач бачить
> лише результат — конфлікти стало простіше резолювати, кожен файл
> з конфліктом має чітку приватну зону, інші пристрої не отримують
> сирий конфлікт, поки користувач явно не вирішить.

**Архітектурна цінність:** уся резолюція конфліктів — через стандартні
Obsidian примітиви (delete / rename / edit файлів). Жодного
плагінного модального вікна, ніяких confirmations. Diff2 (майбутній)
буде pure UX-надбудовою — show diff, quick-action buttons,
multi-sibling navigation — нічого з цього не критичне для механізму.

Приклад вирішення конфліктів:
Кожний файл зразка `<filename>.<ext>`, для якого виник конфлікт отримує один або кілька sibling-компаньйон-файлів форми:
`<filename>.conflict-from-<deviceLabel>-<dt>.<ext>` (конфлікт виду `modified vs modified`);
Видалений локально файл, при одночасній зміні файлу на іншому пристрої отримує також sibling-компанькон-файл `<filename>.conflict-from-<deviceLabel>-<dt>.<ext>` (конфлікт виду `deleted vs modified`).
І тільки конфлікт типу `modified vs deleted` розв'язується автоматично: вважається що якщо користувач вніс зміни у свій файл, вилучення його на іншому пристрої вважається помилкою, тому local file wins.

Для вирішення конфліктів користувача достатньо:
1. видалити sibling-файл (`*.conflict-from*`), тоді конфлікт автоматично розв'язується на користь локального файлу
2. привести обидва файли до одного виду (SHA(local-file) == SHA(його-sibling-file)), тоді конфлікт також розв'язується на користь локального файлу (хоча це вже байдуже - вони однакові) і при наступному [sync] sibling-файл буде вилучено.
3. видалити local-file і перейменувати sibling-file в local-file. Це також розв'язує конфлікт, здавалось би також на користь локального файлу... хоча тепер там знаходиться вміст remote версії цього ж файлу...


---

## Що зберігається з 2.0.0-beta (commit/batch layer)

Наявний COMMIT-BATCH механізм — багатий і стабільний (закріплений 18
unit-spec файлами + 65 інтеграційними тестами A1–L4). Усе, що в ньому
є — **залишається**:

- `.attempted` marker
- `accumulateOfflineSyncs` toggle
- довільне число batches у черзі
- `syncFile(path)` команда (без custom message)
- ~~`{filename}` / `{path}` placeholders у commit templates~~ **superseded by Stage 13 decision #36:** всі commit-message templates видаляються, hardcoded формати з `{deviceLabel}` substitution only
- L1, L4 інтеграційні тести

**Видаляється** як наслідок removal manual messages:

- API: `syncAll(customMessage?)` → `syncAll()`; `syncFile(path, customMessage?)` → `syncFile(path)`
- 2 з 4 Obsidian команд (`(custom message)` варіанти)
- `EnqueueMeta.isolated` — повністю видаляється (verified: в версії 2.0.0-beta .isolated ставиться
  ВИКЛЮЧНО з `customMessage !== undefined` у sync2-manager.ts:419/494;
  без customMessage truly dead code; no backwards compat → можемо
  безпечно прибрати з типу, серіалізації, всіх читачів)
- L2 + L3 інтеграційні тести (custom-message сценарії)

**Stage 13 розширення scope — видаляються ВСІ commit-message templates:**

- `src/sync2/commit-templates.ts` — повністю
- `tests/sync2/commit-templates.test.ts` — повністю
- `settings.commitTemplate*` поля у `GitHubSyncSettings`
- Settings UI секція для template input/preview
- `PushQueue.updateCommitMessage()` — accumulate-refresh logic
- `{date}` / `{time}` / `{filename}` / `{path}` placeholders — всі
- `meta.json.commitMessage` поле — derived inline at processBatch time, не зберігається

**Що залишається з settings:**
- `deviceLabel` (default `"Obsidian"`) — для multi-device disambiguation у hardcoded messages

---

## Commit message formats (Stage 13 — hardcoded)

Жодних templates. Engine генерує message inline на основі batch'у origin:

| Контекст                                                                  | Hardcoded message               |
|---------------------------------------------------------------------------|---------------------------------|
| User-driven batch (`syncAll`, `syncFile`)                                 | `sync ({deviceLabel})`          |
| Synthetic resolution batch (Phase B drain-start)                          | `resolve conflict ({deviceLabel})` |
| Conflict-branch intermediate commit (push-side step 4/5, edit-while-in-conflict) | `conflict ({deviceLabel})`     |
| Marker commit на branch перед finalize merge                              | `final state ({deviceLabel})`   |
| Finalize merge-commit на main (з 2 parents)                               | `merge conflict-branch ({deviceLabel})` |

`{deviceLabel}` — settings value. Default `"Obsidian"`. Користувач задає у Settings → Device label input.

**Implementation:** at `processBatch` / push-commit time, compute message:
```ts
function commitMessageFor(batch: QueueBatch, deviceLabel: string): string {
  if (batch.synthetic) return `resolve conflict (${deviceLabel})`;
  return `sync (${deviceLabel})`;
}
```

Для conflict-branch commits — окремий callsite з hardcoded format. Для marker / merge-commits — те саме.

**Зв'язок з accumulate logic:** `mergeIntoLatestPending` ігнорує batches з `synthetic: true` (Phase B-created batches не fold'аються з user edits — provenance чисто розділена). User-driven batches з `synthetic: false` fold'аються між собою як зараз. Stage 13 decision #36 включає цей invariant.

### EnqueueMeta schema (Stage 13)

`synthetic` — boolean field у `meta.json` кожного batch'у. Незмінний
після створення. Жодного окремого `.synthetic` marker file (на
відміну від `.in-progress` і `.attempted` що mutating); pattern доку:
**lifecycle state** → marker file, **immutable creation data** →
meta.json field.

```ts
interface EnqueueMeta {
  // ── Immutable identity (set at enqueue, never updated) ────────
  createdAt: number;
  synthetic: boolean;            // Stage 13: false (user-driven) | true (Phase B resolution)

  // ── Mutable parent SHAs (updated by reconcile during retry) ───
  parentCommitSha: string;
  parentTreeSha: string;

  // ── Mutable upload tracking (filled in as createBlob succeeds) ─
  uploadedBlobs: Record<string, string>;  // path → sha

  // ── Mutable file mtimes (captured at enqueue, used by reconcile binary/plugin-js atomic) ─
  fileMtimes: Record<string, number>;

  // ── REMOVED у Stage 13: ──
  // commitMessage  → derived inline у processBatch:
  //                  meta.synthetic ? "resolve conflict ({dev})" : "sync ({dev})"
}
```

**Default value для defensive coercion:** `synthetic: false`. Старі meta.json з
2.0.0-beta / pre-Stage-13 без поля → treated as user batch (default).

**Read access:**
- `PushQueue.mergeIntoLatestPending` parses meta.json, filters
  `!meta.synthetic && !inProgress && !attempted`.
- `processBatch` reads meta.synthetic при generation commit message.

**Write access:**
- `PushQueue.enqueueOrMerge` writes `synthetic: false`.
- `PushQueue.enqueueSynthetic` writes `synthetic: true`. Жодного публічного
  API щоб toggle'нути після створення — це invariant.

### PushQueue.enqueueSynthetic — API contract

```ts
interface EnqueueSyntheticArgs {
  // Single path per synthetic batch — Phase B creates one per closed path,
  // each as own commit (preserve-all-commits принцип).
  path: string;
  // null = path being deleted on main; Uint8Array = path content to push.
  content: Uint8Array | null;
  // Computed by Phase B from current vault state at synthesis time.
  contentSha: string | null;  // null коли content === null
  // SHAs known at synthesis time. processBatch reconcile rebases якщо main HEAD просунувся.
  parentCommitSha: string;
  parentTreeSha: string;
}

class PushQueue {
  // Synchronously (well, async I/O для writeBinary) creates a new batch
  // dir with synthetic=true. Returns batch id (timestamp-based, same format
  // як для enqueueOrMerge batches).
  //
  // Does NOT merge with any existing pending batch — synthetic batches are
  // always solo. (mergeIntoLatestPending also skips them on user batch
  // creation — invariant from both sides.)
  //
  // Dedup behaviour: якщо існує non-attempted/non-in-progress synthetic batch
  // для того ж path → still creates a NEW batch (each Phase B closure is
  // a separate resolution event; we never collapse them).
  //
  // Throws on:
  //   - I/O error during writeBinary / mkdir / atomic-write meta.json
  //   - invalid path (empty, contains "..", absolute)
  // Does NOT throw on:
  //   - existing batch for same path (allowed, see dedup above)
  //   - existing finalPath у vault (Phase B may overwrite на push;
  //     processBatch handles via reconcile если потрібно)
  async enqueueSynthetic(args: EnqueueSyntheticArgs): Promise<string>;
}
```

**Чому single-path per synthetic batch.** Phase B може закрити N paths
у одному sweep. Замість одного batch'у з N entries — створюємо N окремих
synthetic batches. Кожен = окрема commit-resolution на main, чітка
provenance ("ось коли цей path закрився"). Drain processes їх послідовно
через стандартний queue loop. accumulate logic (Decision #36) не fold'ить
synthetic ні з чим — кожен sole.

**Чому returns `Promise<string>` (batch id).** Phase B може хотіти
log'нути синтезовані ids (observability), а майбутні UI surfaces можуть
показати "resolutions pending for these batches" (Diff2 stage 2). Не
обов'язково використовується наразі, але cheap to return.

---

## Що повністю переписується (conflict layer)

Алгоритми resolve-конфліктів з 2.0.0-beta — переглядаємо критично і
**замінюємо новими** з огляду на pseudo-merge model:

- `applyRemoteAddOrModify` (pull-side conflict path) — переписується:
  text 3-way merge зберігається; `binary` тепер register-as-conflict
  замість atomic mtime; sibling write через новий conflict-branch flow
- `reconcileBatchAgainstHead` Case 4 (push-side conflict path) — те саме
- `resolveBinaryConflict` — **повністю видаляється** (binary тепер
  завжди йде через conflict-branch sibling pattern; раніше це був
  silent atomic-mtime picker що з 2.0.0-beta lost data without user awareness)
- `cascadeDeferRemoval`
- `ConflictModal` (модальне вікно per-file під час sync) — прибирається
- `onConflict` callback з sync2-manager (заміщується silent sibling write через ConflictStore)
- `ConflictStore` — суттєво розширюється: persistent record schema з `kind`
  field (modify-vs-modify / delete-vs-modify),  (modify-vs-delete розв'язується автоматично на користь local file!),
  mtime/size cache, crash-resistant atomic write
- `ConflictView` (sync2-conflict-view) — повністю видаляється. Новий diff-edit UI буде створено на стадії 2 (Diff2) (окремий шар)

**Зберігається без змін:**
- `mergeText` (з `three-way-merge.ts`) — text 3-way merge alg
- `resolvePluginJsConflict` — plugin-js atomic semver (semver = explicit author intent)
- `isAtomicPluginFile`, `compareSemver`, `readPluginVersion` (з `plugin-js.ts`)
- `hasTextExtension`, `pluginRootOf` (з `utils.ts` + `plugin-js.ts`)

Нова реалізація — згідно із цим документом, з нуля, з фокусом на
**продуктивність, ясність, передбачуваність і тестованість**.

---

## Mental model для користувача

> **Файл у конфлікті — це твоя приватна копія, з якою ти можеш робити
> що завгодно. Поки конфлікт не вирішено, інші пристрої її не бачать.
> Усе решта синхронізується нормально. Готовий — видаляєш sibling-файл,
> і твій варіант з'являється у всіх (при наступному [Sync]).**

---

## Архітектурний поділ

| Шар                                                  | Модель                               | Тригери                                                                                           |
|------------------------------------------------------|--------------------------------------|---------------------------------------------------------------------------------------------------|
| **Sync engine** (push/pull, findChanges, push-queue) | Polling — як у 2.0.0-beta            | [Sync] click, interval tick, onload `resumeQueue`                                                 |
| **Conflict resolution (state mutation)**             | Polling — drain-start only           | Початок `drain()`; з guard `if (store.records.length > 0)`                                        |
| **Conflict counter (UI badge)**                      | Event-driven, read-only              | `vault.on('delete' \| 'modify' \| 'rename')` → перерахунок counter; жодних мутацій store          |
| **Conflict push to remote**                          | Polling (через існуючий sync engine) | Resolved-state потрапляє у main лише на наступному [Sync]                                         |

**Stage 13 пивот** (див. notice вгорі): event-driven мутації store
скасовано. Listeners залишаються лише для UI counter; вся resolution
логіка консолідована на drain-start. Це **зменшує state mutation
surface** і робить filesystem явним source of truth — store це
read-through cache. CLAUDE.md's "engine does NOT register vault
events" правило все ще порушується (counter listener'ить),
але **тільки для read**, не для mutation — це slimmer виняток ніж
раніше.

---

## Архітектура push: split-push у processBatch (β)

**Stage 13:** ConflictWatcher більше НЕ викликає `evaluateConflictState`.
Він лише перераховує counter. Тому drain не потребує pause/resume
для уникнення mid-drain re-entry — listener'и завжди тільки read.

```
drain():
  0. drain-start sweep — ЄДИНА точка state mutation:
     if (store.records.length > 0):                        ← guard, 90% drains skip
       evaluateConflictState() — full scan.
       Phase A: SHA-match cleanup (engine видаляє siblings де
                siblingSha == baseSha; drop records).
       Phase B: path-close — для кожного path P,
                якщо всі records для P мають !siblingExists →
                drop records + synthesize side-batch що propagate'ить
                live base state (content або absence) до main.
     // Side-batches обробляться у цьому ж drain (внизу).
  
  1. pull main (як зараз — у drain top через pullIfNeeded)
  
  for each batch in queue (including side-batches synthesized at step 0):
    processBatch(batch)  ← деталі нижче
  
  if branch exists AND store.records.length == 0:
    push vault.live[path] as marker commit на branch (preserves A(local))
    finalize merge (createCommit з parents=[main.head, branch.head])
    deleteRef branch
```

**Drain-end sweep ВИДАЛЕНО.** Якщо drain сам створив новий sibling
у Step 4 і user видалив його mid-drain — побачимо це лише на
наступному drain-start. Trade-off: один-цикл затримки vs значно
простіша модель + менше race-conditions. На практиці mid-drain
видалення siblings — це **дуже** рідкісний сценарій (drain'и
типово <5 секунд).

**Onload sweep НЕ викликає `evaluateConflictState`.** Перший drain
(чи то ручний [Sync], чи interval tick, чи `resumeQueue` з
pending batch'ами) пройде через drain-start sweep і закриє catch-up
window. Onload sweep робить **лише** AtomicWriteRecovery (vault-level
`*.sync-bak*` cleanup — див. §"ConflictStore — schema і persistence").

**Guard `if (store.records.length > 0)`** — оптимізація: у 90%
drains store порожній → весь conflict-handling блок пропускається,
drain латентність незмінна порівняно з 2.0.0-beta. Single [Sync]
click → один drain → uniform processing.

### processBatch (виконується для кожного batch у drain)

```
2. partition batch.files за поточним станом inConflictFiles:
   conflictPaths = batch.files ∩ inConflictFiles
   plainPaths    = batch.files − inConflictFiles
3. push plainPaths → main (існуючий push flow з 2.0.0-beta):
   - reconcile case 4 (push-side виявив SHA divergence vs main HEAD):
     спершу ATTEMPT AUTO-MERGE (див. секцію нижче). Якщо auto-merge
     успішний → use merged content, push до main як звичайний plainPath
     (path НЕ потрапляє у conflict-branch). Якщо auto-merge невдалий
     → перевести path у новий conflict flow (step 4).
4. ЯКЩО виявлено новий конфлікт (pull-side АБО push-side) і
   auto-merge не зміг його розв'язати:
   - якщо conflict-branch не існує: createReference на current main HEAD
     (eager — створюється навіть якщо batch.files не містить цього path, а конфлікт є з local Vault path)
   - визначити local-content тих conflict paths (читання з vault, не з batch):
     - якщо path ∈ batch.files → version з batch.vault/
     - інакше → version з live vault (це pull-side detected конфлікт на
       шляху що поза поточним batch)
   - примітка про mtime: `batch.fileMtimes[path]` несе pre-canonicalize
     mtime тільки для path ∈ batch.files. Для path-not-in-batch mtime
     не tracked — для conflict push до branch цього достатньо (atomic
     resolution через mtime з 2.0.0-beta не використовується на
     conflict-branch path-ах: вони завжди йдуть через 3-case resolution)
   - createTree(base = current main.tree, override conflictPaths-versions)
     ← base завжди = поточний main.tree, не branch.tree (rebase forward)
   - createCommit(parent = branch.head або base if свіже-створений, tree = …, auto-message)
   - updateRef branch
   - ConflictStore.create(path, theirsBlobSha) → register sibling
   - stage sibling-файл у vault через atomic-write flow:
     1. write `<path>.conflict-from-<remote-device>-<ts>.sync-bak.<ext>`
     2. persist ConflictStore record (`<configDir>/.conflicts/<id>/meta.json`)
     3. atomic rename `*.sync-bak` → `<path>.conflict-from-<remote-device>-<ts>.<ext>`
     ← vault.on('rename') fires → counter listener перераховує
     counter; жодних мутацій store з listener'а
5. ЯКЩО conflictPaths не порожні (user editing in-conflict files):
   - createTree(base = current main.tree, override conflictPaths з batch)
   - createCommit на branch.head (або base, якщо branch свіже-створений)
   - updateRef branch
6. delete batch dir (success)
```

**Один batch → 0–2 push-секвенції** залежно від складу.

**Branch tree завжди rebase'иться вперед.** `base_tree = current main.tree
+ override conflict files`. Це гарантує що branch завжди тривіально
мерджабельний з main у finalize (єдиний diff = conflict files).

**Per-half marker для retry.** Якщо push до main пройшов але push до
branch упав — на retry треба пропустити main push. Маркер `.main-pushed`
у batch dir:
- ставиться після successful main push
- зчитується на retry: якщо є → skip main push, лише retry branch
- очищується разом з batch dir на success

---

## Auto-merge attempt — preserved from 2.0.0-beta

**SHA mismatch ≠ автоматично conflict.** Перед реєстрацією як
conflict (push до conflict-branch + sibling + ConflictStore), engine
пробує auto-merge. Якщо успіх — path не потрапляє у conflict-branch
взагалі, йде як plainPath до main. Це стандартна git-shape behavior
(аналог `git pull --no-rebase` що робить 3-way merge перед conflict
markers).

### Стратегії auto-merge по типу файлу

| Тип файлу | Класифікатор                                                                                             | Auto-merge стратегія                                                                                                                   | Успіх                                                  | Невдача → step 4                                        |
|-----------|----------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------|---------------------------------------------------------|
| Текст     | `hasTextExtension(path)` (з utils.ts 2.0.0-beta)                                                         | **3-way merge** `mergeText(base, ours, theirs)` (з `three-way-merge.ts`)                                                               | Clean merge без markers — use merged content as "ours" | Conflict markers → register conflict                    |
| Plugin-js | `isAtomicPluginFile(path, configDir)` (з plugin-js.ts) — `main.js` або `manifest.json` під plugin folder | **Atomic semver** — read `manifest.json` обох сторін, higher version wins. Mtime tie-break зберігається з 2.0.0-beta                   | Resolution clear → apply winner                        | Identical version + identical mtime → register conflict |
| Binary    | усе інше (`hasTextExtension` returns false)                                                              | **No auto-merge** — pseudo-merge mode дає user sibling-pattern resolution через file ops (delete sibling, rename, etc.), як для тексту | —                                                      | **Завжди → step 4 (register as conflict)**              |

**Зміна для binary vs 2.0.0-beta:** 2.0.0-beta робить silent atomic
mtime для binary бо там не було user-facing UI що showed би binary diff
(ConflictModal був text-only). Pseudo-merge mode ламає це обмеження —
sibling-file pattern працює для **будь-якого** file type. Binary
sibling `image.conflict-from-Phone-<ts>.png` стає поруч з `image.png`
у vault; user resolves тими ж file ops що і для тексту (delete sibling
= keep ours, rename sibling → base = accept theirs). **Silent picking
з mtime = data loss without user awareness** — pseudo-merge цього
уникає для binary.

**Plugin-js атомік семвер зберігається:** semver — це **explicit
author intent** (a not арбітражне picking), 3-way merge minified JS
crashes Obsidian, sibling pattern для `main.js` semantically дивний
(user не редагує bundled JS). Тому silent semver resolution OK.

**Adoption flow (перший sync проти non-bare remote — окремий layer)**
лишається на atomic mtime для всіх file types, включно з binary.
Adoption — це pre-conflict-resolution context: немає shared base, нема
ConflictStore як setup; mtime — єдиний reasonable heuristic. Цього
layer pseudo-merge не торкається.

Класифікатори і реалізації — **успадковані з 2.0.0-beta** (через існуючі
unit-тести: E3/E4 для plugin-js — зберігаються; E2/G4 для binary —
переписуються бо semantics змінюється; E1 reconcile-onload — переглянути).
Pseudo-merge mode переписує "що робити при невдачі" — push до
conflict-branch замість `ConflictModal` / `applyRemoteAddOrModify` direct
sibling write.

### Two entry points, both run auto-merge first

| Entry point                             | Коли                                                                    | Як обчислюється base                                   |
|-----------------------------------------|-------------------------------------------------------------------------|--------------------------------------------------------|
| **Pull-side** (step 1 pullIfNeeded)     | pull виявив що remote має нову версію файла який локально модифікований | base = lastSync snapshot's tree content for this path  |
| **Push-side** (step 3 reconcile case 4) | main HEAD просунувся між batch enqueue і processBatch                   | base = batch.expectedHead's tree content for this path |

Auto-merge attempt **uniform** для обох entry points — same `mergeText`,
same atomic resolution functions.

### Що НЕ змінилось vs 2.0.0-beta

- 3-way merge alg → той самий `mergeText` з `three-way-merge.ts`
- Plugin-js semver classifier → той самий `isAtomicPluginFile` + `compareSemver`
- Binary mtime classifier → той самий через `hasTextExtension` negation
- Auto-merge success path → той самий (push merged content до main)

### Що змінилось

- Auto-merge **failure path** — замість direct sibling write +
  ConflictModal, тепер step 4 (push до conflict-branch + sibling +
  `ConflictStore.create` — все uniformly через новий conflict layer).
- Test series E1-E4 переписуються (та сама перевірка успіху, але
  failure path тепер дивиться на conflict-branch state замість ConflictModal).

---

## Conflict detection — два entry points → один state

**Обидва entry points спершу пробують auto-merge** (див. секцію
"Auto-merge attempt" вище). Реєстрація як conflict (запис у
`inConflictFiles` + ConflictStore + sibling-файл) відбувається тільки
коли auto-merge не зміг розв'язати.

**Pull-side (drain step 1, pullIfNeeded):**
- pull виявляє розбіжність SHA на файлі, який локально модифікований
- attempt auto-merge:
  - text → 3-way merge `mergeText`
  - plugin-js → atomic semver
  - binary → no attempt (завжди register as conflict)
- ЯКЩО auto-merge успіх → apply merged content, recordSync, NOT registered as conflict
- ЯКЩО auto-merge невдалий:
  - додає path у `inConflictFiles`
  - зберігає theirsBlobSha у ConflictStore (з kind = `modify-vs-modify` чи `delete-vs-modify` залежно від base presence)
  - sibling-файл write'иться у vault
  - на наступному push step branch створюється (якщо ще нема)

**Push-side (drain step 3..4, processBatch):**
- reconcile case 4 виявляє SHA-divergence vs main HEAD
- attempt auto-merge (ті ж стратегії)
- ЯКЩО auto-merge успіх → use merged content, push як plainPath до main
- ЯКЩО auto-merge невдалий → step 4 flow (push до branch, sibling, register)

Обидва entry points наповнюють **один і той самий state** —
`inConflictFiles` + ConflictStore + sibling-файли у vault. ConflictWatcher
і processBatch просто **читають** цей state — їм байдуже, хто додав.

---

## Edit-while-in-conflict

Користувач **може продовжувати редагувати** файл після того, як він
потрапив у конфлікт. Механіка:

1. Користувач edits a.md → mtime змінюється у vault
2. На наступному [Sync] click `findChanges` бачить a.md як modified
   (стандартний flow з 2.0.0-beta)
3. `enqueueOrMerge` додає a.md у batch
4. `processBatch` бачить що a.md ∈ inConflictFiles → routed до
   conflict-branch (не main), step 5 архітектури

Інші пристрої НЕ бачать цих правок, поки конфлікт не вирішено.

---

## pullIfNeeded для in-conflict paths

Pull завжди йде з main. Якщо remote main отримав нову версію файлу,
який уже в `inConflictFiles`:

- Локальний base-файл НЕ перезаписується (це наша приватна копія)
- Чинні sibling-файли НЕ перезаписуються
- Створюється **новий** sibling-файл з новою remote-версією:
  `a.conflict-from-<other-remote-device>-<ts>.md`
- `ConflictStore.create(vaultPath, theirsBlobSha)` — дедуп за
  `(vaultPath, theirsBlobSha)` гарантує що ідентична remote-версія не
  створює дубль siblings; нова → новий sibling
- `lastSyncCommitSha` просувається нормально (інші файли pull-нулись)

Path може мати **N siblings** з різних пристроїв. Користувач муситиме
резолювати **кожен** перед закриттям конфлікту.

---

## ConflictStore — schema і persistence

**Filesystem is the source of truth.** Vault `*.conflict-from-*` files
визначають що "є" у конфлікті. ConflictStore — **read-through cache**
що зв'язує файл з його identity metadata (`theirsBlobSha`, kind, etc.).
Orphan `*.conflict-from-*` файли (без відповідного record) — ignored
by design. Orphan records (без відповідного sibling-файла) — drop на
наступному drain-start sweep (Phase B).

### Crash-resistant persistent storage

Як і `.push-queue/`, `metadata.json`, `.gitignore` invariants — ConflictStore
**персистентний на диску** із захистом від збоїв при модифікації.

Це конкретизація **existing principle #9 "Crash resilience"** з
`IMPLEMENTATION_PLAN.md` ("Принципи реалізації"): "every multi-step
disk op has a documented recovery sweep that runs in `onload` and a
kill-mid-op test". ConflictStore create/update/delete — це multi-step
disk ops, тому всі вони мусять відповідати principle #9. Цей розділ
просто конкретизує контракт для pseudo-merge context.

- **Location:** `<configDir>/plugins/github-easy-sync/.conflicts/<recordId>/meta.json`
- **Staging для нового sibling-файлу:** vault-level `*.sync-bak*` через
  існуючий `atomicWriteFile` infrastructure (`src/sync2/atomic-write.ts`).
  Жодного окремого `sibling-content.bin` у `.conflicts/<id>/`. Sibling
  стейджиться там же, де і житиме — у vault, з тимчасовим `*.sync-bak*`
  пре-суфіксом, який знімається на Step 3.
- **Defensive coercion on load:** як `SnapshotStore.migrate()` —
  missing fields, unknown values default safely; corrupted records
  logged and skipped (не ламають plugin load).
- **Invariant після recovery sweep:** state on disk — або fully
  completed update, або fully rolled back, ніколи half-applied
  (principle #9).

### Naming convention для staging файлів — `.sync-bak` як pre-suffix

**Критично:** `*.sync-bak*` — це НЕ суфікс файлу, а **pre-suffix
(інфікс перед file extension)**(!!!). Це зберігає original file extension
видимою для Obsidian — користувач може відкрити staging-файл якщо
треба, а Obsidian's "Show all file types: false" не приховує його з
explorer'а (як приховав би `*.md.sync-bak` як файл невідомого типу).

Algorithm:
```
function stagingPathFor(finalPath: string): string {
  const dotIdx = finalPath.lastIndexOf('.')
  const slashIdx = finalPath.lastIndexOf('/')
  // Hidden file (leading dot, no other extension): .gitignore, .editorconfig
  // OR extensionless file: README, Makefile
  if (dotIdx <= slashIdx || dotIdx === slashIdx + 1) {
    return finalPath + ".sync-bak"        // .gitignore → .gitignore.sync-bak
  }
  // Normal file with extension
  const stem = finalPath.slice(0, dotIdx)
  const ext  = finalPath.slice(dotIdx)    // ".md", ".json", ".png"
  return stem + ".sync-bak" + ext         // test.md → test.sync-bak.md
}
```

Examples:
| Final path | Staging path |
|---|---|
| `Folder/note.md` | `Folder/note.sync-bak.md` |
| `Plugins/foo/manifest.json` | `Plugins/foo/manifest.sync-bak.json` |
| `Folder/image.png` | `Folder/image.sync-bak.png` |
| `.gitignore` | `.gitignore.sync-bak` |
| `.obsidian/.gitignore` | `.obsidian/.gitignore.sync-bak` |
| `README` (no ext) | `README.sync-bak` |
| `Folder/a.conflict-from-Phone-20260522.md` | `Folder/a.conflict-from-Phone-20260522.sync-bak.md` |

Same convention застосовується до `*.sync-tmp*` (інша staging
suffix у atomic-write transactions).

**Gitignore patterns (`GitignoreInvariants.ROOT_SEED` / `CONFIG_DIR_SEED`):**
- `*.sync-bak*` — один pattern catches усі форми:
  - `test.sync-bak.md` ✓ (перший `*` = `test`, другий `*` = `.md`)
  - `manifest.sync-bak.json` ✓
  - `.gitignore.sync-bak` ✓ (перший `*` = `.gitignore`, другий `*` = порожній)
  - `README.sync-bak` ✓
- `*.sync-tmp*` — той самий pattern для atomic-write temp файлів

Gitignore globbing семантика: `*` matches any sequence of chars
(including leading dot), `*X*` — substring match. Один pattern на
обидві форми (pre-suffix і suffix) — простіше і безпечніше ніж пара
правил. **Phase 4 робота:** додати ці patterns у
`GitignoreInvariants.ROOT_SEED` + `CONFIG_DIR_SEED` (якщо ще нема).

### 3-step atomic create protocol (Stage 13 — vault-level `.sync-bak`)

`ConflictStore.create(vaultPath, theirsContent, theirsBlobSha, kind, …)`
— створення конфлікту вимагає двох disk-ops (write sibling + write
record). Раніше це робилось через `<configDir>/.conflicts/<id>/sibling-content.bin`
staging area; Stage 13 переписує на **vault-level `.sync-bak`**, щоб
перевикористати існуючий `atomicWriteFile` flow і обʼєднати recovery
з `AtomicWriteRecovery.sweep()`.

```
recordId = uuid()
finalSiblingPath = "<vaultPath>.conflict-from-<dev>-<ts>.<ext>"
                                  // e.g., "Folder/note.conflict-from-Phone-20260522143022.md"
stagingPath      = stagingPathFor(finalSiblingPath)
                                  // → "Folder/note.conflict-from-Phone-20260522143022.sync-bak.md"

Step 1: stage sibling content до vault як .sync-bak (pre-suffix)
  vault.adapter.writeBinary(stagingPath, theirsContent)
  // siblings-pattern matcher (`*.conflict-from-*`) НЕ catches
  // staging path бо middle segment `.sync-bak.` ламає sequential
  // suffix matching → vault.on listeners НЕ перераховують counter

Step 2: atomic write record meta.json
  write <configDir>/.conflicts/<recordId>/meta.json.tmp = JSON.stringify(record)
  rename meta.json.tmp → meta.json  (atomic via OS-level rename)

Step 3: atomic rename .sync-bak → final sibling
  vault.adapter.rename(stagingPath, finalSiblingPath)
  // vault.on('rename') fires → counter listener перераховує (Stage 13)
```

**Чому vault-level замість `.conflicts/<id>/sibling-content.bin`:**
- Reuse `atomicWriteFile` що вже існує і покрите тестами
   (`tests/sync2/atomic-write.test.ts`).
- Recovery об'єднується з `AtomicWriteRecovery.sweep()` —
   один single sweep на onload замість двох (per Stage 13 §"Recovery sweeps").
- Sibling stages де він житиме, не в окремій директорії.
- Pre-suffix форма catches'иться gitignore pattern `*.sync-bak*` у
   `ROOT_SEED` і `CONFIG_DIR_SEED` — staging-файли не пушаться на GitHub.

### Recovery sweep на onload — vault-level `.sync-bak` sweep

`AtomicWriteRecovery.sweep()` (`src/sync2/atomic-write.ts`)
проходить **по всьому vault-у** шукаючи `*.sync-bak` файли (це той
же sweep що працює для будь-яких atomic-write transactions, не тільки
для ConflictStore). Per-file decision matrix:

| `.sync-bak` стан                                                                                  | Recovery action                                                                                                                       |
|---------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| `finalPath` уже існує (Step 3 завершився, `.sync-bak` orphan stale)                               | `remove(.sync-bak)` (clean up)                                                                                                        |
| `finalPath` відсутній, **немає** record у ConflictStore що вказує на `finalPath` (crash до Step 2) | `remove(.sync-bak)` (orphan staging, конфлікт буде re-detected на наступному pull)                                                    |
| `finalPath` відсутній, **є** record що вказує на `finalPath`, SHA(`.sync-bak`) == `record.theirsBlobSha`     | `rename(.sync-bak → finalPath)` — завершити Step 3                                                                                    |
| `finalPath` відсутній, **є** record що вказує на `finalPath`, SHA(`.sync-bak`) ≠ `record.theirsBlobSha`      | `remove(.sync-bak)` + log warning. Record лишиться з missing sibling → Phase B drain-start drop'не record + propagate base. Data integrity > resolution completeness. |

**SHA-verify** додає захист від disk corruption або race-condition
між паралельними `create()` викликами на ту саму path (нелогічно, але
не неможливо). Cost: один SHA computation per `.sync-bak` file, runs
тільки onload, типовий N = 0-1.

### Що видаляється з ConflictStore.load() (Stage 13)

**Старий контракт:** на load() для кожного record — якщо vault sibling
зник, відновити з backup (`sibling-content.bin`).

**Новий контракт:** load() **не дивиться** на vault filesystem. Просто
читає `meta.json` файли і будує in-memory index. Перевірка
"sibling exists" робиться **тільки** на drain-start sweep (Phase B), де
missing sibling = resolution signal (drop record + propagate base).

Це і є фікс **auto-restore bug** (2026-05-21 mobile incident): user
видаляє sibling → load() не повертає його з backup → drain-start
бачить missing sibling → drop record → конфлікт закрито.

### Record schema

Кожен record персистентно зберігає **всю інформацію щоб resume
resolution flow після crash**:

```ts
interface ConflictRecord {
  id: string;                    // unique record id
  vaultPath: string;             // "Folder/note.md"
  kind: "modify-vs-modify" | "delete-vs-modify";  // informational only (Stage 13)

  // --- Immutable identity (set at create, never updated) ---
  oursBlobSha: string | null;    // null for kind=delete-vs-modify (ours was "delete")
  theirsBlobSha: string;         // SHA remote content at conflict detection (used for dedup + recovery SHA-verify)
  remoteDevice: string;          // "Phone", "Laptop", ...
  createdAt: number;

  // --- Sibling location + content cache ---
  siblingPath: string;           // "Folder/note.conflict-from-Phone-<ts>.md"
  siblingMtime: number;          // cached at last evaluation (or create)
  siblingSize: number;           // cached at last evaluation (or create)
  siblingSha: string;            // CURRENT sibling content SHA (cached)
  // — Updates коли stat reveals mtime/size change → re-read content
  // — At create == theirsBlobSha (sibling written from theirs content)
  // — After user edits sibling: diverges from theirsBlobSha

  // --- Base location + content cache ---
  // baseMtime/baseSize/baseSha = null коли base не існує
  // (kind=delete-vs-modify initial; OR після user-delete у будь-якому kind)
  baseMtime: number | null;
  baseSize: number | null;
  baseSha: string | null;        // CURRENT base content SHA (cached, null якщо !baseExists)

  lastEvaluated: number;         // last evaluateConflictState touch
}
```

**Identity vs cache distinction:**
- `theirsBlobSha` — **immutable identity**: служить для (a) dedup при
  `ConflictStore.create` і (b) SHA-verify у recovery sweep. Ніколи не
  оновлюється після створення record-а.
- `siblingSha` — current cached SHA. Classifier використовує `siblingSha`
  (current) разом з `baseSha` (current) — обидва оновлюються через
  watermark коли mtime/size меняється. Phase A SHA-comparison fires
  саме на цих current значеннях.

**`kind` field — informational only (Stage 13).** Classifier на нього
не дивиться: 2-фазна модель (див. §"Unified state evaluation") працює
однаково для обох kinds. `kind` лишається для observability (логи,
debug, future UI labels).

**`oursBlobSha` field — informational only (Stage 13).** Так само як
`kind`: classifier не читає це поле. Раніше воно використовувалося в
старій 12-row classifier table для cases як `baseSha == record.oursBlobSha`
(initial state detection). Stage 13 classifier дивиться лише на
`siblingExists` і `siblingSha == baseSha`. `oursBlobSha` лишається в
schema для observability (можна побачити "що було у нас на момент
detection") + майбутніх diff2 UI features. Phase 4: можна **drop'нути
з schema** якщо ніде не використовується, або зробити optional.

**Sibling naming uniform для обох kinds:** `<file>.conflict-from-<dev>-<ts>.<ext>`.
Жодних `.deleted` placeholder-ів — `modify-vs-delete` як kind не існує
з Stage 12 (auto-resolves у бік modify-wins при push-time).

### Dedup at create()

**Two-layer dedup** (Phase 4 implementation):

1. **In-memory `findDuplicate(vaultPath, theirsBlobSha)`** — поточна
   сесія: якщо record з цим `(vaultPath, theirsBlobSha)` ключем уже
   є → return existing, не створювати дубль.
2. **Filesystem scan** — обов'язкова перевірка vault parent directory
   на patternн `<stem>.conflict-from-*<ext>`, хешити кожен, порівняти
   з `theirsBlobSha`. Match → **adopt orphan**: створити record що
   вказує на existing sibling-файл, не writeBinary новий sibling.

Без layer 2: plugin upgrades / manual cleanup of `.conflicts/`
re-orphan siblings, і кожен наступний конфлікт для `(path, theirsBlobSha)`
spawnить дубль. Це і є той баг "4 phantom duplicate `.gitignore.conflict-from-MacBook-*`"
з 2026-05-21 mobile incident.

---

## Unified state evaluation — `evaluateConflictState()` (Stage 13)

**Один algorithm, ОДИН trigger point: drain-start (з guard).** Source
of truth — vault filesystem. ConflictStore records — read-through
cache що пов'язує sibling file + identity metadata.

**Інваріант:** "коли *conflict-file пропадає → запис з ConflictStore
пропадає". Це одна атомарна асоціація. Phase A (engine deletes sibling)
і Phase B (user deleted sibling) — це **дві джерела зникнення**
sibling-у, але обидва ведуть до одного й того самого drop record.
Коли пропадає **останній** record для path → path closes остаточно
(propagate live base до main, finalize branch).

```
evaluateConflictState() — only called from drain():
  if store.records.length == 0: return            ← guard ELSEWHERE,
                                                    not inside this fn

  pathsToCheck = new Set()  // paths що мали records на старті sweep

  Phase A: per-record cleanup (siblings ↔ records atomic association)
    for each record r in store.records.snapshot():
      pathsToCheck.add(r.vaultPath)

      siblingExists = vault.adapter.exists(r.siblingPath)
      if !siblingExists:
        store.delete(r.id)              ← user видалив sibling
        continue

      baseExists = vault.adapter.exists(r.vaultPath)
      if baseExists AND siblingSha == baseSha:
        vault.adapter.remove(r.siblingPath)  ← engine видаляє sibling
        store.delete(r.id)                   ← запис пропадає за sibling
        continue

      // sibling exists AND (no base OR siblings ≠ base): noop, record lives

  Phase B: path-close (propagate live base for paths that emptied out)
    for path in pathsToCheck:
      if store.recordsForPath(path).length == 0:
        synthesize side-batch:
          path = path, content = live vault state (read at synthesis time)
          // batch goes through normal processBatch flow → push to main
```

**Чому 2 фази а не 1.** Можна було б усе в одному loop'і, але
розділення на "per-record actions" + "per-path close" робить
algorithm читабельним: Phase A відображає user's mental model
("конфлікт-файл пропав → запис пропав"), Phase B — окремий
крок propagation (живий vault state → main).

### Phase A — per-record cleanup (sibling vanish → record vanish)

**Інваріант:** для кожного record на старті drain'у — після Phase A
або (а) sibling-файл існує на disk **і** має SHA ≠ baseSHA → record
лишається, sibling лишається, конфлікт активний; або (б) sibling-файл
зник з disk → record також зник зі store. Атомарна асоціація.

Sibling зникає з vault з двох причин:
1. **User видалив sibling** (delete-через-file-explorer, rename
   sibling-на-base через replace, mv через mobile file manager) →
   на drain-start ми бачимо `!siblingExists` → drop record.
2. **Engine видаляє sibling** коли `siblingSha == baseSha`
   (sibling redundant — той самий content що base) → engine
   `vault.adapter.remove(siblingPath)` + drop record.

**Engine-deletion — ЄДИНИЙ випадок коли engine видаляє файл у vault.**
Усі інші resolution шляхи спрацьовують через user action. Семантика:
коли SHA(sibling) == SHA(base), користувач уже "погодився" на цей
content (явно скопіював sibling → base чи перейменував). Sibling
більше нічого не додає — engine допомагає прибрати.

Приклади:

| Початковий стан path | Дія user'а перед drain | Phase A видаляє |
|---|---|---|
| sibling1(=base) | — | sibling1 + record1 (engine SHA-match) |
| sibling1, sibling2 | user видалив sibling1 | тільки record1 (sibling вже немає, engine лишь drop'ає record) |
| sibling1(=base), sibling2(≠base) | — | sibling1 + record1 (engine); record2 живий |
| sibling1, sibling2, sibling3 | user видалив sibling1 і sibling3 | record1 і record3 dropped; record2 живий |
| sibling1 | user перейменував sibling1 → base (overwrite) | record1 dropped (sibling зник через rename) |

### Phase B — path-close (propagate live base for emptied paths)

Після того як Phase A прибрав records згідно з vanish-інваріантом —
дивимось на paths що **мали** records на старті sweep'а:
- Якщо path P тепер має **0 records** у store → path closed:
  - Synthesize side-batch що propagate'ить **live vault state** для
    path P до main:
    - Якщо `baseExists(P)` → push current content of `P` до main.
    - Якщо `!baseExists(P)` → push delete of `P` до main.
- Якщо path P ще має records (хоч один sibling живий і не match'ить
  base) → noop, path лишається у конфлікті.

Side-batches створені на Phase B обробляються в тому ж drain через
звичайний `processBatch` flow.

**Implementation note для Phase 4 — side-batch synthesis mechanism:**
Phase B's "synthesize side-batch" — це новий PushQueue batch створений
**inline у drain** (НЕ через `enqueueOrMerge` від `findChanges`).
Найзручніше: `PushQueue.enqueueSynthetic({ files: { path: { content, sha } }, deletions, parentCommitSha, parentTreeSha, commitMessage })` — нова public method що йде в ту ж чергу `.push-queue/` що звичайні batches. Drain'у не треба знати "це side-batch чи звичайний"
— наступна ітерація drain loop підбирає його з `queue.list()` як
будь-який інший batch. Альтернатива (inline у drain без persistence)
ламає crash-safety: kill mid-side-batch не recoverable. Phase 4: додати
`enqueueSynthetic`, напряму з Phase B.

**КРИТИЧНО — path-close ≠ "просто закрити".** Коли остання record
для path drop'ається, AND store.records стає порожнім, в кінці того
ж drain виконується finalize block (див. §"Finalize: коли
inConflictFiles стає порожнім"):
- Якщо `store.records.length == 0` AND `metadata.conflictBranch != null`:
  1. Marker commit на branch (preserves vault state as branch tip).
  2. `createCommit(parents=[main.head, branch.head], tree=main.tree)`.
  3. `updateRef main` → merge-commit.
  4. `deleteRef branch`.

Merge-commit має branch.head як **second parent** → усі intermediate
commits на branch залишаються **reachable** через merge-commit's
second parent (стандартна git-reachability). `deleteRef` лише
видаляє name `refs/heads/easy-sync-conflicts-...`, але commits
обʼєкти живі назавжди.

**Тобто:** "preserve all commits" принцип (`feedback-preserve-all-commits.md`)
автоматично дотримується. User's "struggle moments" не втрачаються
— вони merged in proper git fashion.

### Як це покриває всі сценарії резолюції

| User action | Результат на наступному drain-start | Чому |
|---|---|---|
| Видалив sibling1 (єдиний) | Phase B drop record + propagate base → main | record має !siblingExists → path closed |
| Видалив sibling1 з base SHA, sibling2 ≠ base SHA лишився | Phase B noop (sibling2 ще живий, path не closed) | One sibling deleted, but path still has live records |
| Скопіював sibling content у base + видалив sibling | Phase B (sibling уже видалений) → propagate base (new content) → main | `!siblingExists` after delete → path closed; propagate новий base content |
| Скопіював sibling content у base, sibling НЕ видалив | Phase A видаляє sibling (бо siblingSha == baseSha). Якщо це єдиний sibling → Phase B closed → propagate base → main | engine helps: SHA-match auto-cleanup |
| Перейменував sibling → base.ext (overwrite) | Sibling зник через rename, base тепер has new content → Phase B closed → propagate new base | Capacitor mobile: explicit delete+rename. POSIX: atomic. Обидва → sibling gone → resolved |
| Видалив тільки base, sibling лишився | Phase B noop (sibling exists → path not closed) | Stage 13 row 3 fix: ніяких delete-wins-cascade. User мусить додатково видалити sibling щоб делете дійшло до main |
| Видалив base + усі siblings | Phase B closed (all siblings !exist) → propagate absence → push delete до main | Stage 13: full delete вимагає видалити все |

### Edge case: pull-side new-sibling coincidentally matches base

**Сценарій:** pull-side виявляє remote-modified path. attemptAutoMerge fails →
ConflictStore.create writes новий sibling-файл з theirs content. У цей
момент `theirs content == ours content` (наприклад: на іншому пристрої
зробили revert файлу назад до OURS, і це попало в main).

Що відбувається:
1. `ConflictStore.create` пише sibling (через `.sync-bak` flow):
   - `siblingSha = theirsBlobSha = baseSha` (бо theirs reverted == ours)
   - Record stored у `.conflicts/<id>/meta.json`
   - Sibling landed у vault з `siblingExists = true`
2. **Наступний drain-start Phase A:**
   - Iterates over records. For цей record:
     - `siblingExists = true`
     - `baseExists = true`
     - `siblingSha == baseSha` ✓
   - **Engine deletes sibling file** + drops record.
3. **Phase B:** path має 0 records → closed → synthesizeSideBatch propagating live base.

**Виглядає дивно (АЛЕ ЛОГІЧНО І ТОМУ ЦЕ ЄДИНО ВІРНИЙ АЛГОРИТМ):** engine створив файл, через декілька секунд сам же
його видалив. Але це **semantically correct**: конфлікт detected був
trivially-resolvable (обидва sides equal), і Phase A правильно це
ловить через SHA-match cleanup. Жоден user-edit не втрачається —
ніхто не видаляв нічого важливого.

Інша думка (відкинута):
**Чи краще НЕ створювати sibling у такому випадку?** Можливо optimization
у `ConflictStore.create` (skip creation коли theirsBlobSha matches current
baseSha) — але це додає edge-case branch у hot path. Поточний design
"create unconditionally, Phase A cleans up" — простіший і uniform. Phase 4
може додати optimization якщо це вимірюваний performance issue.

**Test category C (lifecycle)** має це покрити: "conflict registered with
theirsBlobSha == current baseSha → next drain auto-cleans, no user effort".

### Mtime + size cache (findChanges-style watermark pattern)

Той самий pattern що `change-detector.ts` у 2.0.0-beta для vault scan.
Кожен record несе `siblingMtime + siblingSize + siblingSha`
(і `baseMtime + baseSize + baseSha`).

При evaluation **per record**:

```
stat = vault.adapter.stat(record.siblingPath)
if !stat:
  siblingExists = false
elif stat.mtime == record.siblingMtime AND stat.size == record.siblingSize:
  # Cache hit — no read/hash needed
  siblingSha = record.siblingSha
else:
  # mtime/size touched → must read content
  content = read(record.siblingPath)
  siblingSha = computeSha(content)
  # Refresh ALL three cached fields together
  record.siblingMtime = stat.mtime
  record.siblingSize  = stat.size
  record.siblingSha   = siblingSha
  persist record  ← atomic write (per ConflictStore persistence contract)
```

Same pattern для `baseMtime` + `baseSize` + `baseSha`.

### Multi-sibling consequence

Якщо path має N siblings, Phase A окремо перевіряє кожного на
SHA-match. Тільки ті, що збігаються з base SHA, видаляються engine'ом.
Решта залишаються (як "blocking" siblings — path не closed поки вони
не зникнуть user-action'ом).

Phase B працює per-path: closes path тільки коли ВСІ records для нього
мають !siblingExists. Per Stage 13 model, path "закривається" коли user
видаляє/перейменовує/copy+delete'ить **усі** конфлікти на ньому
(або engine допомагає Phase A на SHA-match siblings).

### Performance budget

При типовому usage (більшість records — cache hit) Phase A + Phase B
вкладається в кілька мс. Cold start (всі mtime потрібно перевірити
з диска) — ≤30 stat calls + кілька read+hash = ~50ms навіть на mobile.

З guard'ом `if store.records.length > 0`, 90% drains пропускають
обидві фази повністю — латентність drain'а незмінна порівняно з
2.0.0-beta.

---

## Counter formula + vault.on listeners role (Stage 13)

**Vault listeners — read-only.** Жодних мутацій ConflictStore, жодного
classifier виклику, жодних file deletions. Тільки перерахунок counter
для UI badges (status bar, ribbon, pre-sync modal).

### Counter formula

```
count = 0
for record in ConflictStore.records:
  if !exists(record.siblingPath): continue       // буде resolved на наступному drain Phase B — не рахуємо
  if !exists(record.vaultPath):    count++; continue  // base пропав, sibling сам — це conflict (no possible match)
  if record.siblingSha != record.baseSha: count++     // SHA mismatch — conflict
  // siblingSha == baseSha: НЕ рахуємо (буде resolved Phase A на наступному drain)
```

Cached `siblingSha` + `baseSha` з record-а — валідні поки mtime+size
файлів збігаються з кешем (watermark). На vault.on event для path
що належить будь-якому record-у — invalidate counter cache → next
refresh recompute (з re-stat + потенційним re-hash якщо mtime/size
змінились).

### vault.on listener wiring

```
vault.on('delete' | 'modify' | 'rename', file):
  paths = relevantPaths(file)  ← O(1) Set check: path ∈ siblings ∪ bases
  if paths.length == 0: return  ← 99% events bail here
  conflictCounter.markDirty()   ← O(1), no immediate recompute
```

`relevantPaths` — O(1) lookup проти двох in-memory Set'ів які
ConflictStore підтримує:
- `siblingPaths` = всі `record.siblingPath`
- `basePaths` = всі `record.vaultPath`

Rename event передає і oldPath і newPath; обидва перевіряються.

### ConflictCounter — dirty-flag + subscribers contract

Counter — окремий module з explicit cache semantics:

```ts
class ConflictCounter {
  private cachedValue: number = 0;
  private dirty: boolean = true;        // start dirty → first read computes
  private subscribers: Set<(count: number) => void> = new Set();

  // O(1) — called from vault.on listener. Just sets the dirty flag.
  // Multiple back-to-back markDirty() calls coalesce — recomputation
  // happens once on next access.
  markDirty(): void {
    this.dirty = true;
    // Debounced subscriber notification: schedule a microtask that
    // recomputes once і notifies всіх subscribers. Якщо markDirty
    // викликається N разів у same microtask — один recompute, один
    // notification round.
    this.scheduleRecompute();
  }

  // O(N records) when dirty, O(1) when cached. Synchronous-feeling for
  // on-demand readers (status bar render, pre-sync modal open).
  // Internally uses cached siblingSha/baseSha from records; falls back
  // to read+hash only коли mtime/size cache miss.
  getValue(): number {
    if (this.dirty) {
      this.cachedValue = this.recompute();
      this.dirty = false;
    }
    return this.cachedValue;
  }

  subscribe(callback: (count: number) => void): () => void;
}
```

**Debounce semantics.** `markDirty` schedules a microtask-level
recompute. Bulk events (user deletes 5 siblings via file explorer
multi-select) coalesce у один recompute round, один notification.

**Reactive UI vs on-demand.** Status bar + ribbon — subscribe()
(reactive, get notified on change). Pre-sync modal — on-demand
getValue() at open time.

**Test surface.** ConflictCounter testable independent of vault:
- markDirty() → dirty == true
- getValue() while dirty → recompute called once, dirty cleared
- back-to-back markDirty() → одна batched notification
- subscribe() → callback викликається після кожного recompute з changed value

### Why orphan siblings don't count

Orphan = sibling-файл у vault що відповідає pattern `*.conflict-from-*`
але БЕЗ відповідного record у ConflictStore. Наприклад:
- User manually wiped `.conflicts/` directory.
- Plugin upgrade migration залишив старі sibling-файли.
- External tool створив файл з таким суфіксом.

Counter їх **не бачить** бо ітерується по records, а не по vault.
Резолюція їх теж не торкається бо Phase A/B працюють per-record.
Це по-дизайну: filesystem is truth, але **тільки в контексті
зареєстрованих records**. Orphan-и user розчищає сам, або вони
залишаються невидимими (gitignore'нуться через `*.conflict-from-*`
pattern).

**Виняток — filesystem-orphan adoption at create():** коли engine
готується створити новий sibling, він ОБОВ'ЯЗКОВО спочатку сканує
parent directory шукаючи orphan-и з SHA == `theirsBlobSha`. Match →
adopt orphan (створити record що вказує на existing файл, не writeBinary
новий). Це описано в §"Dedup at create()" вище.

---

## Finalize: коли inConflictFiles стає порожнім

Коли всі path резолвлено → finalize при наступному [Sync]:

```
1. createTree(base = main.tree)  ← branch.tree уже == main.tree
2. createCommit(
     message = "Merge conflict-branch <name>",
     tree = main.tree,
     parents = [main.head, branch.head]
   )
3. updateRef main → merge-commit
4. deleteReference branch
```

Merge-commit має **два батьки** — `main.head` і `branch.head`. Усі
intermediate commits на branch (versions a.md під час правок користувача)
лишаються **досягжні з main через merge-commit** → історія "user's
struggle moments" preserved. Виглядає як справжній merge у Network graph.

**`lastSyncCommitSha` після finalize** просувається на merge-commit
(стандартна git-семантика). `compare(merge-commit, current_HEAD)`
працює для наступного pull.

**Чому manual createCommit замість `POST /merges`:** server-side merge
endpoint повертає 409 у race з іншим device. Manual підхід — ми самі
будуємо merge-commit з відомим tree і двома parents. Завжди працює.

---

## Edge case: live vault сконвергував до remote — uniform handling (Stage 13)

**Сценарій:** queue має batches з версіями A1 → A2 → A3 файлу `a.md`,
remote надсилає R1 → R2. Користувач у певний момент часу "приводить"
vault до R2 (через manual edit, copy-paste, інший плагін, тощо).

**Дизайн принцип (Stage 13):** resolution тільки на drain-start.
Якщо user сконвергував ДО [Sync] click — drain-start Phase A
бачить siblingSha == baseSha і видаляє sibling. Якщо ПІСЛЯ — resolution
чекає на наступний drain.

### Case A: vault converged ДО [Sync] click (vault == R2 на старті drain)

1. **Drain-start sweep**:
   - Якщо record уже існує з minulого sync (sibling=R2, base уже
     сконвергований до R2 user'ом) → Phase A видаляє sibling,
     drop record. Phase B: record був єдиний для path → propagate
     base (=R2) до main. Side-batch synthesized.
   - Якщо це перший drain і record ще не існує → нічого не робиться
     (store порожній, guard skip'ає).
2. Pull: `SHA(vault=R2)` == `SHA(main=R2)` → no pull-side конфлікт.
3. **batch1**: reconcile case 4 → A1 ≠ R2 → push-side detected
   конфлікт. attemptAutoMerge fails → step 4: createReference for
   conflict-branch, push A1 на branch (X1), write sibling=R2 (через
   `.sync-bak` flow), ConflictStore.create.
4. **batch2, batch3**: a.md ∈ store.records → step 5
   (edit-while-in-conflict). Push A2 (X2), A3 (X3) на branch. Без
   нового sibling/record.
5. **Drain ends**. store.records.length == 1, branch exists, finalize
   condition НЕ met (sibling ще там і user ще не сконвергував base
   щоб matchowal sibling).

Wait — це **протиріччя** з заявленим сценарієм Case A. Якщо vault уже
== R2 ДО drain'а, то batch був би з R2, не A1. Drain б побачив
`SHA(vault) == SHA(main)` після pull → no push-side conflict → no
branch created → no conflict path triggered. **Це немає сенсу як
"edge case" у Stage 13 моделі** — або queue має старі версії
(=A1...A3), або vault уже == R2 і нічого пушити.

**Revised Case A — accumulated batches + late convergence:**

1. Drain1 (раніше): conflict detected, branch created, sibling=R2
   written. Drain закінчується з store.records=[a.md → sibling=R2],
   user не сконвергував.
2. Користувач edits vault.a.md → R2 (manually copies sibling content
   or whatever). vault.on('modify') → counter listener recompute →
   counter goes from 1 to 0 (siblingSha == baseSha now). UI badge
   updates real-time.
3. Drain2 (наступний [Sync] click):
   - Drain-start sweep:
     - Phase A: record(a.md) has siblingExists, baseExists,
       siblingSha == baseSha (=R2) → engine deletes sibling, drop record.
     - Phase B: record was alone for path → path closed, synthesize
       side-batch propagate vault.a.md=R2 to main.
   - pullIfNeeded: main still at R2 → no pull
   - processBatch (side-batch from Phase B): push R2 → main (no-op tree
     since main is already R2; commit may be skipped if tree unchanged).
   - Finalize check: store.records.length == 0, branch exists → finalize:
     marker commit (X4 with R2) on branch + manual merge-commit on main
     + deleteRef branch.

**Branch lineage:** X1(A1) → X2(A2) → X3(A3) → X4(R2)
**Main:** ... → merge-commit
**Result:** усі 4 версії досяжні. Finalize в drain2 (одиничний
[Sync] click після convergence).

### Case B: vault converged ПІСЛЯ [Sync] click під час drain

Користувач натиснув [Sync] коли vault=A3, sibling=R2, drain їде.

1. Drain-start: nothing in store yet OR existing record(a.md) with
   sibling=R2 з минулого drain.
2. **Pull**: `SHA(vault=A3)` ≠ `SHA(main=R2)` → pull-side конфлікт.
   attemptAutoMerge → fail → step 4 (якщо record ще не існує) writes
   sibling=R2 (через `.sync-bak` flow), створює conflict-branch
   якщо потрібно, ConflictStore.create.
3. **batch1...batchN**: a.md ∈ store.records → step 5 push до branch.
4. **Drain ends** з store.records=[a.md → sibling=R2], branch active.
5. **Користувач пізніше** edit'ить vault.a.md → R2 (manually). counter
   listener recompute → counter = 0. UI badge оновлюється real-time.
   **АЛЕ store.records ще містить record!** Phase A не запущено бо ми
   поза drain.
6. **Наступний [Sync]** (drain3): drain-start Phase A видаляє sibling,
   drop record. Phase B: path closed → propagate base=R2 → main.
   Finalize: marker + merge + deleteRef.

**Кінцевий стан identical до Case A.** Лише timing finalize різний —
на один drain пізніше.

### Чому це працює уніформно

- Resolution **тільки** на drain-start: одна точка mutation, прості
  тести, прості reasoning.
- Counter live-оновлюється на vault.on (read-only). User бачить що
  конфлікт "вирішено" одразу як він зробив дію — навіть якщо state
  ще не сконсолідований на disk.
- Finalize fires в drain коли store.records == 0 AND branch exists —
  одна точка, передбачуване timing.
- Жодних race conditions: листенери нічого не мутують; drain — single
  thread of mutation.

### Що це дає для `accumulateOfflineSyncs` контракту

- **OFF** (default): user explicitly opt-in в preserve-all-iterations.
  Усі batches → окремі commits на branch (`A1`, `A2`, `A3`) + marker
  (`A(local=R2)`) + merge-commit. Повна історія "user's thought
  iterations" зберігається на GitHub.
- **ON**: queue має лише latest batch (`A3` only — інші absorbed).
  Branch отримує тільки A3 + marker. Меньша історія — за explicit user
  choice "I accept losing intermediates".

**Жодних додаткових оптимізацій** — поведінка природньо лягає
на existing toggle. Stage 1 не додає special-case shortcuts.

---

## 3-точкове попередження користувачу

Файли в конфлікті — **invisible to other devices**:

1. **Status bar** (постійно): `🔀 3 files — not visible on other devices`
2. **Pre-Sync modal**: `"N file(s) still in conflict. [resolve] [sync anyway]"`
   — виходить **перед кожним sync** поки список не порожній
3. **Ribbon icon**: subtle badge з кількістю

> **Settings tab badge видалено** (Stage 13 revision): user не шукає
> підтвердження конфліктів у Settings — це не природна surface для
> цього. Status bar + pre-sync modal + ribbon — три точки у звичайних
> UX surfaces. Detailed conflict list переноситься у Diff2 UI
> (stage 2) як dedicated surface, не як side-feature settings tab.

---

## Стан per-device

`metadata.conflictBranch` зберігає **тільки branch identity** (тонкий
state). `inConflictFiles` — **derived** з ConflictStore (single source
of truth). Це гарантує що state не може розсинхронізуватись між
metadata і store.

```json
{
  "conflictBranch": {
    "name": "easy-sync-conflicts-Obsidian-20260520143022-847",
    "head": "<sha>"
  }
}
```

`conflictBranch: null` — нема активного branch.

**Derived properties:**

```ts
// inConflictFiles обчислюється на льоту з ConflictStore:

get inConflictFiles(): Set<string> {
  return new Set(this.conflictStore.records.map(r => r.vaultPath));
}

// branch existence overall:

get conflictBranchActive(): boolean {
  return this.metadata.conflictBranch !== null;
}
```

Усі callers (drain partition, status bar count, settings UI, evaluator)
використовують ці getters. Жодного дубльованого persistent state.

---

## Recovery sweeps

### A. Звірка локального `conflictBranch` state з GitHub (onload)

| Локальний state                                        | Branch на GitHub                                                                              | Дія                                                                               |
|--------------------------------------------------------|-----------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| є, inConflictFiles непорожнє                           | є                                                                                             | OK (нічого)                                                                       |
| є, inConflictFiles непорожнє                           | нема                                                                                          | відновити branch на current main HEAD + перепушити локальні версії conflict-files |
| є, inConflictFiles порожнє                             | є                                                                                             | finalize (manual merge + delete)                                                  |
| є, inConflictFiles порожнє                             | нема                                                                                          | merge уже зроблений, лише локальний state не очищено → почистити                  |
| crash між merge-commit і deleteRef                     | є, але branch.tree досягається з main через merge                                             | видалити branch                                                                   |
| нема                                                   | є з нашою назвою                                                                              | orphan від попередньої сесії — нічого не робити                                   |
| нема                                                   | нема                                                                                          | OK                                                                                |
| createReference 422 "already exists" на create attempt | branch з тією ж назвою на GitHub (cross-device race з same deviceLabel + same timestamp+msec) | regenerate timestamp з фресшею now() msec → retry createReference; loop until 2xx |

### B. ConflictStore catch-up з file-system state (drain-start only — Stage 13)

**Stage 13 пивот:** catch-up НЕ виконується в onload. `ConflictStore.load()`
тільки читає `meta.json` файли і будує in-memory index — НЕ звіряє з
file-system. Catch-up відбувається **виключно на drain-start** через
2-фазний `evaluateConflictState`:

- Phase A видаляє sibling-и з siblingSha == baseSha (engine deletion).
- Phase B drop'ає records з !siblingExists (resolution через user
  delete sibling) + synthesize'ить side-batches для path-close.

Orphan vault `*.conflict-from-*` файли (без record) — **ignored
by design** (див. §"Counter formula + vault.on listeners role" →
"Why orphan siblings don't count"). Виняток — filesystem-orphan
adoption при `ConflictStore.create()` (див. §"Dedup at create()").

### C. AtomicWrite recovery (onload — vault `.sync-bak` sweep)

Окремий sweep що чистить orphan staging files від перерваних
atomic-write transactions (включно з ConflictStore.create Step 3).
Реалізований у `src/sync2/atomic-write.ts`. Контракт описаний у
§"ConflictStore — schema і persistence" → "Recovery sweep на onload".

---

## Multi-device interactions

- Кожен пристрій з конфліктом має **власний branch** (різні
  `deviceLabel` + timestamp)
- Branches пристроїв не перетинаються
- В GitHub list відображаються всі активні branches → advanced
  користувач (який заглядає на GitHub) бачить де чий конфлікт
- `Reset` button: vault до "pre-plugin state". Видаляє всі плагінні
  артефакти (snapshot, push-queue, ConflictStore, conflict-branch
  цього пристрою на remote). `*.conflict-*` файли в vault
  **перейменовуються** на `<file>.unresolved-<original-ts>.<ext>` щоб
  не колізіонувати з майбутніми siblings якщо плагін знову увімкнуть.

---

## Що pseudo-merge mode НЕ обіцяє

**1. Multi-device ping-pong на одному файлі — можливий.**

Якщо Device A і Device B одночасно отримали конфлікт на a.md, кожен
має свій приватний branch. Коли A резолвить — push до main → новий
конфлікт у B (бо main посунувся з тим що A резолвило). Це
**фундаментальний distributed-edit-conflict**, не баг (помилка) плагіна. Той
самий resolution UX повторюється.

**2. Atomicity per [Sync] — давно немає.**

Один click може розщепитися: частина файлів → main, частина → branch.
Так само як `git pull --rebase` дробить локальні commits на patch.

**3. Branch завжди приватний — не shareable.**

Інший пристрій не може "допомогти вирішити" ваш конфлікт.

**4. Orphan branches лишаються forever.**

Якщо пристрій A мав branch і зник (плагін видалили / переустановили) —
його branch лишається на GitHub без власника. Ніхто не чистить
автоматично. Користувач може видалити вручну через GitHub UI.

---

## Branch naming + lifecycle

```
easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>
```

Приклад: `easy-sync-conflicts-Obsidian-20260520143022-847`

- Префікс `easy-sync-conflicts-` → `listReferences("refs/heads/easy-sync-conflicts-*")`
- `<deviceLabel>` → alphabetical grouping (default `"Obsidian"`, customizable per device у settings)
- `<YYYYMMDDHHMMSS>` → chronological order до секунди
- `<mmm>` → milliseconds, гарантує uniqueness навіть для multi-device
  same-label sub-second collisions (два пристрої обидва з default
  `"Obsidian"` label запускають drain одночасно — можливо)

### Collision fallback

Якщо `createReference` повертає 422 `"Reference already exists"`
(extremely rare race window):
- Re-generate timestamp з поточним now() → incremented msec
- Retry createReference
- Лоопати до success (cheap, бо ймовірність повторного collision ще
  нижча)

### Lifecycle: branch per "conflict session"

Кожна **сесія конфліктів** на пристрої → один branch. Послідовність:

1. **Створення:** конфлікт виявлено → `createReference` на поточному
   main HEAD з freshly-generated name. Запис у `metadata.conflictBranch`.
2. **Заповнення:** наступні drain'и додають commits через split-push
   (наш local content конфліктних paths). Branch росте.
3. **Resolution:** user поступово резолвить siblings. ConflictStore
   records прибираються через `evaluateConflictState()`.
4. **Finalize:** коли `inConflictFiles` стає порожнім + branch != null
   → marker commit + merge-commit на main → `deleteReference` branch.
   `metadata.conflictBranch = null`.
5. **Наступний конфлікт** (можливо тижні пізніше) — **новий branch** з
   новим timestamp. Старий лишається reachable через merge-commit на
   main (commits not GC'd).

**Net history view**: у GitHub Network graph — chronological серія
коротких бічних гілок, кожна merged назад. "Ага, оцей з січня"
(branch уже deleted, але commits видно через merge-commit's second
parent). Свіжіша колізна сесія = окрема гілка, не reuse старого.

---

## GitHub REST API mechanics

| Операція                | Endpoint                                                        | Нюанси                                                                                            |
|-------------------------|-----------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| Create branch           | `POST /repos/:o/:r/git/refs`                                    | body: `{ref: "refs/heads/<name>", sha: <base>}`                                                   |
| Push commit             | `createTree` + `createCommit` + `updateRef`                     | стандартний flow з 2.0.0-beta                                                                     |
| Remove file from tree   | `POST /repos/:o/:r/git/trees` з `base_tree` + entries           | entry **повна форма**: `{path, mode: "100644", type: "blob", sha: null}` — усі 4 поля обов'язкові |
| Finalize merge (manual) | `createCommit`                                                  | body: `{message, tree, parents: [<main.head>, <branch.head>]}` — ми контролюємо tree              |
| Delete branch           | `DELETE /repos/:o/:r/git/refs/heads/:branch`                    | 204 на успіх; 422 якщо ref не існує                                                               |
| List our branches       | `GET /repos/:o/:r/git/matching-refs/heads/easy-sync-conflicts-` | для recovery sweep                                                                                |

Усі endpoints — звичайні REST, працюють на mobile WebView.

---

## Decisions made

| #  | Рішення                                                                                                                                                                                                                                                                                                                                    | Контекст                                             |
|----|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------|
| 1  | Manual commit messages прибираються — єдиний user-visible removal                                                                                                                                                                                                                                                                          | API + 2 з 4 команд                                   |
| 2  | ~~Решта 2.0.0-beta commit/batch layer — без змін (`.attempted`, `accumulateOfflineSyncs`, syncFile, `{filename}`/`{path}` — все живе)~~ **superseded by #36** for commit-templates portion; `.attempted` / `accumulateOfflineSyncs` / `syncFile` still preserved                                                                           | minimal-additive scope для batch layer               |
| 3  | `EnqueueMeta.isolated` повністю видаляється — verified dead code після removal customMessage                                                                                                                                                                                                                                               | no backwards compat needed                           |
| 4  | Conflict resolution layer переписується з нуля (старі алгоритми не успадковуються)                                                                                                                                                                                                                                                         | критично переглянути 2.0.0-beta conflict path        |
| 5  | Split-push на рівні `processBatch` (variant β)                                                                                                                                                                                                                                                                                             | один batch → до 2 push-секвенцій                     |
| 6  | Branch tree завжди rebase'иться вперед: `base_tree = current main.tree + override conflict files`                                                                                                                                                                                                                                          | уникає staleness через тижні                         |
| 7  | Per-half marker `.main-pushed` для crash-safety split-push retry                                                                                                                                                                                                                                                                           | recovery-aware multi-step disk op                    |
| 8  | Conflict detection — два entry points (pull-side + push-side) → один shared state (inConflictFiles + ConflictStore)                                                                                                                                                                                                                        | uniform downstream consumption                       |
| 9  | Branch створюється **eagerly** у drain при першому conflict detection (не lazy)                                                                                                                                                                                                                                                            | гарантує persistent backup стану на момент конфлікту |
| 10 | Resolution detection — event-driven через `vault.on(…)`, окремий шар від sync engine                                                                                                                                                                                                                                                       | bypass polling для миттєвого state update            |
| 11 | Resolution push timing — **option A**: state-update real-time, push до main на наступному [Sync] click                                                                                                                                                                                                                                     | узгоджено з polling sync model                       |
| 12 | Drain-start sweep + onload sweep — додаткові entry points до event listener                                                                                                                                                                                                                                                                | catches race conditions + missed events              |
| 13 | `gitBlobSha(path)` кешується за `(path, mtime, size)`                                                                                                                                                                                                                                                                                      | performance для onload sweep                         |
| 14 | ~~Orphan cleanup симетричний: ConflictStore.load() + sibling-without-record cleanup~~ **superseded by #28+#31:** `load()` не торкається filesystem; orphan-siblings (без record) ignored by design; orphan-records (без sibling) drop'аються на drain-start Phase A.                                                                       | uniform invariants — Stage 13 rewrite |
| 15 | ~~Resolution має 3 кейси (rename/copy auto-collapse у кейси 1 і 4)~~ **superseded by #28:** classifier reduced to 2-phase model — Phase A per-record vanish→drop, Phase B per-path close.                                                                                                                                                  | trust user actions, no special detection — Stage 13 simplification |
| 16 | pullIfNeeded для in-conflict paths → новий sibling (multi-sibling шлях)                                                                                                                                                                                                                                                                    | path може мати N siblings з різних devices           |
| 17 | Multi-sibling кейс 4: резолвиться тільки той sibling що збігся, інші лишаються                                                                                                                                                                                                                                                             | path в inConflictFiles до резолюції всіх             |
| 18 | `lastSyncCommitSha` після finalize → advance на merge-commit                                                                                                                                                                                                                                                                               | стандартна git-семантика                             |
| 19 | Conflict-branch naming: `<plugin-id>-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>`, e.g.:`github-easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>`                                                                                                                                                                               | grouping + chronological                             |
| 20 | Edit-while-in-conflict дозволено; edits route до branch у processBatch                                                                                                                                                                                                                                                                     | стандартний batch flow                               |
| 21 | ~~4-point~~ **3-point** visibility warning (status bar + pre-sync modal КОЖЕН раз + ribbon). Stage 13 revision: settings tab badge видалено — user не шукає conflict info там; перенесено у Diff2 (stage 2).                                                                                                                               | соціальний тиск на резолюцію                         |
| 22 | Reset → `*.conflict-with-*` перейменовуються на `<file>.unresolved-<original-ts>.<ext>`                                                                                                                                                                                                                                                    | clean slate без знищення user files                  |
| 23 | Orphan branches не чистяться автоматично — лишаються forever                                                                                                                                                                                                                                                                               | "висить і висить, їсти не просить"                   |
| 24 | Backwards-compat не потрібний (sole user)                                                                                                                                                                                                                                                                                                  | no migration code                                    |
| 25 | Diff2 — pure UX layer поверх цього механізму; усі резолюції доступні через Obsidian-нативні файлові операції                                                                                                                                                                                                                               | clear architectural separation                       |
| 26 | **Stage 13:** Resolution — drain-start only (no onload, no drain-end, no online resolution). Guard `if (store.records.length > 0)`.                                                                                                                                                                                                        | спрощує state mutation surface; mobile race bugs fix |
| 27 | **Stage 13:** vault.on listeners — READ-ONLY (тільки counter recompute). Жодних мутацій store, classifier, deletions.                                                                                                                                                                                                                      | прибирає mid-drain race + restore-from-backup bug    |
| 28 | **Stage 13:** Classifier — 2-фазний. Phase A: SHA-match cleanup (engine deletes sibling). Phase B: path-close (всі siblings зникли).                                                                                                                                                                                                       | спрощує 12-row classifier до 2-фазного pipeline      |
| 29 | **Stage 13:** Sibling staging через vault-level `*.sync-bak*` через `atomicWriteFile`, НЕ `<configDir>/.conflicts/<id>/sibling-content.bin`.                                                                                                                                                                                               | reuse existing atomic-write infra; merge recovery   |
| 30 | **Stage 13:** Classifier row 3 (`!baseExists + modify-vs-modify`) → `noop` (раніше `delete-wins-cascade`). Mobile "delete-base-then-rename" workflow now works.                                                                                                                                                                            | trust user; cascade-delete винесений в UI button (out of scope) |
| 31 | **Stage 13:** `ConflictStore.load()` НЕ відновлює sibling з backup. Missing sibling = resolution signal. Fixes auto-restore bug.                                                                                                                                                                                                           | filesystem is truth; store is read-through cache     |
| 32 | **Stage 13:** Recovery sweep — SHA-verify `*.sync-bak*` против `record.theirsBlobSha` перед rename → finalPath.                                                                                                                                                                                                                            | defense in depth проти disk corruption / race        |
| 33 | **Stage 13:** Filesystem-orphan adoption — `ConflictStore.create()` scans parent directory для existing sibling з matching SHA перед spawning нового.                                                                                                                                                                                      | fix duplicate-sibling bug (4 phantom siblings 2026-05-21) |
| 34 | **Stage 13:** `ConflictKind` field — informational only. Classifier на нього не дивиться. Лишається для логів/observability.                                                                                                                                                                                                               | uniform model — kind diverges only at create-time decisions |
| 35 | **Stage 13:** Counter formula excludes records з `siblingSha == baseSha`. Counter live-recomputes на vault.on event.                                                                                                                                                                                                                       | accurate UI feedback навіть до drain                 |
| 36 | **Stage 13 scope expansion:** Видаляються ВСІ commit-message templates. Hardcoded формати з `{deviceLabel}` substitution only. `commit-templates.ts` + tests + settings UI + `meta.commitMessage` field — всі видалені. `synthetic: true` поле у meta.json для Phase B side-batches, `mergeIntoLatestPending` пропускає synthetic batches. | спрощує scope; чітко розділяє user-batches і resolution batches |

---

## Test plan

> **Stage 13:** старий M/N/O/P/Q/R-series план видалено. Він був
> розрахований на event-driven model (drain-end sweep, ConflictWatcher
> evaluateConflictState calls), і більшість його точок не aligns з
> новою архітектурою.
>
> Заміна — **Phase 2 test audit** (нижче — заплановане місце для table'у)
> + **5 test categories** (A-E) для нових тестів.

### Phase 2 test audit (planned — окремий commit)

Audit table з усіх existing pseudo-merge tests:

```
| File | describe → it | Setup | Scenario | Status under Stage 13 | Action |
```

- `Status` ∈ {`aligns`, `partial`, `broken-by-pivot`}
- `Action` ∈ {`KEEP`, `REWRITE`, `DELETE`, `NEW`}

Sources (~19 файлів):
- `tests/sync2/conflict-*.test.ts` (4: watcher, classifier, store, detection)
- `tests/integration/scenarios/sync2/conflicts/` (7)
- `tests/integration/scenarios/sync2/conflicts-misc/` (4)
- `tests/integration/scenarios/sync2/multi-device/` (4 G*)

Read every `it()` — не інферити по filename.

### 5 test categories для нових тестів (Phase 3 RED + Phase 4 GREEN)

**A. Unit — pure algorithm** (мокаємо vault, no I/O outside):
- classifier 2-phase: vanish→drop semantics, SHA-match cleanup, path-close synthesis trigger
- `.sync-bak` naming algorithm: stem/ext split for hidden files, extensionless, files з multiple dots
- counter formula edge cases: missing base, missing sibling, SHA cache stale
- ConflictCounter dirty-flag + debouncing behavior

**B. Workflow — end-to-end user actions** (mock vault з повним sequence):
- delete-base-then-rename-sibling (mobile-shaped: explicit remove + rename)
- copy-sibling-into-base (no delete) → engine cleans on next drain (Phase A SHA-match)
- multi-sibling partial resolution (user resolves 1 of 3, інші не torknyut'ся)
- accumulate offline: user batch + resolution side-batch don't merge

**C. Lifecycle — restart-survivable invariants** (catches 2026-05-21 class):
- delete sibling → tear down store → reload → sibling stays gone, record dropped
- crash mid-`.sync-bak`-stage → AtomicWriteRecovery completes Step 3
- crash AFTER `.sync-bak` rename → recovery drops orphan staging
- corrupted `.sync-bak` (SHA mismatch) → recovery drops + record cleans on next drain
- pull-side new-sibling that coincidentally matches base → next drain Phase A auto-cleans

**D. Multi-device — real GitHub round-trips** (branch-per-test):
- Device A creates conflict, Device B receives it (sibling on disk, new record)
- ping-pong: A resolves, B sees new conflict propagated
- N-sibling accumulation from M devices (multi-sibling stress)

**E. Capacitor-divergence — paired desktop/mobile** (parameterized via MOCK_PLATFORM):
- rename overwrite: desktop POSIX vs mobile Capacitor throws-if-exists
- adapter.list returns root dotfiles (already a bug fix from eacbd93)
- writeBinary chunk semantics on big files
- `describe.each([{platform: "desktop"}, {platform: "mobile"}])` pattern

Allocation:
- A, B, C, E → unit suite (`tests/sync2/`), mocked obsidian
- D → integration suite (`tests/integration/scenarios/sync2/`), real GitHub
- E specifically requires MOCK_PLATFORM mode in mock-obsidian (Phase 1.6 prerequisite)

---

## Phase 2 test audit (2026-05-23)

Audit of 19 existing pseudo-merge test files (4 unit + 15 integration)
against the Stage 13 model. Each test is classified by status
(`aligns | partial | broken-by-pivot | irrelevant`) and gets an action
(`KEEP | REWRITE | DELETE | NEW`) plus an effort estimate (S/M/L)
for Phase 4 sequencing.

**Status semantics:**
- `aligns` — Stage 13 doesn't change the behavior or API; test passes as-is or with cosmetic assertion updates.
- `partial` — behavior survives but API surface (return shape, callee, etc.) changes; assertions need rewrite.
- `broken-by-pivot` — premise contradicts Stage 13 (event-driven mutation, row 3 cascade, auto-restore on load, etc.). Whole test class invalidated.
- `irrelevant` — tests something orthogonal to pseudo-merge (snapshot reconcile, plain rotation); Stage 13 doesn't touch it.

**Effort estimates:**
- **S** (≤30 min) — assertion swaps, type signature updates, minor setup tweaks
- **M** (30 min – 2 h) — moderate rewrite, new test infrastructure (mock platform, stubs), multi-step setup changes
- **L** (2 h+) — full workflow rewrite involving real GitHub round-trips, multi-device, drain restructuring

### Summary

| File | Tests | KEEP | REWRITE | DELETE | NEW (planned) |
|---|---|---|---|---|---|
| `tests/sync2/conflict-watcher.test.ts` | 13 | 0 | 4 | 9 | — |
| `tests/sync2/conflict-classifier.test.ts` | 19 | 7 | 7 | 5 | — |
| `tests/sync2/conflict-store.test.ts` | 30 | 26 | 3 | 1 | — |
| `tests/sync2/conflict-detection.test.ts` | 21 | 21 | 0 | 0 | — |
| `tests/integration/scenarios/sync2/conflicts/` (7 files) | 8 | 5 | 1 | 2 | — |
| `tests/integration/scenarios/sync2/conflicts-misc/` (4 files) | 6 | 6 | 0 | 0 | — |
| `tests/integration/scenarios/sync2/multi-device/` (4 files) | 4 | 4 | 0 | 0 | — |
| **Total existing** | **101** | **69 (68%)** | **15 (15%)** | **17 (17%)** | — |
| **NEW tests (Phase 3 planned)** | — | — | — | — | **~18** |

Most disruption hits the unit conflict-watcher tests (13/13 either deleted or rewritten because the watcher's premise — mutating store from listeners — is gone). All `conflict-detection.test.ts` survives untouched because Stage 13 doesn't touch auto-merge logic. Integration suite is mostly intact — the workflow-level tests already use the same patterns Stage 13 preserves.

### Detail — `tests/sync2/conflict-watcher.test.ts`

13 tests. 9 broken, 4 partial/rewrite. **All cluster under one root cause: Stage 13 makes vault.on listeners read-only.**

| Line | Test | Status | Action | Effort | Replacement target | Notes |
|---|---|---|---|---|---|---|
| 104 | `handle(): irrelevant path → skips evaluation` | broken | DELETE | S | A-counter: `markDirty NOT called for irrelevant path` | Eval no longer called from listener |
| 121 | `handle(): base path with active conflict → fires evaluation` | broken | DELETE | S | A-counter: `markDirty called for base path` | Same |
| 146 | `handle(): sibling path → also triggers` | broken | DELETE | S | A-counter: `markDirty for sibling path` | Same |
| 171 | `pause()/resume(): handles are no-ops, reactivates without queuing` | broken | DELETE | S | none | No pause/resume in Stage 13 |
| 205 | `isPaused() reflects current state` | broken | DELETE | S | none | No pause API |
| 219 | `concurrent handle() calls serialize through the chain` | broken | DELETE | S | A-counter: `markDirty coalesces concurrent events` | Chain removed; counter dirty-flag handles |
| 252 | `queued tasks re-check relevance — already-resolved silently skips` | broken | DELETE | S | none | No queue in counter-only design |
| 279 | `start() registers delete/modify/rename listeners` | partial | REWRITE | S | itself with counter callback | Listeners survive; callback target changes |
| 301 | `start() is idempotent` | partial | REWRITE | S | itself | Same |
| 314 | `stop() unsubscribes all listeners` | partial | REWRITE | S | itself | Same |
| 329 | `end-to-end: vault.fireEvent('delete', sibling) → record resolved` | broken | DELETE | S | A-counter: `vault.on triggers markDirty → counter recomputes` | No record resolution from listener |
| 346 | `end-to-end: vault.fireEvent('rename', new, old) → both paths checked` | partial | REWRITE | S | A-counter: same shape, markDirty target | Dual-path check survives |
| 373 | `onError catches eval failures; chain stays alive` | broken | DELETE | S | none (counter has no chain) | Counter errors handled differently |

### Detail — `tests/sync2/conflict-classifier.test.ts`

19 tests split between pure `classify()` (9) and `evaluateConflictState` orchestrator (10). Pivot impact: row 3 cascade → noop; return shape changes (recordsRefreshed → ?), 2-phase rewrite.

**Pure `classify()` (9 tests):**

| Line | Test | Status | Action | Effort | Replacement target | Notes |
|---|---|---|---|---|---|---|
| 63 | `Row 1: !sibling, modify-vs-modify → accept-ours` | partial | REWRITE | S | A-classifier: `Phase B path-close on !sibling` | Decision type renamed under 2-phase |
| 75 | `Row 1: !sibling, delete-vs-modify → accept-ours` | partial | REWRITE | S | A-classifier: same | Same |
| 93 | `Row 3: sibling, !base, modify-vs-modify → delete-wins-cascade` | broken | DELETE | S | A-classifier: `!base + sibling → noop` (Decision #30) | Cascade removed; mobile delete-then-rename workflow now works |
| 107 | `Row 5: sibling, !base, delete-vs-modify → noop` | aligns | KEEP | S | itself | Noop survives |
| 121 | `Row 6: base === sibling, modify-vs-modify → accept-theirs` | partial | REWRITE | S | A-classifier: `Phase A SHA-match → engine deletes sibling + drops record` | Same outcome, different decision type |
| 133 | `Row 6: base === sibling, delete-vs-modify → accept-theirs` | partial | REWRITE | S | A-classifier: same | Same |
| 148 | `Row 7: sibling, base, base ≠ sibling, delete-vs-modify → noop` | aligns | KEEP | S | itself | Noop survives |
| 160 | `Row 8: modify-vs-modify, base ≠ sibling AND base ≠ ours → noop` | aligns | KEEP | S | itself | Noop survives |
| 172 | `Row 9: modify-vs-modify, base === ours → noop` | aligns | KEEP | S | itself | Noop survives |

**`evaluateConflictState` orchestrator (10 tests):**

| Line | Test | Status | Action | Effort | Replacement target | Notes |
|---|---|---|---|---|---|---|
| 281 | `user deletes sibling (case 1) → record dropped, path resolved` | aligns | KEEP | S | itself | Phase B path-close matches |
| 296 | `user copies sibling onto base (case 6) → record + vault sibling dropped` | partial | REWRITE | S | itself with Phase A semantic | Engine deletes sibling under Phase A; behavior identical |
| 318 | `user deletes base on modify-vs-modify (case 3) → cascade-delete entire path` | broken | DELETE | S | none (cascade gone) | Stage 13 row 3 → noop; new test "delete base + sibling → propagate delete" instead |
| 346 | `initial state (base === ours, sibling intact) → noop + lastEvaluated bumped` | partial | REWRITE | S | A-classifier with new return shape | `lastEvaluated` field may move |
| 369 | `sibling mtime+size unchanged → cache hit, no read+hash, no refreshed entry` | partial | REWRITE | S | A-classifier: cache hit semantics survive | `recordsRefreshed` return field may rename |
| 379 | `sibling touched (mtime changed) → recordsRefreshed includes id` | partial | REWRITE | S | A-classifier: same | Same |
| 408 | `multi-sibling: resolving one keeps the other; path NOT resolved until both go` | aligns | KEEP | S | itself | Exactly the Stage 13 multi-sibling behavior |
| 439 | `multi-path: each path classified independently` | aligns | KEEP | S | itself | Phase B per-path semantics |
| 476 | `re-running on already-resolved state is a no-op` | aligns | KEEP | S | itself | Idempotency survives |
| 492 | `empty store → empty result` | aligns | KEEP | S | itself | Empty path matches |

### Detail — `tests/sync2/conflict-store.test.ts`

30 tests across helpers (8), create (5), dedup (3), crash recovery (3), defensive coercion (5), updateCache (3), delete+clearAll (2), multi-sibling (1), reload (1). Most survive: schema validation, atomic write protocol unchanged; only `sibling-content.bin` references and auto-restore on load break.

**Helpers — `extensionOf` (3) + `buildSiblingPath` (5):** all 8 aligns. KEEP. Effort: S each.

**create (5):**

| Line | Test | Status | Action | Effort | Notes |
|---|---|---|---|---|---|
| 173 | `writes meta.json + sibling-content.bin + vault sibling for modify-vs-modify` | broken | REWRITE | M | Sibling-content.bin replaced by vault-level `.sync-bak` (Decision #29). Assertion targets must change |
| 186 | `delete-vs-modify: oursBlobSha is null on disk` | aligns | KEEP | S | Schema field unchanged |
| 204 | `populates siblingMtime/Size cache from final vault stat` | aligns | KEEP | S | Cache fields unchanged |
| 211 | `indexes by vaultPath + by id` | aligns | KEEP | S | In-memory index unchanged |
| 220 | `indexes by sibling path (O(1) lookup)` | aligns | KEEP | S | Sibling index unchanged |

**dedup (3):** all aligns. KEEP. Note: new filesystem-orphan adoption test needed (NEW row in Phase 3).

**crash recovery on load (3):**

| Line | Test | Status | Action | Effort | Notes |
|---|---|---|---|---|---|
| 267 | `step-1 crash (recordDir + sibling-content.bin but no meta.json) → rmdir recordDir` | aligns | KEEP | S | Orphan cleanup survives; just no `sibling-content.bin` now |
| 280 | `step-3 crash (meta.json + backup, but vault sibling missing) → re-emits vault sibling from backup` | broken | DELETE | S | Stage 13: load() does NOT auto-restore from backup. Replacement: C-lifecycle `.sync-bak` recovery completes Step 3 |
| 310 | `step-3 done then external delete of vault sibling AND backup → record stays, but cache untouched` | partial | REWRITE | S | Under Stage 13: record drops on next drain Phase B (not "stays"). REWRITE assertions |

**defensive coercion (5):** all aligns. KEEP. Effort: S each.

**updateCache (3):** all aligns. KEEP. Effort: S each.

**delete + clearAll (2):** all aligns. KEEP. Effort: S each.

**multi-sibling (1):** aligns. KEEP.

**reload (1):** aligns. KEEP.

### Detail — `tests/sync2/conflict-detection.test.ts`

21 tests. All aligns. KEEP all. Stage 13 doesn't touch auto-merge logic (text 3-way, plugin-js semver, binary register-conflict). Effort: S each, zero rewrite work.

| Block | Tests | Status |
|---|---|---|
| `classifyConflictKind` | 4 | all aligns |
| `attemptAutoMerge — text 3-way` | 4 | all aligns |
| `attemptAutoMerge — plugin-js semver` | 10 | all aligns |
| `attemptAutoMerge — binary` | 3 | all aligns |
| `attemptAutoMerge — strategy dispatch` | 3 | all aligns |
| `AutoMergeResult type` | 2 | all aligns |

### Detail — `tests/integration/scenarios/sync2/conflicts/`

8 it() blocks across 7 files. Most survive — workflow-level tests use sibling-delete patterns that Stage 13 preserves.

| File | Test | Status | Action | Effort | Notes |
|---|---|---|---|---|---|
| `branch-lifecycle.test.ts` | `register → branch created with ours commit → resolve → finalize merge + deleteRef` | partial | REWRITE | L | Core flow survives. Currently calls `evaluateConflictState` directly; under Stage 13 may use drain. Assertions on conflict-branch name pattern stable |
| `classifier-case6-accept-theirs.test.ts` | `user copies sibling onto base → classifier accepts theirs + drops record` | aligns | KEEP | S | Phase A SHA-match cleanup gives same outcome |
| `defer-then-resolve-via-sibling-delete.test.ts` | `overlap → sibling registered → delete sibling → next sync pushes ours` | aligns | KEEP | S | Phase B path-close gives same outcome |
| `edit-while-in-conflict.test.ts` | `conflict → edit local file again → next sync lands the edit on the branch, not main` | partial | REWRITE | M | Edit-while-in-conflict may route through synthetic batches under Stage 13. Assertions on branch.head SHA stable |
| `multi-copy-pair-resolution.test.ts` | `two siblings on one path → resolve both → final push goes through` | aligns | KEEP | S | Multi-sibling Phase B handling works |
| `pending-conflict-blocks-push.test.ts` | `edits to a pending-conflict path stay local; clean path goes through` | aligns | KEEP | S | Partition behavior preserved |
| `watcher-realtime.test.ts` | `vault.on('delete', sibling) drops record before any further sync` | broken | DELETE | S | Stage 13: listeners don't mutate. Replacement: A-counter test confirming counter recomputes |
| `watcher-realtime.test.ts` | `drain pauses watcher: mid-drain sibling write doesn't loop classifier` | broken | DELETE | S | No pause/resume in Stage 13. Replacement: none needed (counter is read-only by design) |

### Detail — `tests/integration/scenarios/sync2/conflicts-misc/`

6 it() blocks across 4 files. All aligns. KEEP all.

| File | Test | Status | Action | Effort | Notes |
|---|---|---|---|---|---|
| `E1-reconcile-onload.test.ts` | `edit vault file with no client running → re-instantiated client picks it up on next sync` | irrelevant | KEEP | S | Tests SnapshotStore reconcile, not pseudo-merge |
| `E2-binary-conflict-atomic.test.ts` | `binary differs on both sides → modify-vs-modify registered, no silent overwrite` | aligns | KEEP | S | Binary register-conflict preserved |
| `E3-plugin-js-semver.test.ts` | `remote plugin version 2.0.0 > local 1.0.0 → remote main.js wins` | aligns | KEEP | S | semver auto-resolve unchanged |
| `E3-plugin-js-semver.test.ts` | `local plugin version 3.0.0 > remote 1.5.0 → local main.js wins, lifts to remote` | aligns | KEEP | S | Same |
| `E3-plugin-js-semver.test.ts` | `non-plugin .js falls through to standard text 3-way merge` | aligns | KEEP | S | Standard text branch |
| `E4-plugin-js-same-version-mtime.test.ts` | `both sides at 1.0.0, local mtime in future → local main.js wins` | aligns | KEEP | S | mtime tie-break |
| `E4-plugin-js-same-version-mtime.test.ts` | `both sides at 1.0.0, local mtime in past → remote main.js overwrites local` | aligns | KEEP | S | Same |
| `E4-plugin-js-same-version-mtime.test.ts` | `remote manifest missing/malformed → falls back to mtime regardless of local version` | aligns | KEEP | S | Defensive fallback |

### Detail — `tests/integration/scenarios/sync2/multi-device/`

4 it() blocks across 4 files. All aligns/irrelevant. KEEP all.

| File | Test | Status | Action | Effort | Notes |
|---|---|---|---|---|---|
| `G1-three-device-rotation.test.ts` | `A → B → C → A picks up each device's contribution` | irrelevant | KEEP | S | Plain rotation, no conflicts |
| `G2-same-file-disjoint-edits.test.ts` | `A edits line 1, B edits line 3 on the same file → merged result has both` | aligns | KEEP | S | 3-way merge, no Stage 13 impact |
| `G3-same-line-conflict.test.ts` | `both devices edit line 1 → second pusher registers conflict; resolve via sibling delete` | aligns | KEEP | S | Workflow preserved |
| `G4-binary-atomic-across-devices.test.ts` | `A and B both modify img.png; B's sync registers conflict + sibling; resolve via sibling delete` | aligns | KEEP | S | Same |

### Coverage gaps — NEW tests required for Stage 13

Tests that don't exist yet but Stage 13 requires. Each maps to a test category (A-E) from the broader test plan. Phase 3 RED writes these against the API stubs (Phase 1.7); Phase 4 GREEN fills implementations to make them pass.

| # | NEW test | Category | File | Effort |
|---|---|---|---|---|
| N1 | `ConflictCounter.markDirty + getValue: recompute happens once per dirty window` | A | `tests/sync2/conflict-counter.test.ts` (new) | M |
| N2 | `ConflictCounter.subscribe: callback fires only on changed value, debounced` | A | same | M |
| N3 | `ConflictCounter.flush: forces immediate recompute, bypasses microtask debounce` | A | same | S |
| N4 | `ConflictCounter formula edge cases: missing base, !exists sibling, SHA cache stale` | A | same | M |
| N5 | `PushQueue.enqueueSynthetic: creates batch with synthetic=true; returns id` | A | `tests/sync2/push-queue.test.ts` (extend) | M |
| N6 | `PushQueue.enqueueSynthetic: never folds into next user enqueueOrMerge` | A | same | M |
| N7 | `mergeIntoLatestPending skips synthetic batches even when fresh and non-attempted` | A | same | S |
| N8 | `.sync-bak naming algorithm: stem.ext, hidden files, extensionless files, multi-dot names` | A | `tests/sync2/atomic-write.test.ts` (extend) | S |
| N9 | `AtomicWriteRecovery.sweep SHA-verify: matches → finalize Step 3; mismatch → drop` | C | same | M |
| N10 | `ConflictStore.load: missing sibling does NOT restore from backup (fix 2026-05-21 bug)` | C | `tests/sync2/conflict-store.test.ts` (add to existing crash-recovery describe block) | S |
| N11 | `ConflictStore.create: filesystem-orphan adoption — scan parent dir, adopt matching SHA orphan` | A | `tests/sync2/conflict-store.test.ts` (add to dedup describe) | M |
| N12 | `classifier !base + sibling → noop (NOT cascade) — confirms Decision #30` | A | `tests/sync2/conflict-classifier.test.ts` (replaces old row 3 cascade test) | S |
| N13 | `delete-base-then-rename-sibling workflow: works under MOCK_PLATFORM=mobile` | B+E | `tests/sync2/...workflow.test.ts` (new) | M |
| N14 | `pull-side new-sibling that matches base coincidentally → next drain Phase A auto-cleans` | C | `tests/sync2/...lifecycle.test.ts` (new) | M |
| N15 | `GitignoreInvariants.enforce: drops mtime/hash short-circuit, always reads+splices+compares` | A | `tests/sync2/gitignore-invariants.test.ts` (extend) | S |
| N16 | `Commit messages: hardcoded "sync ({deviceLabel})" / "resolve conflict ({deviceLabel})" — no template substitution` | A | `tests/sync2/push-queue.test.ts` (extend) | S |
| N17 | `MOCK_PLATFORM=mobile reveals rename-overwrite bugs paired with desktop pass` | E | already added in `tests/mock-obsidian-platform.test.ts` (Phase 1.6); extend with conflict-store create flow | M |
| N18 | `Counter live-recomputes on bulk vault.on events (5 delete events → 1 recompute)` | A | `tests/sync2/conflict-counter.test.ts` | M |

**Effort total:** roughly 16h (S=~10×S × ~20min, M=~14×M × ~1h, L=~1×L × 3h).

### Bail-out flags for Phase 3-4

These tests merit a closer look during Phase 3-4 (questions to ask before assuming):

- **`conflict-watcher.test.ts:373`** (`onError catches eval failures; chain stays alive`) — counter has no chain, but does it need error handling for failed recomputes? Worth deciding before deleting outright.
- **`conflict-store.test.ts:310`** (`external delete of vault sibling AND backup → record stays`) — under Stage 13 record drops on next drain. But the test currently asserts record SURVIVES; if there's a reason for that (e.g., delaying drop to avoid data loss when user wipes everything), surface it before REWRITE.
- **`branch-lifecycle.test.ts`** — calls `evaluateConflictState` directly. Phase 4 may route via drain instead. Decide whether the test should assert on drain-mediated flow or keep a direct classifier call as a sanity check.

---

## Phase 3 RED test plan (2026-05-23)

Synthesis of Phase 2 audit findings into actionable test-writing
order. Phase 3 produces RED tests; Phase 4 GREEN flips them
in-order. Each subsection below corresponds to one Phase 4
implementation group (per "Phase 4 — dependency-ordered sequence"
in the Stage 13 pivot notice).

### Phase 4 progress snapshot (live tracker)

| Group | What | Phase 3 commit | Phase 4 commit | State |
|---|---|---|---|---|
| 1 | enqueueSynthetic + meta.synthetic field | `4330c84` | `379a666` | ✅ GREEN |
| 2 | Classifier row 3 → noop (Decision #30) | `a84246a` | `164fb93` | ✅ GREEN |
| 3 | ConflictStore.load drops auto-restore | `eb98843` | `3c59969` | ✅ GREEN |
| 4 | `.sync-bak` pre-suffix `stagingPathFor` | `461da2e` | (this commit) | ✅ GREEN (algorithm); ⏸ migration of `atomicWriteFile` + `ConflictStore.create` staging is follow-on work |
| 5 | ConflictCounter (dirty-flag + subscribers) | `6b3c4ee` | `2da64ff` | ✅ GREEN |
| 6 | Drain wiring + ConflictCounter wire-up | (REWRITEs in unit suite) | (this commit) | ✅ GREEN |
| 7 | Filesystem-orphan adoption at create | `dc5d0e2` | `d1af154` | ✅ GREEN |
| 8 | GitignoreInvariants always-write | `dc5d0e2` | (this commit) | ✅ GREEN |
| 9 | Commit-template removal (Decision #36) | (deferred) | — | ⏸ pending |
| 10 | Visibility 4→3 point (settings-tab badge) | (deferred) | — | ⏸ pending |

**Status snapshot (last update: 2026-05-23):** 8/10 groups GREEN.
Group 6 (drain wiring + ConflictCounter wire-up) turned the new
counter architecture from dark code into live production: the
counter is constructed in main.ts onload, the watcher is now
counter-only (no store mutation, no eval calls), drain dropped
pause/resume and the drain-end sweep, and the UI badge reads
counter.getValue() with subscribe-driven refresh. The 2026-05-21
race-condition class is now actually fixed in production paths.

Test suite state: 528 passed + 2 todo, 0 RED.

Remaining Phase 4 work: Group 9 (commit-template removal), Group 10
(settings-tab badge cleanup), plus the Group 4 migration follow-on
(refactor atomicWriteFile / ConflictStore.create to use
`stagingPathFor`, unlock N9/N9b SHA-verify todos).

**Discipline:**
- Write tests against the **Phase 4 API surface** (locked via stubs in
  Phase 1.7), not the current implementation. The stubs throw "Not
  implemented" — that IS the RED state.
- Each Phase 4 commit ships a code change AND turns a specific group
  of RED tests GREEN. Don't bundle.
- Tests in the same group are written together as one Phase 3 commit
  (or a small number of grouped commits if the group is large).

### Phase 4 Group 1 — Foundation (synthetic field + enqueueSynthetic) ✅

**RED tests to land:**
- N5: `PushQueue.enqueueSynthetic: creates batch with synthetic=true, returns id`
- N6: `PushQueue.enqueueSynthetic: never folds into next user enqueueOrMerge call`
- N7: `mergeIntoLatestPending skips synthetic batches even when fresh and non-attempted`

**Existing tests to keep watching during this group:**
- `push-queue.test.ts` existing dedup + merge tests — confirm no regression

**Critical-path callout:** This group MUST land FIRST. Many subsequent
groups (especially #6 Drain wiring) call `enqueueSynthetic` directly
from Phase B side-batch synthesis. Without #1 GREEN, #6 has nothing to
exercise.

### Phase 4 Group 2 — Classifier rewrite (2-phase + row 3 noop) ✅

**RED tests to land:**
- N12: `classifier !base + sibling → noop (NOT delete-wins-cascade) — confirms Decision #30`

**Existing tests to REWRITE in same commit:**
- `conflict-classifier.test.ts:63, 75` (Row 1 returns updated decision shape)
- `conflict-classifier.test.ts:121, 133` (Row 6 → Phase A SHA-match cleanup name)
- `conflict-classifier.test.ts:296` (case 6 evaluator — same outcome, new shape)
- `conflict-classifier.test.ts:346` (initial state — `lastEvaluated` shape may move)
- `conflict-classifier.test.ts:369, 379` (cache hit/miss — `recordsRefreshed` field rename)

**Existing tests to DELETE in same commit:**
- `conflict-classifier.test.ts:93` (Row 3 cascade — superseded by N12)
- `conflict-classifier.test.ts:318` (case 3 cascade evaluator)

### Phase 4 Group 3 — ConflictStore.load — drop auto-restore ✅

**RED test to land:**
- N10: `ConflictStore.load: missing sibling does NOT restore from backup (fix 2026-05-21 bug)`

**Existing tests to DELETE in same commit:**
- `conflict-store.test.ts:280` (step-3 crash re-emits sibling from backup — directly contradicts Stage 13)

**Existing tests to REWRITE:**
- `conflict-store.test.ts:310` (post-bail-out-flag review needed first — see flags above)

### Phase 4 Group 4 — `.sync-bak` migration ✅ (algorithm; migration follow-on)

**RED tests to land:**
- N8: `.sync-bak naming algorithm: stem.ext, hidden files, extensionless, multi-dot names`
- N9: `AtomicWriteRecovery.sweep SHA-verify: matches → finalize Step 3; mismatch → drop`
- N17: extend `tests/mock-obsidian-platform.test.ts` to exercise `.sync-bak` flow through ConflictStore.create

**Existing tests to REWRITE in same commit:**
- `conflict-store.test.ts:173` (sibling-content.bin → `.sync-bak` flow)

### Phase 4 Group 5 — ConflictWatcher → counter-only ✅

**RED tests to land (new file `tests/sync2/conflict-counter.test.ts`):**
- N1: `ConflictCounter.markDirty + getValue: recompute happens once per dirty window`
- N2: `ConflictCounter.subscribe: callback fires only on changed value, debounced`
- N3: `ConflictCounter.flush: forces immediate recompute, bypasses microtask`
- N4: `Counter formula edge cases: missing base, !exists sibling, SHA cache stale`
- N18: `Counter live-recomputes on bulk vault.on events (5 events → 1 recompute)`

**Existing tests to DELETE in same commit (all in `conflict-watcher.test.ts`):**
- Lines 104, 121, 146 (`handle()` evaluation triggers)
- Lines 171, 205 (`pause`/`resume`/`isPaused`)
- Lines 219, 252 (chain serialization, re-check relevance)
- Line 329 (end-to-end record resolution from listener)
- Line 373 (onError chain — pending bail-out-flag review)

**Existing tests to REWRITE:**
- Lines 279, 301, 314 (`start`/`stop` listener registration — same shape, callback target changes)
- Line 346 (rename event dual-path check — markDirty target)

**Bail-out flag resolved here:** `conflict-watcher.test.ts:373` (onError) decided before delete. If counter recompute can throw, add a small replacement test for that.

### Phase 4 Group 6 — Drain wiring (drop drain-end sweep, add guard) ✅

**RED tests to land:**
- (Mostly integration coverage — many existing tests already exercise drain implicitly)

**Existing integration tests to REWRITE:**
- `conflicts/branch-lifecycle.test.ts:71` (per bail-out flag — drain-mediated vs direct classifier)
- `conflicts/edit-while-in-conflict.test.ts:70` (synthetic batch routing under Stage 13)

**Existing tests to DELETE:**
- `conflicts/watcher-realtime.test.ts:73, 145` (both — listener no longer mutates store, no pause/resume)

### Phase 4 Group 7 — Filesystem-orphan dedup at create() ✅

**RED test to land:**
- N11: `ConflictStore.create: filesystem-orphan adoption — scan parent dir, adopt matching SHA orphan`

No existing tests touched.

### Phase 4 Group 8 — GitignoreInvariants always-write ✅

**RED test to land:**
- N15: `GitignoreInvariants.enforce: drops mtime/hash short-circuit, always reads+splices+compares`

Existing `gitignore-invariants.test.ts` likely needs minor REWRITE if it asserted on short-circuit behavior — check during Phase 3.

### Phase 4 Group 9 — Commit-template removal (biggest scope)

**RED test to land:**
- N16: `Commit messages: hardcoded "sync ({deviceLabel})" / "resolve conflict ({deviceLabel})" — no template substitution`

**Existing tests to DELETE:**
- All `tests/sync2/commit-templates.test.ts` content (the entire file)

**Existing tests to REWRITE:**
- `push-queue.test.ts` parts that assert on commit message format
- Integration tests that check commit messages on GitHub (L1, L4 — may need REWRITE per `accumulateOfflineSyncs` audit)

### Phase 4 Group 10 — Visibility 4→3 point

**RED test to land:**
- (No new test — UI change, settings tab badge removed)

**Existing tests to DELETE/REWRITE:**
- Any `tests/sync2/conflict-status-bar.test.ts` parts asserting on settings-tab badge
- Settings UI tests

### Workflow + lifecycle tests (cross-cutting)

These NEW tests aren't tied to a single Phase 4 group — they exercise
the integrated behavior after multiple groups land. Best landed near
the end of Phase 4 (after groups 1-6):

- N13: `delete-base-then-rename-sibling workflow under MOCK_PLATFORM=mobile` (Category B+E)
- N14: `pull-side new-sibling that matches base coincidentally → next drain Phase A auto-cleans` (Category C)

### Priority + sequencing summary

**Critical path** (must land first, blocks the rest):
1. Group 1 (Foundation: enqueueSynthetic + synthetic field) — block #6
2. Group 5 (ConflictCounter) — block #6 status-bar wiring
3. Group 2 (Classifier 2-phase) — block #6 drain Phase B synthesis

**Independent** (can land in parallel with critical path):
- Group 3 (load drop auto-restore)
- Group 7 (filesystem-orphan dedup)
- Group 8 (GitignoreInvariants)

**Final** (require multiple predecessors):
- Group 4 (`.sync-bak` migration) — touches recovery + create() flows
- Group 6 (Drain wiring) — needs Groups 1, 2, 5 GREEN first
- Group 9 (Commit-template removal) — biggest scope, save for last
- Group 10 (visibility 4→3) — UI cleanup, last

**Workflow tests** N13, N14 — written during Phase 3 but only land
GREEN after Groups 1-6 complete.

### Expected Phase 3 commit shape

~7-10 commits, one per Phase 4 group, each shipping just the RED
tests (failing) for that group. Order:

1. **commit: RED tests for Group 1** — N5, N6, N7
2. **commit: RED tests for Group 5** (counter) — N1, N2, N3, N4, N18 + ConflictCounter test file
3. **commit: RED tests for Group 2** (classifier) — N12 + planned rewrites scaffolded
4. **commit: RED tests for Group 3** — N10
5. **commit: RED tests for Group 4** (`.sync-bak`) — N8, N9, N17
6. **commit: RED tests for Groups 6+ + workflow/lifecycle** — N13, N14, branch-lifecycle scaffold
7. **commit: RED tests for Groups 7, 8** — N11, N15
8. **commit: RED tests for Groups 9, 10** — N16 + delete-template-tests scaffold

Each commit's tests fail with "Not implemented" against Phase 1.7
stubs OR fail with assertion mismatch against current 2.0.0-beta code.

### Effort estimate

- Total RED test writing: ~18 NEW tests + ~15 REWRITE existing
- Estimated wall-clock: 6-8 hours focused work
- Expected test count after Phase 3: ~104 RED + ~75 KEEP (passing) +
  ~17 DELETED = ~196 tests total (vs current 510 — note the count
  reflects only conflict-related; existing 510 includes unit suite
  for other modules)

---

## Future enhancements (out of scope for stage 1)

Ідеї, що з'явилися під час обговорення pseudo-merge mode, **але не
включені у stage 1**. Зафіксовані тут, щоб не загубились. Можна
імплементувати окремими PR'ами після того, як pseudo-merge приземлиться.

### Throttled push mode ("псевдо-offline")

**Сценарій:** користувач з активним vault'ом не хоче спамити GitHub
десятками commits на годину. Хоче "throttle" — push раз на N хвилин.

**Запропоноване рішення:** перевизначити семантику комбінації toggles,
що вже існують у 2.0.0-beta:

- `syncStrategy = "interval"` + `Sync interval = N min`
- `autoCommitOnSync = true`
- `accumulateOfflineSyncs = true`

Тоді:
- Manual [Sync] click → **тільки commit** (findChanges + enqueueOrMerge),
  push не відбувається
- Interval tick кожні N хв → push накопичений batch
- 10 manual clicks за 5 хв → 1 batch на диску (через accumulate) → 1 push

**Trade-offs:**
- ✅ Радикально менше GitHub API hits
- ✅ Чистіша commit history (один commit per N min замість один per click)
- ✅ Природна синергія existing toggles
- ⚠ UX delay: "Sync done" не з'явиться до наступного тіка
- ⚠ Семантичний shift: зараз `autoCommitOnSync` явно "governs only
  automatic surfaces"; перевизначення впливатиме на manual click теж
- ⚠ L1-L4 інтеграційні тести потребують перегляду (вони assume
  "manual = immediate push")

### Окрема Drain action — самостійна цінність

**Основний сценарій (mobile-first):** користувач на мобільному
телефоні редагує vault через cellular зв'язок. Хоче **зберігати
проміжні версії** (preserve-all-commits принцип) — натискає Commit
часто. Але **не хоче пушити через мобільний інтернет** (data
charges + battery + поганий зв'язок). Натискає Drain руками тоді,
коли з'явиться WiFi або повернеться додому.

**Менш критичні сценарії:**
- Throttled push mode override ("now I've batched enough, push it now")
- Дебаг: користувач хоче зрозуміти, що саме push'неться перед фактичним
  push'ем (можна додати "preview" опцію в Drain action)
- Manual control при flaky connection — не хочеться що автоматичний
  drain timer пробував push в момент коли merega нестабільна

**Запропоноване рішення:** розщепити поточну `Sync with GitHub`
команду на дві:

- `Commit changes` — тільки enqueue (findChanges + батч на диск, без
  network operations)
- `Drain (push + pull)` — тільки мережеві операції (existing drain без
  попереднього findChanges)

Stage 1 keeps the unified `Sync with GitHub` (legacy compatibility з
існуючими L-тестами); нові команди — additive, не replace.

**Mobile UX value:**

Цей feature **не потребує** throttled push mode як передумови — він
має самостійну цінність на mobile. Поведінка:
- Manual Commit: миттєвий, без network → no data charge → no battery hit
- Manual Drain: коли user сам обере (WiFi, домашня мережа тощо)
- Preserve-all-commits принцип зберігається бо кожен Commit click = окремий batch

Combined з throttled push (якщо колись landed) — повний "псевдо-offline"
workflow. Але самостійно теж дає mobile users важливий control.

---

## Open questions (empirical, не дизайн)

Перевірити при імплементації — НЕ блокують поточний дизайн:

1. ✅ **`createTree` з `sha: null` для видалення файлу** — **answered**:
   вже в проді через `tree-builder.ts:173`, покрите D2-D8 інтеграційними
   тестами. Працює.
2. ✅ **`DELETE /git/refs/heads/<name>` після створення merge-commit
   що посилається на branch.head** — **answered**: empirical scratch
   test (`tests/integration/scratch/deleteref-after-merge-gc.test.ts`)
   підтверджує що GitHub дотримується стандартної git-reachability:
   branch commit лишається fetchable за SHA після `deleteRef` доки
   існує об'єкт що його references. У продакшен-послідовності
   `createCommit(merge) → updateRef main → deleteRef branch` гарантує
   що main reaches branch.head через merge-commit's second parent.
3. ✅ **Performance gitBlobSha cache** — **answered**: per-record
   `(mtime, size)` watermark як спроектовано (Stage 3) — достатньо.
   Жодного глобального bucketing не потрібно. Benchmark
   `tests/perf/p5-classifier-sweep.test.ts` (macOS desktop):

   | N    | Cache hit | Cache miss |
   |------|-----------|------------|
   | 100  | 104 ms    | 119 ms     |
   | 500  | 502 ms    | 586 ms     |
   | 1000 | 1046 ms   | 1172 ms    |

   Лінійне ~1 ms/record. Mobile очікую ×3-5; для типового N=10-30
   user load — <250ms навіть на найповільніших пристроях. Drain-start
   sweep вкладається в latency budget.

   Спостереження: cache-miss всього на ~10-12% повільніше за cache-hit
   бо `updateCache` пише meta.json через atomic tmp+rename на КОЖНОМУ
   record (для `lastEvaluated` bump), що домінує над read+hash вартість.
   Future micro-optimization: пропускати `updateCache` коли тільки
   `lastEvaluated` змінюється, або batching `lastEvaluated` updates у
   in-memory map з periodic flush. Не блокує Stage 9 — окрема стадія.
---

## Implementation outline

Реалізація — послідовна одна-фазна:

1. ✅ **Прибрати custom commit messages** (API + 2 команди + L2/L3 тести +
   `isolated` cleanup) — Stage 1 landed
2. ✅ **ConflictStore schema rewrite + persistence** (multi-sibling, kind
   field, mtime/size cache, atomic write protocol, crash-resistant
   load, dedup за `(vaultPath, theirsBlobSha)`) — Stage 2 landed
3. ✅ **`evaluateConflictState()` algorithm** — unified 7-row classifier,
   per-kind handling, mtime cache — Stage 3 landed
4. ✅ **ConflictWatcher** — vault event listener + fast-path Set check + delegate to `evaluateConflictState()` — Stage 4 landed
5. ✅ **Conflict detection rebuild** — pull-side and push-side entry points,
   обидва пробують auto-merge (text 3-way / plugin-js semver), невдача
   → register conflict, обидва наповнюють shared ConflictStore — Stage 5 landed
6. ✅ **Видалити `resolveBinaryConflict`** — binary тепер register as
   conflict (no silent atomic mtime) — landed з Stage 5 cutover
7. ✅ **Split-push у processBatch** (β) + branch lifecycle — Stage 7 landed
   - ✅ 7a: branch ops primitives + state + naming
   - ✅ 7b: pushConflictPathsToBranch + eager-create + finalize on drain end
   - ✅ 7c: edit-while-in-conflict — processBatch partition routes in-conflict paths to branch; `dropPendingConflictPaths` removed
   - per-half `.main-pushed` marker deferred (unnecessary in current eager-per-registration model — no main/branch ordering gap)
8. ✅ **Branch operations** — create, push (з rebase forward), finalize merge, deleteRef — landed together with stage 7 (primitives in 7a, wire-up in 7b); covered end-to-end by `conflicts/branch-lifecycle.test.ts`
9. ✅ **Drain wraps** (Stage 9 — supersededby Stage 13): originally landed з pause/resume ConflictWatcher + drain-start + drain-end sweeps. **Stage 13 спрощує:** drain wraps до drain-start only (з guard `if records > 0`); no pause/resume (listeners тепер read-only counter); no drain-end sweep. Phase 4 рефакторить існуючу wiring per Stage 13.
10. ✅ **~~4-point~~ 3-point visibility warnings** (status bar + pre-sync modal + ribbon) — Stage 10 landed з 4-точковим scope; Stage 13 revision drops settings tab badge (Phase 4 cleanup).
11. ✅ **Видалити старий conflict-resolution code** — Stage 11 landed; всі залишкові згадки `ConflictModal`/`ConflictView`/`onConflict`/`OnConflictCallback`/`cascadeDeferRemoval`/`resolveBinaryConflict`/`resolvePluginJsConflict`/`MergeResult`/`ConflictResolution`/`merge-into-one` прибрані з коду, коментарів і тестових описів; old 2.0.0-beta stage labels (6.5/6.6/6a/6c/6d) перейменовано в descriptive фрази
12. ✅ **Integration tests M/N/O/P/Q/R series** — coverage exists across the existing conflicts/, conflicts-misc/, and multi-device/ buckets (renamed/rewritten in earlier stages rather than created in a fresh M-R prefix series). Mapping:

    | Series | Concern                                                         | Test files                                                                                                                                                                                                                                                                                                                                                                                              |
    |--------|-----------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
    | **M**  | Branch lifecycle (create / push / merge / deleteRef)            | `conflicts/branch-lifecycle.test.ts`                                                                                                                                                                                                                                                                                                                                                                    |
    | **N**  | Split-push (plain paths → main, conflict paths → branch)        | `conflicts/edit-while-in-conflict.test.ts`, `conflicts/pending-conflict-blocks-push.test.ts`                                                                                                                                                                                                                                                                                                            |
    | **O**  | Resolution detection (classifier + watcher)                     | `conflicts/defer-then-resolve-via-sibling-delete.test.ts` (!sibling → accept-ours), `conflicts/multi-copy-pair-resolution.test.ts` (multi-sibling), `conflicts/watcher-realtime.test.ts` (event-driven), `conflicts/classifier-case6-accept-theirs.test.ts` (siblingSha == baseSha → accept-theirs) |
    | **P**  | Multi-device under pseudo-merge                                 | `multi-device/G1-three-device-rotation.test.ts`, `multi-device/G2-same-file-disjoint-edits.test.ts` (auto-merge clean), `multi-device/G3-same-line-conflict.test.ts`, `multi-device/G4-binary-atomic-across-devices.test.ts` (binary register-conflict)                                                                                                                                                  |
    | **Q**  | Recovery sweeps                                                 | `conflicts-misc/E1-reconcile-onload.test.ts` (onload reconcile); 3-step atomic crash recovery has unit coverage only (`tests/sync2/conflict-store.test.ts`) — integration with a real GitHub round-trip + mid-flight crash is impractical to set up reliably                                                                                                                                            |
    | **R**  | Auto-merge attempt (binary register-conflict, plugin-js atomic, modify-vs-delete modify-wins) | `conflicts-misc/E2-binary-conflict-atomic.test.ts` (binary registers, doesn't silently atomic), `conflicts-misc/E3-plugin-js-semver.test.ts` (semver winner), `conflicts-misc/E4-plugin-js-same-version-mtime.test.ts` (mtime tiebreak), `incremental/D7-same-file-local-modify-remote-delete.test.ts` (modify-vs-delete → local-modify wins, file resurrects on remote) |
13. **Stage 13 architectural pivot — DOC ONLY** (2026-05-22): цей документ
    переписаний для drain-start-only resolution + counter-only listeners +
    vault-level `*.sync-bak*` staging + 2-фазний classifier. Жодних code
    змін у цьому stage — лише canonical model для Phase 2-4.
14. **Stage 13 implementation** (Phase 3 RED + Phase 4 GREEN):
    - RED tests demonstrating bugs:
      - `delete sibling + re-load: record drops, sibling stays gone`
      - `classifier !baseExists + modify-vs-modify: noop` (not cascade)
      - `ConflictStore.create with orphan sibling matching theirsBlobSha: adopt orphan`
      - `GitignoreInvariants.enforce: canonical block update applies after upgrade`
      - integration: `delete-base-then-rename-sibling on mobile workflow`
    - GREEN fixes:
      - ConflictWatcher.handle → counter.refresh() only (drop evaluateConflictState call)
      - evaluateConflictState refactor to 2-phase (Phase A + Phase B)
      - drain wraps: drop drain-end sweep, keep drain-start with guard
      - onload: do NOT call evaluateConflictState
      - ConflictStore.create: use `*.sync-bak*` flow via atomicWriteFile
      - ConflictStore.load: do NOT auto-restore sibling from backup
      - ConflictStore.create: filesystem-orphan adoption
      - classifier row 3 → noop
      - GitignoreInvariants.enforce: drop mtime/hash short-circuits
      - AtomicWriteRecovery: SHA-verify `*.sync-bak*` against record.theirsBlobSha
      - **Decision #36 — commit-template removal:**
        - delete `src/sync2/commit-templates.ts`
        - delete `tests/sync2/commit-templates.test.ts`
        - remove `settings.commitTemplate*` fields + settings UI section
        - delete `PushQueue.updateCommitMessage` + callers
        - remove `meta.json.commitMessage` field, derive inline
        - add `meta.json.synthetic: boolean` field
        - extend `mergeIntoLatestPending` to skip `synthetic: true`
        - add `PushQueue.enqueueSynthetic` API
        - update all callsites that build commit messages to use hardcoded formats
      - test migration per Phase 2 audit table
15. **Cleanup IMPLEMENTATION_PLAN.md** — прибрати все, що суперечить цьому документу, але важливо для реалізації UI/UX частини для diff-edit (stage 2)
16. **CLAUDE.md + README.md update** — нова conflict resolution секція


## Reliability — ✅ socket-level error retry (resolved)

Initial observation: integration прогон бачив `UND_ERR_SOCKET` /
`SocketError: other side closed` flake від undici (transient TCP
drop посеред операції з GitHub REST). `retryUntil` ретрайтив тільки
по HTTP status кодах; throw-side path не покривався → socket errors
вискакували без retry.

**Fix landed**:
- `src/utils.ts` → `isRetriableError(err)` predicate: walks
  cause-chain (depth 5), recognises undici / Node net / Electron
  net error codes + message heuristic.
- `retryUntil` ловить throws, classifies, retries з тією ж
  exponential backoff (1s → 2s → 4s → 8s → 16s) що й HTTP-status
  retry.
- 44 unit tests (`tests/utils.test.ts`).
- Integration test (`api-failures/socket-error-retry.test.ts`)
  через `RequestFaultInjector` синтезує undici-shape throw, asserts
  sync recovers.
- `vitest.integration.config.ts` → `retry: 1` як safety net (на
  випадок GitHub regional outage > 31s).
