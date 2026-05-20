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
> Diff2 — це UI/UX шар **поверх** механізму описаного тут. Усе що в
> IMPLEMENTATION_PLAN.md суперечить цьому документу — застаріле і
> підлягає видаленню. Цей документ має пріоритет.

---

## 🔴 Що змінюється для користувача

> **Єдиний user-visible removal з 2.0.0-beta:** прибираються
> **manual commit messages**. Команди `Sync with GitHub (custom
> message)…` і `Sync current file with GitHub (custom message)…` —
> зникають. Лишаються 2 з 4 команд: `Sync with GitHub` і
> `Sync current file with GitHub`. Усі коміти — мають тільки автоматичні
> назви (commit messages), які генеруються за template з settings.
>
> **Решта нової pseudo-merge функціональності — "під капотом":**
> conflict-branch на GitHub, event listener для resolution, нові
> sibling-файли при multi-device конфліктах. Користувач бачить
> лише результат — конфлікти стало простіше резолювати, кожен файл
> з конфліктом має чітку приватну зону, інші пристрої не отримують
> сирий конфлікт поки користувач явно не вирішить.

**Архітектурна цінність:** уся резолюція конфліктів — через стандартні
Obsidian примітиви (delete / rename / edit файлів). Жодного
плагінного модального вікна, ніяких confirmations. Diff2 (майбутній)
буде pure UX-надбудовою — show diff, quick-action buttons,
multi-sibling navigation — нічого з цього не критичне для механізму.

---

## Що зберігається з 2.0.0-beta (commit/batch layer)

Існуючий COMMIT-BATCH механізм — багатий і стабільний (закріплений 18
unit-spec файлами + 65 інтеграційними тестами A1–L4). Усе що в ньому
є — **залишається**:

- `.attempted` marker
- `accumulateOfflineSyncs` toggle
- довільне число batches у черзі
- `syncFile(path)` команда (без custom message)
- `{filename}` / `{path}` placeholders у commit templates
- L1, L4 інтеграційні тести

**Видаляється** як наслідок removal manual messages:

- API: `syncAll(customMessage?)` → `syncAll()`; `syncFile(path, customMessage?)` → `syncFile(path)`
- 2 з 4 Obsidian команд (`(custom message)` варіанти)
- `EnqueueMeta.isolated` — повністю видаляється (verified: в версії 2.0.0-beta .isolated ставиться
  ВИКЛЮЧНО з `customMessage !== undefined` у sync2-manager.ts:419/494;
  без customMessage truly dead code; no backwards compat → можемо
  безпечно прибрати з типу, серіалізації, всіх читачів)
- L2 + L3 інтеграційні тести (custom-message сценарії)

---

## Що повністю переписується (conflict layer)

Алгоритми resolve-конфліктів з 2.0.0-beta — переглядаємо критично і
**замінюємо новими** з огляду на pseudo-merge model:

- `applyRemoteAddOrModify` (pull-side conflict path)
- `reconcileBatchAgainstHead` Case 4 (push-side conflict path)
- `cascadeDeferRemoval`
- `ConflictModal` (модальне вікно per-file під час sync) — прибирається
- `ConflictStore` — суттєво розширюється
- `ConflictView` (sync2-conflict-view) — повністю видаляється. Новий diff-edit UI буде створено на стадії 2 (Diff2) (окремий шар)

Нова реалізація — згідно з цим документом, з нуля, з фокусом на
**продуктивність, ясність, передбачуваність і тестованість**.

---

## Mental model для користувача

> **Файл у конфлікті — це твоя приватна копія, з якою ти можеш робити
> що завгодно. Поки конфлікт не вирішено, інші пристрої її не бачать.
> Усе решта синхронізується нормально. Готовий — видаляєш sibling-файл,
> і твій варіант з'являється у всіх (при наступному [Sync]).**

---

## Архітектурний поділ

