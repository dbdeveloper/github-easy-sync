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

---

## 🔴 Що змінюється для користувача

> **Єдиний user-visible removal з 2.0.0-beta:** прибираються
> **manual commit messages**. Команди `Sync with GitHub (custom
> message)…` і `Sync current file with GitHub (custom message)…` —
> зникають. Лишаються 2 з 4 команд: `Sync with GitHub` і
> `Sync current file with GitHub`. Усі коміти мають тільки автоматичні
> назви (commit messages), які генеруються за template з settings.
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

---

## Що зберігається з 2.0.0-beta (commit/batch layer)

Наявний COMMIT-BATCH механізм — багатий і стабільний (закріплений 18
unit-spec файлами + 65 інтеграційними тестами A1–L4). Усе, що в ньому
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
  field (modify-vs-modify / delete-vs-modify / modify-vs-delete),
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

| Шар                                                  | Модель                               | Тригери                                                                       |
|------------------------------------------------------|--------------------------------------|-------------------------------------------------------------------------------|
| **Sync engine** (push/pull, findChanges, push-queue) | Polling — як у 2.0.0-beta            | [Sync] click, interval tick, onload `resumeQueue`                             |
| **Conflict resolution detection**                    | Event-driven                         | `vault.on('delete' \| 'modify' \| 'rename')`, drain-start sweep, onload sweep |
| **Conflict push to remote**                          | Polling (через існуючий sync engine) | Resolved-state потрапляє у main лише на наступному [Sync]                     |

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
  
  0. drain-start sweep:                                    ← НОВЕ
     evaluateConflictState() — full scan.
     Catches drift that ConflictWatcher missed:
       - external mods (iCloud/Dropbox/file manager) where vault.on
         may not fire reliably (особливо на mobile background)
       - plugin toggled off→on mid-session (events not registered window)
       - OS-level file-watcher edge cases на mobile suspension
     ConflictStore — authoritative source; sweep verifies state
     проти actual vault file system. Якщо resolution → cleanup state
     + synthesize side-batches; вони обробляться у цьому ж drain.
  1. pull main (як зараз — у drain top через pullIfNeeded)
  
  for each batch in queue:
    processBatch(batch)  ← деталі нижче
  
  N. drain-end sweep                                       ← НОВЕ
     evaluateConflictState() — full scan.
     Catches:
       - наші drain-triggered sibling writes (events ignored mid-drain)
       - user's mid-drain actions (delete sibling, edit base, rename)
     Якщо resolution → cleanup state + synthesize side-batches.
  
  process side-batches (loop until none new)
  
  if branch exists AND inConflictFiles is empty:
    push vault.live[path] as marker commit на branch (preserves A(local))
    finalize merge (createCommit з parents=[main.head, branch.head])
    deleteRef branch
  
  resume ConflictWatcher event processing                  ← НОВЕ
```

**Чому є і drain-start, і drain-end sweep:** ConflictWatcher real-time
покриває **outside drain** vault events, але має blind spots
(external mods, mobile suspension, plugin toggle off→on). Drain-start
sweep — safety net що catches цей drift перед operations що залежать
від accurate state. Drain-end sweep — для drain-internal pause window.
Onload sweep не потрібен окремо: перший drain (sync on startup,
manual click) АБО перший UI op якщо callsite викликає
`evaluateConflictState()` — закриває onload window.

Один [Sync] click → один drain → uniform processing.

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

**ConflictStore — single source of truth** для всіх конфліктів. Всі
рішення про state (in-conflict, resolved, kind, etc.) робляться через
читання цього store. Файли поза store (orphan `*.conflict-from-*`
створені externally) — ignored by design.

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
- **Sibling backup:** raw bytes у `<configDir>/plugins/.../.conflicts/<recordId>/sibling-content.bin`
  — staging area + permanent backup (відновлення якщо vault sibling
  стерто externally)
- **Defensive coercion on load:** як `SnapshotStore.migrate()` —
  missing fields, unknown values default safely; corrupted records
  logged and skipped (не ламають plugin load).
- **Invariant після recovery sweep:** state on disk — або fully
  completed update, або fully rolled back, ніколи half-applied
  (principle #9).

### 3-step atomic create protocol

`ConflictStore.create(vaultPath, theirsContent, theirsBlobSha, kind, …)`
— створення конфлікту вимагає двох disk-ops (write sibling + write
record). Order має значення для crash-recovery. **record-first**
обраний бо self-heals via classifier case 1 при crash між кроками.
3-step протокол:

```
recordId = uuid()
recordDir = <configDir>/plugins/.../.conflicts/<recordId>/
finalSiblingPath = "<vaultPath>.conflict-from-<dev>-<ts>.<ext>"
  (з ".deleted" suffix якщо kind=modify-vs-delete)

Step 1: stage sibling content до recordDir (temp/backup location)
  mkdir recordDir
  write recordDir/sibling-content.bin = theirsContent (raw bytes;
                                                       0 bytes якщо .deleted)
  fsync

Step 2: atomic write record meta.json
  write recordDir/meta.json.tmp = JSON.stringify(record)
  fsync
  rename meta.json.tmp → meta.json  (atomic via OS-level rename)

Step 3: copy sibling до final vault location
  vault.adapter.write(finalSiblingPath, content)
  fsync
  # sibling-content.bin лишається у recordDir як backup
```

### Recovery sweep на onload (per crash window)

| Crash після                                        | На диску                                                                              | Recovery action                                                                                                                  |
|----------------------------------------------------|---------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| Step 1 (мід-stage)                                 | recordDir exists, meta.json відсутній (rename не дійшов)                              | `rmdir recordDir` (orphan staging); конфлікт буде re-detected при наступному pull/reconcile через classifier                     |
| Step 2 завершено, Step 3 не виконано               | recordDir/meta.json + sibling-content.bin exist; `finalSiblingPath` на vault не існує | read meta.json + sibling-content.bin → `vault.adapter.write(finalSiblingPath, content)` → re-stat + update record cache fields   |
| Step 3 завершено, потім зовнішнє видалення sibling | meta.json + sibling-content.bin exist; finalSiblingPath видалений externally          | classifier `evaluateConflictState`: siblingExists=false → case 1 (accept ours) → cleanup record. Self-heals through normal flow. |

**Inv:** після recovery sweep, для будь-якого ConflictRecord — або
sibling на disk у finalSiblingPath + record consistent з cache, або
record прибраний.

### Record schema

Кожен record персистентно зберігає **всю інформацію щоб resume
resolution flow після crash**:

```ts
interface ConflictRecord {
  id: string;                    // unique record id
  vaultPath: string;             // "Folder/note.md"
  kind: "modify-vs-modify" | "delete-vs-modify" | "modify-vs-delete";

  // --- Immutable identity (set at create, never updated) ---
  oursBlobSha: string | null;    // null for kind=delete-vs-modify (ours was "delete")
  theirsBlobSha: string | null;  // null for kind=modify-vs-delete (theirs was "delete")
  remoteDevice: string;          // "Phone", "Laptop", ...
  createdAt: number;