| Шар | Модель | Тригери |
|---|---|---|
| **Sync engine** (push/pull, findChanges, push-queue) | Polling — як у 2.0.0-beta | [Sync] click, interval tick, onload `resumeQueue` |
| **Conflict resolution detection** | Event-driven | `vault.on('delete' \| 'modify' \| 'rename')`, drain-start sweep, onload sweep |
| **Conflict push to remote** | Polling (через існуючий sync engine) | Resolved-state потрапляє у main лише на наступному [Sync] |

Це **явний виняток** з CLAUDE.md's "engine does NOT register vault
events" — те правило стосувалось sync engine 2.0.0-beta. Conflict layer
— окремий subsystem, він має право реєструвати events.

---

## Архітектура push: split-push у processBatch (β)

**Drain pauses ConflictWatcher event processing** під час batch
pipeline, щоб mid-drain vault events (від наших sibling write'ів) не
перетворювали uniform processing в interleaved auto-resolve cycles.

**Важливо:** pause не означає "queue events" — Obsidian events не
буферизуються; якщо обробник пасивний, події фактично втрачаються.
Натомість на drain-end робимо **comprehensive sweep** — re-evaluation
ConflictStore vs actual vault file system state. Це механізм
ідентичний onload sweep і drain-start sweep. Він catches **усе** що
відбулося під час drain (і наші sibling writes, і user mid-drain
actions), бо читає фінальний file system state, а не послідовність
подій.

```
drain():
  pause ConflictWatcher event processing                   ← НОВЕ
  
  0. drain-start sweep (ПЕРЕД pull):
     re-evaluate ConflictStore vs vault file system state.
     Catches changes since previous drain end (включно з onload window).
     Якщо path виходить з inConflictFiles → synthesize side-batch;
     він обробиться у цьому ж drain циклі.
  1. pull main (як зараз — у drain top через pullIfNeeded)
  
  for each batch in queue:
    processBatch(batch)  ← деталі нижче
  
  N. drain-end sweep                                       ← НОВЕ
     re-evaluate ConflictStore vs vault file system state (той самий
     механізм як drain-start sweep). Catches:
       - наші drain-triggered sibling writes
       - user's mid-drain actions (delete sibling, edit base, rename)
     Якщо resolution → cleanup state + synthesize side-batches.
  
  process side-batches (loop until none new)
  
  if branch exists AND inConflictFiles is empty:
    push vault.live[path] as marker commit на branch (preserves A(local))
    finalize merge (createCommit з parents=[main.head, branch.head])
    deleteRef branch
  
  resume ConflictWatcher event processing                  ← НОВЕ
```

Один [Sync] click → один drain → uniform processing.

### processBatch (виконується для кожного batch у drain)

```
2. partition batch.files за поточним станом inConflictFiles:
   conflictPaths = batch.files ∩ inConflictFiles
   plainPaths    = batch.files − inConflictFiles
3. push plainPaths → main (існуючий push flow без змін)
   - reconcile case 4 (push-side detected конфлікт): A_i ≠ remote
     → перевести path у новий conflict flow (step 4)
4. ЯКЩО виявлено новий конфлікт (pull-side АБО push-side):
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
   - write sibling-файл у vault: <path>.conflict-from-<remote-device>-<ts>.<ext>
     ← vault.on('create') fires, але ConflictWatcher paused → event queued
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

## Conflict detection — два entry points → один state

**Pull-side (drain step 1, pullIfNeeded):**
- pull виявляє remote зміни на файлі який локально модифікований І ще
  не в `inConflictFiles`
- додає path у `inConflictFiles`
- зберігає theirsBlobSha у ConflictStore
- sibling-файл write'иться у vault (на наступному push step branch
  створюється)

**Push-side (drain step 3-4, processBatch):**
- після pull, перед push, дивимось хто з batch.files має SHA-divergence
  vs expectedHead
- для таких — той самий flow: додати в `inConflictFiles`, ConflictStore,
  sibling-файл, push до branch

Обидва entry points наповнюють **один і той самий state** —
`inConflictFiles` + ConflictStore + sibling-файли у vault. ConflictWatcher
і processBatch просто **читають** цей state — їм байдуже хто додав.

---

## Edit-while-in-conflict

Користувач **може продовжувати редагувати** файл після того як він
потрапив у конфлікт. Механіка:

1. Користувач edits a.md → mtime змінюється у vault
2. На наступному [Sync] click `findChanges` бачить a.md як modified
   (стандартний flow з 2.0.0-beta)
3. `enqueueOrMerge` додає a.md у batch
4. `processBatch` бачить що a.md ∈ inConflictFiles → routed до
   conflict-branch (не main), step 5 архітектури

Інші пристрої НЕ бачать цих правок поки конфлікт не вирішено.

---

## pullIfNeeded для in-conflict paths

Pull завжди йде з main. Якщо remote main отримав нову версію файла
який вже в `inConflictFiles`:

- Локальний base-файл НЕ перезаписується (це наша приватна копія)
- Існуючі sibling-файли НЕ перезаписуються
- Створюється **новий** sibling-файл з новою remote-версією:
  `a.conflict-from-<other-remote-device>-<ts>.md`
- `ConflictStore.create(vaultPath, theirsBlobSha)` — дедуп за
  `(vaultPath, theirsBlobSha)` гарантує що ідентична remote-версія не
  створює дубль siblings; нова → новий sibling
- `lastSyncCommitSha` просувається нормально (інші файли pull-нулись)

Path може мати **N siblings** з різних пристроїв. Користувач муситиме
резолювати **кожен** перед закриттям конфлікту.

---

## Resolution detection — event-driven

ConflictWatcher слухає vault events:

```ts
plugin.registerEvent(vault.on('delete', handleConflictEvent))
plugin.registerEvent(vault.on('modify', handleConflictEvent))
plugin.registerEvent(vault.on('rename', handleConflictEvent))

handleConflictEvent(file):
  affected = inConflictFiles ∩ {file.path, parent(file.path)}
  + paths whose registered siblings include file.path
  for path in affected:
    evaluateResolutionFor(path)
```

`evaluateResolutionFor(path)` — 3 кейси (rename/copy auto-collapse):

```
baseExists = vault.adapter.exists(basePath)
siblings   = list існуючих siblings цього path

! baseExists                          → кейс 3 (delete-wins)
baseExists, всі siblings зникли       → кейс 1 (accept base)
baseExists, є sibling із SHA(sibling) == SHA(base)
                                       → кейс 4 (accept that variant)
жодне з вище                          → no-op
```

**Resolution фіксується в conflict-store одразу** (real-time, в event
handler). Перейменування / видалення / редагування → store оновлюється.
**Push до main відбувається на наступному [Sync] click** (option A) —
узгоджено з polling-моделлю sync engine'у.

**ВИНЯТОК — drain pause/resume:** під час drain ConflictWatcher
**paused** (events ігноруються, не queue'яться — це Obsidian behavior).
На drain-end робиться **comprehensive sweep** замість "process queued
events": re-evaluate ConflictStore vs actual vault file system state
(той самий механізм як drain-start sweep і onload sweep). Sweep
catches **усе** що сталось під час drain (наші sibling writes, user's
mid-drain actions, race conditions) — бо читає фінальний file system
state, не послідовність подій.

Resolutions fire **у тому ж drain**. Synthesized side-batches
обробляються у тому ж drain. Finalize теж у тому ж drain якщо
conditions met. Коли user уже сконвергував vault до remote ДО [Sync]
click — finalize відбувається у поточному drain, **без чекання
наступного [Sync]**.

### Дії при кожному кейсі (виконуються в event handler real-time)

**Принцип:** resolution живе на двох рівнях — **per-sibling** (book-keeping)
і **per-path** (push до main). Push відбувається лише коли path
**повністю виходить з `inConflictFiles`** (усі його siblings резолвлено).

| Кейс | Real-time state update (event handler) | Що піде до main на наступному [Sync] |
|---|---|---|
| 1 (sibling deleted) | Видалити ConflictStore record для того sibling. **ЯКЩО це був останній sibling для path** → прибрати path з inConflictFiles | (Тільки якщо path вийшов з inConflictFiles): push base content до main + remove path з branch tree |
| 3 (base deleted) | Прибрати path з inConflictFiles; видалити всі ConflictStore records для path; видалити всі sibling-файли локально | push delete до main + remove path з branch tree |
| 4 (SHA match) | Видалити **той** sibling-файл і **той** ConflictStore record що SHA-збігся. **ЯКЩО це був останній sibling для path** → еквівалентно кейсу 1 | Тільки якщо path вийшов з inConflictFiles: те саме що в кейсі 1 |

**Multi-sibling consequence:** якщо path має N siblings, перші N-1
resolutions (через кейс 1 або 4) — це лише book-keeping, ніяких
push'ів. Push до main + remove from branch tree триггериться **N-ю
(останньою)** resolution. Між тим, edits до base-файла продовжують йти
на branch (як edit-while-in-conflict), бо path ще в inConflictFiles.

Це означає: для multi-sibling path користувач **мусить резолюнути ВСІ
siblings** перед тим як його варіант з'явиться у main. Кожен sibling —
окремий "залишковий конфлікт".

**Асиметрія кейсу 3 із multi-sibling:** delete base **каскадно**
видаляє всі siblings одним рухом (бо user явно сказав "цей файл мені
не цікавий"). На відміну від кейсу 4 де кожен sibling треба резолюнути
окремо. Це expected — "trust user actions" принцип; delete base — це
"ядерна" відмова від усього пов'язаного з цим path-ом.

### gitBlobSha caching

Для performance: `gitBlobSha(path)` кешується за ключем `(path, mtime, size)`.
При detection-проході — спочатку перевірка `mtime + size`; якщо ключ
збігся з кешем — SHA не перерахуємо. Інакше — рахуємо і кешуємо. Це
критично для onload sweep на великому vault'і.

### Три trigger points (різна push semantics!)

1. **vault events** (real-time у running session) — основний шлях.
   State update real-time; push до main чекає на наступний [Sync]
   click (option A).
2. **drain-start sweep** — на початку кожного `drain()` пробігти по
   `inConflictFiles` і re-evaluate. **Якщо знаходить resolution що
   виводить path з `inConflictFiles` → synthesize a batch у тому ж
   drain і обробляє його в поточному циклі.** Push до main відбувається
   у цьому ж drain — це і є той самий [Sync] click що його запустив.
3. **onload sweep** — catch-up для змін поки Obsidian був закритий
   (events не ретроактивні). **Тільки state update; push чекає на
   наступний [Sync] click** (drain ще не запущений на onload).

### Orphan cleanup в onload sweep

Симетричні перевірки:
- Кожен ConflictStore record → перевірити що sibling-файл існує на
  диску. Якщо ні — record orphan, видалити з store, прибрати path з
  inConflictFiles якщо нема інших records для нього.
- Кожен `*.conflict-from-*` файл у vault → перевірити що є record у
  store. Якщо ні — sibling orphan, видалити з vault.

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

## Edge case: live vault сконвергував до remote — uniform handling

**Сценарій:** queue має batches з версіями A1 → A2 → A3 файлу `a.md`,
remote надсилає R1 → R2. Користувач у певний момент часу "приводить"
vault до R2 (через manual edit, copy-paste, інший плагін, тощо).

**Дизайн принцип:** жодних спеціальних шляхів. Drain обробляє всі
batches **uniformly** (з ConflictWatcher на паузі). Resolution
відбувається коли vault == sibling (case 4) — однаково незалежно від
того **коли** користувач сконвергував.

### Case A: vault converged ДО [Sync] click (vault == R2 від старту drain)

1. Pull: SHA(vault=R2) == SHA(main=R2) → no pull-side конфлікт
2. **batch1**: reconcile case 4 → A1 ≠ R2 → push-side detected
   конфлікт. Push A1 на branch (X1). Write sibling=R2. ConflictStore.create.
   inConflictFiles=["a.md"]. **vault.on('create') queued.**
3. **batch2**: a.md ∈ inConflictFiles → step 5 (edit-while-in-conflict).
   Push A2 на branch (X2). Без нового sibling/record.
4. **batch3**: те саме. Push A3 (X3).
5. **Drain-end resume ConflictWatcher**: queued event processed.
   evaluateResolutionFor: SHA(vault=R2) == SHA(sibling=R2) → **case 4
   fires** → cleanup: sibling deleted, record removed, path leaves
   inConflictFiles.
6. **Check finalize**: branch exists + inConflictFiles=[] →
   - push vault.live(=R2) на branch як marker commit (X4)
   - createCommit(parents=[main.head, branch.head], tree=main.tree)
   - deleteRef branch

**Branch lineage:** X1(A1) → X2(A2) → X3(A3) → X4(R2)
**Main:** ... → merge-commit (з двома parents)
**Result:** усі 4 версії reachable. main content unchanged (R2). **Усе
у поточному drain — без чекання наступного [Sync].**

### Case B: vault converged ПІСЛЯ [Sync] click (vault=A3 при старті drain)

Це типовий випадок — користувач натиснув [Sync], vault ще не
сконвергований.

1. Pull: SHA(vault=A3) ≠ SHA(main=R2) → pull-side конфлікт. Step 4 у processBatch fires (eager branch creation).
2. **batch1**: a.md ∈ inConflictFiles → step 5. Push A1 на branch (X1).
3. **batch2, batch3**: те саме. Branch: X1, X2, X3.
4. **Drain-end resume ConflictWatcher**: vault.a.md=A3, sibling=R2 →
   SHA mismatch → **case 4 НЕ fires**. Конфлікт persists.
5. **Стан після drain**: vault=A3, sibling=R2 у vault, branch=X1+X2+X3,
   inConflictFiles=["a.md"], ConflictStore record active.
6. **Користувач пізніше** редагує vault.a.md → R2 (або копіює sibling →
   base, або видаляє sibling). vault.on(...) fires real-time (поза
   drain → ConflictWatcher active) → case 4/1 fires → cleanup state.
7. **Наступний [Sync]**: drain-start sweep знаходить inConflictFiles=[]
   + branch exists → finalize triggered (marker commit + merge + deleteRef).

**Кінцевий стан identical до Case A.** Лише timing finalize різний.

### Чому це працює уніформно

- Drain обробляє batches однаково в обох випадках (push до branch).
- ConflictWatcher paused → жодних mid-drain auto-resolves що могли б
  розщепити pipeline.
- Resolution fires коли vault == sibling — це fundamental SHA-match
  condition, що не залежить від часу.
- Finalize triggers коли inConflictFiles=[] + branch exists —
  однаково в обох випадках.

### Що це дає для `accumulateOfflineSyncs` контракту

- **OFF** (default): user explicitly opt-in в preserve-all-iterations.
  Усі batches → окремі commits на branch (A1, A2, A3) + marker
  (A(local=R2)) + merge-commit. Повна історія "user's thought
  iterations" зберігається на GitHub.
- **ON**: queue має лише latest batch (A3 only — інші absorbed).
  Branch отримує тільки A3 + marker. Меньша історія — за explicit user
  choice "I accept losing intermediates".

**Жодних дополнительних optimizations** — поведінка природньо лягає
на existing toggle. Stage 1 не додає special-case shortcuts.

---

## 4-точкове попередження користувачу

Файли в конфлікті — **invisible to other devices**:

1. **Status bar** (постійно): `🔀 3 files — not visible on other devices`
2. **Pre-Sync modal**: `"N file(s) still in conflict. [resolve] [sync anyway]"`
   — виходить **перед кожним sync** поки список не порожній
3. **Settings tab**: badge у заголовку + секція "Pending conflicts" над "Danger zone"
4. **Ribbon icon**: subtle badge з кількістю

---

## Стан per-device

У `<configDir>/plugins/.../metadata.json` (через SnapshotStore;
`migrate()` defensive coercion обробляє відсутність поля):

```json
{
  "conflictBranch": {
    "name": "easy-sync-conflicts-Phone-20260520143022",
    "head": "<sha>",
    "inConflictFiles": ["a.md", "notes/b.md"]
  }
}
```

`conflictBranch: null` — нема активного branch.

---

## Recovery sweeps

### A. Звірка локального `conflictBranch` state з GitHub (onload)

| Локальний state | Branch на GitHub | Дія |
|---|---|---|
| є, inConflictFiles непорожнє | є | OK (нічого) |
| є, inConflictFiles непорожнє | нема | відновити branch на current main HEAD + перепушити локальні версії conflict-files |
| є, inConflictFiles порожнє | є | finalize (manual merge + delete) |
| є, inConflictFiles порожнє | нема | merge уже зроблений, лише локальний state не очищено → почистити |
| crash між merge-commit і deleteRef | є, але branch.tree досягається з main через merge | видалити branch |
| нема | є з нашою назвою | orphan від попередньої сесії — нічого не робити |
| нема | нема | OK |

### B. ConflictStore catch-up з file-system state (onload + drain-start)

Для кожного path у inConflictFiles + кожного `*.conflict-from-*` у
vault — виконати ту саму classification (3 кейси + orphan checks).
Якщо щось спрацьовує — застосувати resolution дії (state-update
real-time; push чекає на [Sync]).

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
**фундаментальний distributed-edit-conflict**, не баг плагіна. Той
самий resolution UX повторюється.

**2. Atomicity per [Sync] — давно немає.**

Один click може розщепитися: частина файлів → main, частина → branch.
Так само як `git pull --rebase` дробить локальні commits на patch'і.

**3. Branch завжди приватний — не shareable.**

Інший пристрій не може "допомогти вирішити" ваш конфлікт.

**4. Orphan branches лишаються forever.**

Якщо пристрій A мав branch і зник (плагін видалили / переустановили) —
його branch лишається на GitHub без власника. Ніхто не чистить
автоматично. Користувач може видалити вручну через GitHub UI.

---

## Branch naming

```
easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>
```

Приклад: `easy-sync-conflicts-Phone-20260520143022`

- Префікс `easy-sync-conflicts-` → `listReferences("refs/heads/easy-sync-conflicts-*")`
- `<deviceLabel>` → alphabetical grouping
- `<timestamp>` → chronological order; orphan branches з минулих
  run'ів видно "ага, оцей з січня"

---

## GitHub REST API mechanics

| Операція | Endpoint | Нюанси |
|---|---|---|
| Create branch | `POST /repos/:o/:r/git/refs` | body: `{ref: "refs/heads/<name>", sha: <base>}` |
| Push commit | `createTree` + `createCommit` + `updateRef` | стандартний flow з 2.0.0-beta |
| Remove file from tree | `POST /repos/:o/:r/git/trees` з `base_tree` + entries | entry **повна форма**: `{path, mode: "100644", type: "blob", sha: null}` — усі 4 поля обов'язкові |
| Finalize merge (manual) | `createCommit` | body: `{message, tree, parents: [<main.head>, <branch.head>]}` — ми контролюємо tree |
| Delete branch | `DELETE /repos/:o/:r/git/refs/heads/:branch` | 204 на успіх; 422 якщо ref не існує |
| List our branches | `GET /repos/:o/:r/git/matching-refs/heads/easy-sync-conflicts-` | для recovery sweep |

Усі endpoints — звичайні REST, працюють на mobile WebView.

---

## Decisions made

| # | Рішення | Контекст |
|---|---|---|
| 1 | Manual commit messages прибираються — єдиний user-visible removal | API + 2 з 4 команд |
| 2 | Решта 2.0.0-beta commit/batch layer — без змін (`.attempted`, `accumulateOfflineSyncs`, syncFile, `{filename}`/`{path}` — все живе) | minimal-additive scope для batch layer |
| 3 | `EnqueueMeta.isolated` повністю видаляється — verified dead code після removal customMessage | no backwards compat needed |
| 4 | Conflict resolution layer переписується з нуля (старі алгоритми не успадковуються) | критично переглянути 2.0.0-beta conflict path |
| 5 | Split-push на рівні `processBatch` (variant β) | один batch → до 2 push-секвенцій |
| 6 | Branch tree завжди rebase'иться вперед: `base_tree = current main.tree + override conflict files` | уникає staleness через тижні |
| 7 | Per-half marker `.main-pushed` для crash-safety split-push retry | recovery-aware multi-step disk op |
| 8 | Conflict detection — два entry points (pull-side + push-side) → один shared state (inConflictFiles + ConflictStore) | uniform downstream consumption |
| 9 | Branch створюється **eagerly** у drain при першому conflict detection (не lazy) | гарантує persistent backup стану на момент конфлікту |
| 10 | Resolution detection — event-driven через `vault.on(…)`, окремий шар від sync engine | bypass polling для миттєвого state update |
| 11 | Resolution push timing — **option A**: state-update real-time, push до main на наступному [Sync] click | узгоджено з polling sync model |
| 12 | Drain-start sweep + onload sweep — додаткові entry points до event listener | catches race conditions + missed events |
| 13 | `gitBlobSha(path)` кешується за `(path, mtime, size)` | performance для onload sweep |
| 14 | Orphan cleanup симетричний: ConflictStore.load() + sibling-without-record cleanup | uniform invariants |
| 15 | Resolution має 3 кейси (rename/copy auto-collapse у кейси 1 і 4) | trust user actions, no special detection |
| 16 | pullIfNeeded для in-conflict paths → новий sibling (multi-sibling шлях) | path може мати N siblings з різних devices |
| 17 | Multi-sibling кейс 4: резолвиться тільки той sibling що збігся, інші лишаються | path в inConflictFiles до резолюції всіх |
| 18 | `lastSyncCommitSha` після finalize → advance на merge-commit | стандартна git-семантика |
| 19 | Conflict-branch naming: `easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>` | grouping + chronological |
| 20 | Edit-while-in-conflict дозволено; edits route до branch у processBatch | стандартний batch flow |
| 21 | 4-point visibility warning (status bar + pre-sync modal КОЖЕН раз + settings + ribbon) | соціальний тиск на резолюцію |
| 22 | Reset → `*.conflict-*` перейменовуються на `<file>.unresolved-<original-ts>.<ext>` | clean slate без знищення user files |
| 23 | Orphan branches не чистяться автоматично — лишаються forever | "висить і висить, їсти не просить" |
| 24 | Backwards-compat не потрібний (sole user) | no migration code |
| 25 | Diff2 — pure UX layer поверх цього механізму; усі резолюції доступні через Obsidian-нативні файлові операції | clear architectural separation |

---

## Test plan (high-level)

Інтеграційні тести (нові серії, branch-per-test на int-test repo):

**M-series: Conflict-branch lifecycle**
- M1: create branch on first conflict detected (eager)
- M2: branch tree rebases forward after main moves
- M3: finalize merge + deleteRef (happy path)
- M4: recovery — crash between merge-commit and deleteRef

**N-series: Split-push**
- N1: батч з тільки plain files → один push до main
- N2: батч з тільки conflict files → один push до branch
- N3: батч mixed → два пуші
- N4: split-push retry — main pushed, branch failed → marker present → retry skips main
- N5: edit-while-in-conflict — нова версія йде до branch

**O-series: Resolution detection (3 cases)**
- O1: sibling deleted → case 1 → state update real-time, push at next [Sync]
- O2: base deleted → case 3 → state update + siblings auto-deleted
- O3: SHA match → case 4 → state update for matching sibling only
- O4: rename sibling over base → auto-collapses to case 1
- O5: multi-sibling: matching one keeps others in conflict

**P-series: Multi-device**
- P1: pull creates new sibling for in-conflict path (multi-sibling)
- P2: ping-pong scenario — A and B independently resolve same file
- P3: dedup — identical remote version doesn't create duplicate sibling

**Q-series: Recovery sweeps**
- Q1: onload sweep with deleted sibling (case 1 fires retroactively)
- Q2: onload sweep with orphan sibling (no ConflictStore record)
- Q3: onload sweep with orphan record (no sibling on disk)
- Q4: branch state mismatch — local has, remote gone → recreate
- Q5: branch state mismatch — local empty, remote has → finalize

Unit tests — point-coverage для:
- `ConflictWatcher` event handler
- `evaluateResolutionFor` 3-case classifier
- `gitBlobSha` cache invalidation
- split-push partition logic
- per-half marker handling

---

## Future enhancements (out of scope for stage 1)

Ідеї що з'явились під час обговорення pseudo-merge mode, **але не
включені у stage 1**. Зафіксовані тут щоб не загубились. Можна
імплементувати окремими PR'ами після того як pseudo-merge приземлиться.

### Throttled push mode ("псевдо-offline")

**Сценарій:** користувач з активним vault'ом не хоче спамити GitHub
десятками commits на годину. Хоче "throttle" — push раз на N хвилин.

**Запропоноване рішення:** перевизначити семантику комбінації toggles
що уже існують у 2.0.0-beta:

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
- ✅ Чистіша commit history (1 commit per N min замість 1 per click)
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
- Дебаг: користувач хоче зрозуміти що саме push'неться перед фактичним
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
- Manual Drain: коли user сам обере (WiFi, домашня мережа, тощо)
- Preserve-all-commits принцип зберігається бо кожен Commit click = окремий batch

Combined з throttled push (якщо колись landed) — повний "псевдо-offline"
workflow. Але самостійно теж дає mobile users важливий control.

---

## Open questions (empirical, не дизайн)

Перевірити при імплементації — НЕ блокують поточний дизайн:

1. **`createTree` з `sha: null` для видалення файла** — задокументовано
   у GitHub REST, реальні звіти змішані. Scratch-тест проти int-test
   repo. Якщо не працює — fallback: `createTree` без `base_tree`, з
   повним списком entries без видаленого файла.
2. **`DELETE /git/refs/heads/<name>` після створення merge-commit що
   посилається на branch.head** — merge-commit має branch.head як
   parent, тому object reachable. Перевірити що GitHub не GC'ить
   commit після deleteRef.
3. **Performance gitBlobSha cache** — підібрати правильні бакети `(path,
   mtime, size)` для очікуваного N=100-1000 in-conflict files.

---

## Implementation outline

Реалізація — послідовна одна-фазна:

1. **Прибрати custom commit messages** (API + 2 команди + L2/L3 тести +
   `isolated` cleanup)
2. **`inConflictFiles` + ConflictStore extensions** (multi-sibling, дедуп,
   orphan cleanup, gitBlobSha cache)
3. **ConflictWatcher** — vault event listener + drain-start sweep + onload sweep
4. **Conflict detection** — pull-side + push-side entry points, обидва
   наповнюють shared state
5. **Split-push у processBatch** (β) + per-half marker + branch lifecycle
6. **Branch operations** — create, push (з rebase forward), finalize merge, deleteRef
7. **Recovery sweeps** (onload state + ConflictStore catch-up)
8. **4-point visibility warnings** (status bar + pre-sync modal + settings + ribbon)
9. **Видалити старий conflict-resolution code** (applyRemoteAddOrModify, reconcileBatchAgainstHead Case 4, ConflictModal, cascadeDeferRemoval)
10. **CLAUDE.md + README.md update** — нова conflict resolution секція
11. **Integration tests M/N/O/P/Q series**
12. **Cleanup IMPLEMENTATION_PLAN.md** — прибрати все що суперечить цьому документу