  // --- Sibling location + content cache ---
  siblingPath: string;
  // modify-vs-modify / delete-vs-modify → "Folder/note.conflict-from-Phone-<ts>.md"
  // modify-vs-delete                    → "Folder/note.conflict-from-Phone-<ts>.md.deleted" (0 bytes)
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
- `theirsBlobSha` — immutable identity для **dedup**: `ConflictStore.create(vaultPath, theirsBlobSha)` skips, якщо вже є record із цим ключем. Це гарантує, що однакова remote-версія не створює дубль siblings.
- `siblingSha` — current cached SHA. Класифікатор завжди використовує **siblingSha** (current), не theirsBlobSha (historical). Це дозволяє user-edited sibling правильно flow через case 4 (accept that variant).

**Поля, що відображають kind:**

| `kind`             | `oursBlobSha`        | `baseMtime/Size`                             | Sibling content                            | Початковий vault state                                                                   |
|--------------------|----------------------|----------------------------------------------|--------------------------------------------|------------------------------------------------------------------------------------------|
| `modify-vs-modify` | SHA нашої версії     | mtime/size base-файлу при створенні conflict | theirs (remote) content                    | base exists with ours; sibling exists with theirs                                        |
| `delete-vs-modify` | `null` (ми видалили) | `null` (base не існує)                       | theirs (remote) content                    | base absent; sibling exists with theirs                                                  |
| `modify-vs-delete` | SHA нашої версії     | mtime/size base-файлу                        | **0-byte placeholder з `.deleted` suffix** | base exists with ours; sibling = `<file>.conflict-from-<dev>-<ts>.<ext>.deleted` (empty) |

**Sibling representation для `modify-vs-delete`:**

Placeholder файл `<file>.conflict-from-<dev>-<ts>.<ext>.deleted` з
розміром **0 байт**. Це візуально розрізняє "remote видалив цей файл"
від звичайних content-siblings (у file-explorer suffix `.deleted` явно
говорить що це). User options:
- **Видалити `.deleted` sibling** → accept ours (зберегти local
  модифіковану версію, ignore remote delete)
- **Видалити base-файл** → accept theirs (propagate the delete до main).
  `.deleted` sibling потім auto-cleaned як частина resolution.
- Rename `.deleted` → base path не має сенсу (створив би 0-byte base),
  тому не подовжуємо UX інструкції тут.

**`.deleted` pattern у gitignore:** `*.conflict-from-*` уже catches
обидва варіанти (з суфіксом `.deleted` і без — wildcard покриває). Просто
переконатись що `GitignoreInvariants.CONFIG_DIR_SEED` / `ROOT_SEED` має
це правило (як у 2.0.0-beta). **Не потрібно окремого правила для
`.deleted`** — поточна wildcard pattern достатня. Зафіксувати в
implementation: при init поточних invariants перевірити що
`*.conflict-from-*` теж catches `.deleted` варіант (test case).

### Dedup

Identical `(vaultPath, theirsBlobSha)` дедуплікується — якщо запис уже
існує для цього path і remote content, ще один не створюється. Це
зберігає поведінку 2.0.0-beta.

---

## Unified state evaluation — `evaluateConflictState()`

**Один algorithm, чотири trigger points.** Source of truth — ConflictStore
records. Algorithm читає файлову систему щоб виявити що змінилось з
останнього viкоnання.

```
evaluateConflictState():
  for each record in ConflictStore (≤ ~30 entries, scale ≤ 10 conflicts):
    classify record:                       ← per record per evaluation
      based on kind, baseExists, siblingExists, SHA matches
    if classification → resolution action:
      apply state changes (atomically persist)
      синтезувати side-batch для main push (якщо потрібно)
    update record.lastEvaluated, persist
```

### Класифікатор (gener'ний — працює для всіх kinds)

Дивиться на поточний vault state + ConflictStore record:

```
baseExists = vault.adapter.exists(record.vaultPath)
siblingExists = vault.adapter.exists(record.siblingPath)
baseSha = baseExists ? hashFile(record.vaultPath) : null  ← mtime cache hit → skip
siblingSha = siblingExists ? hashFile(record.siblingPath) : null
```

**Резолюції (uniform за kinds).** Класифікатор використовує **current
cached** SHA: `siblingSha` (= `record.siblingSha`), `baseSha`
(= `record.baseSha`). НЕ використовує immutable `record.theirsBlobSha`
(що зберігається тільки для dedup).

| Стан                                                                                                                          | Семантика                                                                                                       | Resolution action                                                                                                               |
|-------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------|
| !siblingExists, kind=`modify-vs-modify` чи `delete-vs-modify`                                                                 | user видалив content sibling — accept ours                                                                      | Прибрати record. Якщо для path більше records немає → propagate ours (base content АБО deletion) до main + remove from branch   |
| !siblingExists, kind=`modify-vs-delete`                                                                                       | user видалив `.deleted` placeholder — accept ours (keep local modified)                                         | Прибрати record. Якщо для path більше records немає → propagate base content до main                                            |
| siblingExists, !baseExists, kind=`modify-vs-modify`                                                                           | user видалив base — delete-wins                                                                                 | Прибрати всі records для path. Видалити всі siblings локально. Propagate delete до main + remove from branch                    |
| siblingExists, !baseExists, kind=`modify-vs-delete`                                                                           | user видалив base — accept theirs (confirm remote deletion)                                                     | Прибрати record + .deleted sibling. Якщо для path більше records немає → propagate delete до main                               |
| siblingExists, !baseExists, kind=`delete-vs-modify`                                                                           | початковий стан, user ще не вирішив                                                                             | No-op                                                                                                                           |
| siblingExists, baseExists, `baseSha == siblingSha`, kind=`modify-vs-modify` чи `delete-vs-modify`                             | user скопіював sibling content до base (copy-паст чи rename) — accept that variant                              | Видалити sibling + record. Якщо останній — propagate baseSha content до main                                                    |
| siblingExists, baseExists, `baseSha ≠ siblingSha`, kind=`delete-vs-modify`                                                    | user створив base manually (custom resolution)                                                                  | No-op поки siblings не зникнуть (user сигналізує completion через delete-sibling)                                               |
| siblingExists, baseExists, `baseSha ≠ siblingSha`, `baseSha ≠ record.oursBlobSha`, kind=`modify-vs-modify`                    | user редагує base (ще не збігся ні з ours ні з sibling)                                                         | No-op                                                                                                                           |
| siblingExists, baseExists, `baseSha == record.oursBlobSha`, kind=`modify-vs-modify`                                           | base незмінений (= ours), sibling ще там — initial state                                                        | No-op                                                                                                                           |
| siblingExists (= `.deleted` placeholder), baseExists, `baseSha == record.oursBlobSha`, kind=`modify-vs-delete`                | initial state                                                                                                   | No-op                                                                                                                           |
| siblingExists (= `.deleted` placeholder), baseExists, `baseSize == 0`, kind=`modify-vs-delete`                                | **Intentional**: user стер всі дані з base маючи `.deleted` sibling. Сильний "yes I get it, delete this" signal | Прибрати record + `.deleted` sibling. Якщо для path більше records немає → propagate delete до main + remove path з branch tree |
| siblingExists (= `.deleted` placeholder), baseExists, `baseSha ≠ record.oursBlobSha`, `baseSize > 0`, kind=`modify-vs-delete` | user edits base (still rejecting remote delete)                                                                 | No-op                                                                                                                           |

**Чому `baseSha == siblingSha` замість `baseSha == record.theirsBlobSha`:**
дозволяє user-edited sibling правильно тригерити case 4. Сценарій:
sibling був R2, user його відредагував до X, скопіював X у base. Тепер
`baseSha == siblingSha == X` → case 4 fires, accept X. Якщо порівнювали б
з immutable theirsBlobSha = R2, цей варіант би НЕ спрацював і конфлікт
застряг би.

### Trigger points

| Trigger                            | Що викликає                                      | Behavior                                                                                                                                           |
|------------------------------------|--------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| **drain-start**                    | Початок drain (перед pull)                       | `evaluateConflictState()` full scan                                                                                                                |
| **drain-end**                      | Після всіх batches, перед resume ConflictWatcher | `evaluateConflictState()` full scan                                                                                                                |
| **UI op** на conflict-related view | diff2 open, status-bar click, settings tab open  | `evaluateConflictState()` full scan                                                                                                                |
| **vault.on(modify/delete/rename)** | Real-time outside drain                          | Fast-path Set check: `path ∈ siblingPaths-Set ∨ path ∈ inConflictFiles-Set`. Hit → `evaluateConflictState()` full scan. Miss → return (99% events) |

**Усе** — той самий sync algorithm. ≤ 30 records при типовому scale → full scan <50ms.

### Mtime + size cache (findChanges-style watermark pattern)

Той самий pattern що `change-detector.ts` у 2.0.0-beta для vault scan.
Кожен record несе `siblingMtime + siblingSize` (і `baseMtime + baseSize`).

При evaluation **per record**:

```
stat = vault.adapter.stat(record.siblingPath)  ← cheap syscall
if !stat:
  siblingExists = false
  # record.siblingSha stays as last-known (or no longer relevant —
  # record прибирається класифікатором)
elif stat.mtime == record.siblingMtime AND stat.size == record.siblingSize:
  # Cache hit — no read/hash needed
  siblingExists = true
  siblingSha = record.siblingSha  ← directly from persisted cache
else:
  # mtime/size touched → must read content
  siblingExists = true
  content = read(record.siblingPath)
  siblingSha = computeSha(content)
  
  # Refresh ALL three cached fields together (mtime, size, sha)
  record.siblingMtime = stat.mtime
  record.siblingSize = stat.size
  record.siblingSha  = siblingSha  ← keep current SHA in record
  persist record  ← atomic write (per ConflictStore persistence contract)
```

Same pattern для `baseMtime` + `baseSize` + `baseSha`. Якщо після
read+SHA нова `siblingSha == record.siblingSha` (попередня cached) —
значить файл був "touched" без content change (e.g., OS bumped mtime).
mtime/size cache оновлюється, sha unchanged in record, no resolution
trigger. Якщо `siblingSha ≠ record.siblingSha` — user реально щось
відредагував → класифікатор вирішує наступну дію через current SHA.

### Immutable identity vs current content

Один ключовий нюанс:

- **`record.theirsBlobSha`** — **immutable identity** SHA remote content
  на момент створення конфлікту. Використовується для **dedup** при
  `ConflictStore.create` (`(vaultPath, theirsBlobSha)` key). НЕ міняється
  після створення record-а.
- **`siblingSha`** — поточний SHA sibling-файла, computed at evaluation
  time (з cache коли можливо).

Класифікатор використовує **current `siblingSha`**, не immutable
`theirsBlobSha`. Це важливо тому що user **може** edit sibling content
вручну (типовий приклад: спершу глянути що там, потім поправити перед
прийняттям). Якщо порівнювати з immutable theirsBlobSha — user's edits
до sibling ігнорувались би. З поточним siblingSha — case 4 (accept
theirs) спрацює коли user скопіює *поточний* sibling content до base.

### Performance budget

При типовому usage (більшість записів — cache hit) eval вкладається в
кілька мс. Cold start (всі mtime потрібно перевірити з диска) — ≤30 stat
calls + кілька read+hash = ~50ms навіть на mobile.

### Multi-sibling consequence

Якщо path має N siblings, кожна `siblingExists` check ітерується по
всіх records цього path. Resolution на одного sibling — це per-record
operation. Path "закривається", коли ВСІ records для нього прибрані
(усі siblings зникли чи всі резолвилися).

`modify-vs-modify` кейс "base deleted" — **каскадно** прибирає всі
records цього path. На відміну від інших кейсів, де треба зробити по
кожному sibling. Це expected ("trust user actions" — delete base = "цей
файл мені не цікавий").

### Drain pause/resume context

Під час drain ConflictWatcher **paused** (events ігноруються — це
Obsidian behavior, не queueing). Drain-start і drain-end **обидва**
викликають evaluateConflictState — це catches **усе** що сталось:
наші sibling writes, user mid-drain actions, race conditions, external
mods. Sweep читає **фінальний file system state**, не послідовність
подій.

Resolutions fire **у тому ж drain**. Synthesized side-batches
обробляються у тому ж drain. Finalize теж у тому ж drain, якщо
conditions met. Коли user уже сконвергував vault до remote ДО [Sync]
click — finalize відбувається у поточному drain, **без чекання
наступного [Sync]**.

### Три trigger points (різна push semantics!)

1. **vault events** (real-time у running session) — основний шлях.
   State update real-time; push до main чекає на наступний [Sync]
   click (option A).
2. **drain-start sweep** — на початку кожного `drain()` пробігти по
   `inConflictFiles` і re-evaluate. **Якщо знаходить resolution що
   виводить path з `inConflictFiles` → synthesize a batch у тому ж
   drain і обробляє його в поточному циклі.** Push до main відбувається
   у цьому ж drain — це і є той самий [Sync] click, що його запустив.
3. **onload sweep** — catch-up для змін поки Obsidian був закритий
   (events не ретроактивні). **Тільки state update; push чекає на
   наступний [Sync] click** (drain ще не запущений на onload).

### Orphan cleanup в onload sweep

Симетричні перевірки:
- Кожен ConflictStore record → перевірити, що sibling-файл існує на
  диску. Якщо ні — record orphan, видалити з store, прибрати path з
  inConflictFiles, якщо нема інших records для нього.
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

1. Pull: `SHA(vault=R2)` == `SHA(main=R2)` → no pull-side конфлікт
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

1. Pull: `SHA(vault=A3)` ≠ `SHA(main=R2)` → pull-side конфлікт. Step 4 у processBatch fires (eager branch creation).
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
- Resolution fires, коли vault == sibling — це fundamental SHA-match
  condition, що не залежить від часу.
- Finalize triggers, коли inConflictFiles=[] + branch exists —
  однаково в обох випадках.

### Що це дає для `accumulateOfflineSyncs` контракту

- **OFF** (default): user explicitly opt-in в preserve-all-iterations.
  Усі batches → окремі commits на branch (`A1`, `A2`, `A3`) + marker
  (`A(local=R2)`) + merge-commit. Повна історія "user's thought
  iterations" зберігається на GitHub.
- **ON**: queue має лише latest batch (`A3` only — інші absorbed).
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

| #  | Рішення                                                                                                                             | Контекст                                             |
|----|-------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------|
| 1  | Manual commit messages прибираються — єдиний user-visible removal                                                                   | API + 2 з 4 команд                                   |
| 2  | Решта 2.0.0-beta commit/batch layer — без змін (`.attempted`, `accumulateOfflineSyncs`, syncFile, `{filename}`/`{path}` — все живе) | minimal-additive scope для batch layer               |
| 3  | `EnqueueMeta.isolated` повністю видаляється — verified dead code після removal customMessage                                        | no backwards compat needed                           |
| 4  | Conflict resolution layer переписується з нуля (старі алгоритми не успадковуються)                                                  | критично переглянути 2.0.0-beta conflict path        |
| 5  | Split-push на рівні `processBatch` (variant β)                                                                                      | один batch → до 2 push-секвенцій                     |
| 6  | Branch tree завжди rebase'иться вперед: `base_tree = current main.tree + override conflict files`                                   | уникає staleness через тижні                         |
| 7  | Per-half marker `.main-pushed` для crash-safety split-push retry                                                                    | recovery-aware multi-step disk op                    |
| 8  | Conflict detection — два entry points (pull-side + push-side) → один shared state (inConflictFiles + ConflictStore)                 | uniform downstream consumption                       |
| 9  | Branch створюється **eagerly** у drain при першому conflict detection (не lazy)                                                     | гарантує persistent backup стану на момент конфлікту |
| 10 | Resolution detection — event-driven через `vault.on(…)`, окремий шар від sync engine                                                | bypass polling для миттєвого state update            |
| 11 | Resolution push timing — **option A**: state-update real-time, push до main на наступному [Sync] click                              | узгоджено з polling sync model                       |
| 12 | Drain-start sweep + onload sweep — додаткові entry points до event listener                                                         | catches race conditions + missed events              |
| 13 | `gitBlobSha(path)` кешується за `(path, mtime, size)`                                                                               | performance для onload sweep                         |
| 14 | Orphan cleanup симетричний: ConflictStore.load() + sibling-without-record cleanup                                                   | uniform invariants                                   |
| 15 | Resolution має 3 кейси (rename/copy auto-collapse у кейси 1 і 4)                                                                    | trust user actions, no special detection             |
| 16 | pullIfNeeded для in-conflict paths → новий sibling (multi-sibling шлях)                                                             | path може мати N siblings з різних devices           |
| 17 | Multi-sibling кейс 4: резолвиться тільки той sibling що збігся, інші лишаються                                                      | path в inConflictFiles до резолюції всіх             |
| 18 | `lastSyncCommitSha` після finalize → advance на merge-commit                                                                        | стандартна git-семантика                             |
| 19 | Conflict-branch naming: `easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>`                                                  | grouping + chronological                             |
| 20 | Edit-while-in-conflict дозволено; edits route до branch у processBatch                                                              | стандартний batch flow                               |
| 21 | 4-point visibility warning (status bar + pre-sync modal КОЖЕН раз + settings + ribbon)                                              | соціальний тиск на резолюцію                         |
| 22 | Reset → `*.conflict-*` перейменовуються на `<file>.unresolved-<original-ts>.<ext>`                                                  | clean slate без знищення user files                  |
| 23 | Orphan branches не чистяться автоматично — лишаються forever                                                                        | "висить і висить, їсти не просить"                   |
| 24 | Backwards-compat не потрібний (sole user)                                                                                           | no migration code                                    |
| 25 | Diff2 — pure UX layer поверх цього механізму; усі резолюції доступні через Obsidian-нативні файлові операції                        | clear architectural separation                       |

---

## Test plan (high-level)

Інтеграційні тести (нові серії, branch-per-test на int-test repo):

**M-series: Conflict-branch lifecycle**
- M1: create branch on first conflict detected (eager)
- M2: branch tree rebases forward after main moves
- M3: finalize merge + deleteRef (happy path)
- M4: recovery — crash between merge-commit and deleteRef

**N-series: Split-push**
- N1: батч із тільки plain files → один push до main
- N2: батч із тільки conflict files → один push до branch
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
- P1: pull creates a new sibling for in-conflict path (multi-sibling)
- P2: ping-pong scenario — A and B independently resolve same file
- P3: dedup — identical remote version doesn't create duplicate sibling

**Q-series: Recovery sweeps**
- Q1: onload sweep with deleted sibling (case 1 fires retroactively)
- Q2: onload sweep with orphan sibling (no ConflictStore record) → ignored by-default
- Q3: onload sweep with orphan record (no sibling on disk)
- Q4: branch state mismatch — local has, remote gone → recreate
- Q5: branch state mismatch — local empty, remote has → finalize

**R-series: Auto-merge attempt**
- R1: text 3-way merge clean → push merged до main (not registered as conflict)
- R2: text 3-way merge marker'd → register as conflict (branch and sibling)
- R3: plugin-js semver higher version wins → atomic apply (E3 ported)
- R4: plugin-js same version and mtime delta → tie-break wins (E4 ported)
- R5: plugin-js identical version and identical mtime → register as conflict (new edge)
- **R6 (replaces E2)**: binary modified both sides → **register as conflict** (sibling pattern), NOT atomic mtime. User resolves via file ops.
- **R7 (replaces G4)**: binary across two devices → same — register as conflict, no silent picking.

**Existing 2.0.0-beta tests — fate:**
- E1 (reconcile-onload) — переглянути, частково valid
- E2 (binary atomic) — **delete** (replaced by R6)
- E3 (plugin-js semver) — ported as R3
- E4 (plugin-js same-version mtime) — ported as R4, R5 added
- G4 (binary atomic across devices) — **delete** (replaced by R7)

Unit tests — point-coverage для:
- `ConflictWatcher` event handler (fast-path Set check)
- `evaluateConflictState` 3-case classifier (per-kind paths)
- ConflictStore atomic write (crash mid-write recovery)
- ConflictStore record schema validation (defensive coercion on load)
- mtime+size cache invalidation
- split-push partition logic
- per-half marker handling
- Auto-merge attempt branching (text 3-way / plugin-js semver / binary skip)

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
3. ⏳ **Performance gitBlobSha cache** — підібрати правильні бакети
   `(path, mtime, size)` для очікуваного N=100-1000 in-conflict files.
   Стане актуально на Stage 9 (drain-start sweep) — поточний classifier
   sweep не має кешу.

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
   - ✅ 7c: edit-while-in-conflict — processBatch partition routes
     in-conflict paths to branch; `dropPendingConflictPaths` removed
   - per-half `.main-pushed` marker deferred (unnecessary in current
     eager-per-registration model — no main/branch ordering gap)
8. **Branch operations** — create, push (з rebase forward), finalize merge, deleteRef
9. **Drain wraps**: pause ConflictWatcher → drain-start sweep → batches → drain-end sweep → finalize check → resume
10. **4-point visibility warnings** (status bar + pre-sync modal + settings + ribbon)
11. **Видалити старий conflict-resolution code** (`applyRemoteAddOrModify` rewrite, `reconcileBatchAgainstHead` Case 4 rewrite, `ConflictModal`, `onConflict` callback, `cascadeDeferRemoval`, `resolveBinaryConflict`, `ConflictView`)
12. **CLAUDE.md + README.md update** — нова conflict resolution секція
13. **Integration tests M/N/O/P/Q/R series**: M (branch lifecycle), N (split-push), O (resolution detection), P (multi-device), Q (recovery sweeps), R (auto-merge attempt; replaces E2/G4 for binary)
14. **Cleanup IMPLEMENTATION_PLAN.md** — прибрати все, що суперечить цьому документу (stage 2)
