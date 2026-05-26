# Task 9a — TrashStore core

> Self-contained subtask carved out of `DIFF2_IMPLEMENTATION_PLAN.md` Phase 9.
> Covers move-to-trash + three-layer cleanup (R3.5) + compare-lift API (R3.7) +
> list API. **Restore та Deleted-mode UI — Phase 9b, не входять у scope.**
>
> Canonical specifications referenced below live in
> [`../DIFF2_IMPLEMENTATION_PLAN.md`](../DIFF2_IMPLEMENTATION_PLAN.md) (R3.1–R3.7,
> R8.1, R9.1) and [`../PSEUDO-MERGE-MODE.md`](../PSEUDO-MERGE-MODE.md) (§5, §9.4
> Path B 3-step protocol, §11 cross-platform contracts). When code comments cite
> "R3.5 layer 1a" чи "§9.4 Step 3" — це посилання на ці документи.

## 1. Scope (що **входить**)

1. Інтерсепція user-driven delete-у у vault через monkey-patch `app.vault.delete/trash`
   → copy байтів у `.trash/<id>/vault/<originalPath>` + write `meta.json` ДО реального
   видалення з vault.
2. Pull-deletes (через `sync2.applyRemoteDeletion`) **ТАКОЖ** ідуть у trash через
   explicit `trashHooks.captureForDelete(path)` hook, що викликається перед
   `adapter.remove(path)` (R3.4 short recovery window — один drain-цикл).
3. Three-layer cleanup при drain:
   - **1a:** `confirmDeleted(paths)` per batch (`processBatch` success) — для base-file deletes
     після push-confirm.
   - **1b:** `confirmResolved(basePath)` per resolved side-batch — для sibling-trash після
     resolve-confirm.
   - **2:** `sweepOlderThan(threshold)` на drain-end (тільки якщо queue порожня) — backstop
     для всього, що 1a/1b не покрили (orphan/synthetic siblings, gitignored файли,
     pull-delete entries з попереднього drain).
4. Compare-lift API: `liftForCompare(id) → {trashPath, sessionId, record}` +
   `returnFromCompare(sessionId)` — metadata-only marker (R3.7), файл не рухається.
   Плюс defensive `resetLifts()` — для Phase 9b UI "last detail-view tab close"
   invariant (0 active tabs → 0 lifted markers).
5. List API: `list() → Promise<TrashRecord[]>` async з disk-scan;
   `subscribe(listener: () => void)` — bare signal для UI live-update.
6. Onload recovery sweep для partial-intercept + stale lift markers + orphan empty `vault/`
   states.

## 2. Non-scope (що **НЕ** входить)

- `restore(id)` → Phase 9b.
- Deleted-mode UI (list view + detail view + toolbar R7.9d) → Phase 9b.
- `[Restore from GitHub]` (R3.6 GitHub-side, потребує `listCommitsForPath`) →
  Phase 9b (cross-залежність з Phase 7 History).
- Жодного DOM/CM6 коду — TrashStore чисто data-layer.

## 3. Нові файли (`src/diff2/`)

```
src/diff2/
├── types.ts                 ← scaffold з Phase 0; додати TrashRecord
├── trash-store.ts           ← public API + serialize promise-chain + listeners (no in-memory record cache)
├── trash-watcher.ts         ← monkey-patch app.vault.delete/trash; on-call invokes TrashStore.intercept()
├── trash-recovery.ts        ← onload recovery sweep (R8.1)
├── strip-conflict-suffix.ts ← pure regex helper, reverse of conflict-from-* naming
└── trash-disk-helpers.ts    ← tryReadMetaJson, atomicWriteJson, rmrf, ensureParentDirs (всі <10 LoC, mobile-safe)
```

**Reused helpers (вже існують):**
- `safeRename` — `src/sync2/cross-platform.ts` (R3.7 § використання)
- `computeBlobSha` — `src/utils.ts` (TrashRecord.sha при intercept)
- `newBatchId` / `parseTimestampId` / `allocateUniqueId` pattern — `src/sync2/push-queue.ts:37-48,506-519`. **План:** виокремити у `src/sync2/timestamp-id.ts` як shared util з повторним експортом; push-queue.ts імпортує звідти замість module-private declare. diff2/trash-store.ts тоді теж імпортує (legitimate sync2 → util direction, не cross-edge). Виокремлення — pure refactor (нульова поведінкова зміна); тестується тим, що існуючі 429 unit + ~106 integration тести залишаються зеленими.

**New helpers у `trash-disk-helpers.ts` (всі trivial)**:

```ts
// 3-step atomic write (PSEUDO-MERGE-MODE §9.4 Path B pattern, simplified
// without .sync-bak бо meta-files не мають snapshot-integrity-witness).
async atomicWriteJson(adapter, path, obj): Promise<void> {
  const tmp = path + ".tmp";
  await adapter.write(tmp, JSON.stringify(obj));
  await safeRename(adapter, tmp, path);  // cross-platform overwrite-safe
}

// Try-read meta.json. Returns null on missing/parse-error (treated as
// "invalid record" by callers — recovery sweep wipes orphan).
async tryReadMetaJson<T>(adapter, path): Promise<T | null> {
  try {
    const raw = await adapter.read(path);
    return JSON.parse(raw) as T;
  } catch { return null; }
}

// Recursive directory remove (адаптер.rmdir з {recursive: true}).
async rmrf(adapter, dirPath): Promise<void> { ... }

// Ensure all parent directories exist (segment-by-segment mkdir, mobile-safe;
// see push-queue.ts:527 ensureParentDir for reference impl).
async ensureParentDirs(adapter, filePath): Promise<void> { ... }
```

## 4. Edits у існуючих файлах

### 4.1 `src/sync2/push-queue.ts`

Розширити `EnqueueMeta`:

```ts
export interface EnqueueMeta {
  // ... існуючі поля
  synthetic?: boolean;
  resolvesConflictForBasePath?: string;  // ← NEW. Set by Phase B.
}
```

Persist у `meta.json` без іншої логіки. TrashStore читає при `confirmResolved`
через `batch.meta`.

### 4.2 `src/sync2/sync2-manager.ts`

Чотири точкові правки, кожна — кілька рядків:

**(a) Constructor injection** — `trashHooks` додається як **останній опційний**
параметр constructor-а:

```ts
interface TrashHooks {
  captureForDelete(path: string): Promise<void>;     // R3.4 pull-delete capture
  confirmDeleted(paths: string[]): Promise<void>;    // layer 1a
  confirmResolved(basePath: string): Promise<void>;  // layer 1b
  sweepOlderThan(threshold: string): Promise<void>;  // layer 2
}
constructor(...existingParams, trashHooks?: TrashHooks) {
  this.trashHooks = trashHooks;
}
```

**Position matters** — last + optional + default undefined. Існуючі test-helper-и
(`createSync2Client`, `Sync2TestClient` у `tests/integration/scenarios/sync2/helpers.ts`)
конструюють Sync2Manager позиційно; зміна порядку чи non-optional → all sites break.
З останнім опційним — все existing test code працює без правок (Принцип #4: тести
додаємо, не заміняємо).

**(b) `drain.startedAt` capture** — **ВСЕРЕДИНІ re-entrant guard**, не зовні
(CLAUDE.md "drain() is re-entrant-safe via running flag"):

```ts
async drain() {
  if (this.running) return;     // ← re-entrant guard
  this.running = true;
  const drainStartedAt = newBatchId(new Date());   // capture ПІСЛЯ guard
  let drainSucceeded = false;
  try {
    // існуюча drain-логіка (findChanges + processBatch loop + finalise)
    drainSucceeded = (queue.size === 0);
  } finally {
    if (drainSucceeded && this.trashHooks) {
      try { await this.trashHooks.sweepOlderThan(drainStartedAt); }
      catch (e) { logger.warn("trash sweep failed", { err: e }); }
      // sweep failure НЕ скасовує drainSucceeded; trash залишиться до наступного drain.
    }
    this.running = false;
  }
}
```

**Чому всередині guard.** Re-entrant-skipped invocations (interval tick під час user
click) повертаються ДО capture-у. Це гарантує: один drain-цикл — один `startedAt`. Якщо
винести `drainStartedAt = ...` перед `if (this.running)`, кожен skipped tick захопить
свій timestamp і нічого не зробить — нешкідливо, але зайво.

**(c) `processBatch` confirm hooks** — після `await pushQueue.delete(batch.id)`:

```ts
if (this.trashHooks) {
  await this.trashHooks.confirmDeleted(batch.deletedPaths);
  if (batch.meta.resolvesConflictForBasePath) {
    await this.trashHooks.confirmResolved(batch.meta.resolvesConflictForBasePath);
  }
}
```

**(d) Phase B side-batch synthesis** — у `synthesizeResolutionSideBatches`:

```ts
await pushQueue.enqueueSynthetic({
  path: closedPath,
  content: <bytes>,
  parentCommitSha: <currentMain>,
  resolvesConflictForBasePath: closedPath,  // ← NEW
});
```

**(e) `applyRemoteDeletion` capture hook** (line ~1620 у `sync2-manager.ts`) — ПЕРЕД
`adapter.remove(path)`:

```ts
private async applyRemoteDeletion(path: string, ...) {
  // ... існуючі guards (local exists? conflict?) ...
  if (this.trashHooks) {
    try { await this.trashHooks.captureForDelete(path); }
    catch (e) { logger.warn("trash capture failed for pull-delete", { path, err: e }); }
    // capture failure НЕ блокує sync — trash це best-effort safety net.
  }
  await this.vault.adapter.remove(path);   // ← існуючий рядок 1634
  // ... existing post-delete logic ...
}
```

Це **єдиний дозволений** explicit hook для pull-side delete-у. R3.4 (pull-deletes
captured to trash for one drain cycle of recoverability) виконується через цей виклик.

### 4.3 `src/main.ts`

- Інстанціювати `TrashStore` після `loadSettings()`.
- Викликати `trashRecovery.sweepOnload(trashStore)` **ПЕРЕД** instantiating
  `Sync2Manager` (recovery state мусить бути узгоджений до того, як sync почне
  читати).
- Передати `trashHooks = trashStore.asHooks()` у `Sync2Manager` constructor.
- Register `vault.on('delete', file)` через `trash-watcher.ts`.

## 5. Public API — `TrashStore`

```ts
export interface TrashRecord {
  id: string;                    // 17-digit timestamp; directory name; незмінний
  originalPath: string;          // vault-relative path before delete
  originalDeletedAt: string;     // ISO timestamp; для UI "deleted X ago"
  sha: string;                   // blob SHA of file content at delete time
  size: number;
  mtime: number;

  // Lifted-state marker — metadata-only shield (R3.7).
  // Файл фізично НЕ переміщується при lift/return — лишається у
  // .trash/<id>/vault/<originalPath>. Set field блокує усі три cleanup-прошарки
  // R3.5 (guard у §6.2/§6.3/§6.4 пропускає lifted records). UI ідентифікує сесію
  // за sessionId (timestamp лiфт-моменту). На crash-recovery всі такі поля
  // clear-ються (§7).
  liftedAsSessionId?: string;
}

export interface TrashHooks {
  // Called by sync2.applyRemoteDeletion BEFORE adapter.remove(path) — гарантує,
  // що байти ще на диску і можуть бути прочитані. Capture failure не блокує
  // sync (best-effort trash safety net; log warning, continue).
  // R3.4: pull-deletes ТАКОЖ ідуть у .trash для short recovery window.
  captureForDelete(path: string): Promise<void>;

  confirmDeleted(paths: string[]): Promise<void>;
  confirmResolved(basePath: string): Promise<void>;
  sweepOlderThan(threshold: string): Promise<void>;
}

export class TrashStore {
  constructor(app: App, configDir: string);

  // Init — створює .trash/ якщо нема. Жодного scan-у, жодного in-memory index.
  async init(): Promise<void>;

  // Intercept — public, path-based. Викликається:
  // (a) trash-watcher's monkey-patched vault.delete/trash із `file.path`
  //     (user-driven deletes через Obsidian UI).
  // (b) opens internally і expose-ється через `asHooks().captureForDelete`
  //     для sync2.applyRemoteDeletion (pull-driven deletes — R3.4 explicit hook).
  // Caller MUST викликати ПЕРЕД тим, як файл фактично видалиться з диску —
  // intercept читає байти через adapter.readBinary(path).
  async intercept(path: string): Promise<TrashRecord>;

  // Queries — все async, disk-authoritative. Realistic N ≈ 3–20 entries
  // (типово 3–5 між двома sync, рідко 10–20), тому readdir + N×meta.json
  // — це <10 ms навіть на mobile.
  async list(): Promise<TrashRecord[]>;          // sorted by originalDeletedAt desc
  async get(id: string): Promise<TrashRecord | undefined>;
  async getByOriginalPath(path: string): Promise<TrashRecord[]>;

  // Live-update — bare signal. UI робить власний await list() при notify.
  subscribe(listener: () => void): () => void;

  // Compare-lift
  async liftForCompare(id: string): Promise<{
    trashPath: string;       // .trash/<id>/vault/<originalPath> — UI reads from here
    sessionId: string;
    record: TrashRecord;
  }>;
  async returnFromCompare(sessionId: string): Promise<void>;

  // Defensive normalizer (Phase 9b UI використовує при закритті ОСТАННЬОГО
  // detail-view tab-у). Скидає liftedAsSessionId усіх records у .trash/.
  // Підтримує load-bearing invariant: "0 active detail-view tabs → 0 lifted
  // markers". Primary path — це per-tab returnFromCompare(own sessionId);
  // resetLifts() — safety net для escapees (programmer-error, async-race,
  // тощо). Ідемпотентний; повторний виклик без lifted entries — no-op.
  async resetLifts(): Promise<void>;

  // Cleanup hooks (consumed by sync2)
  asHooks(): TrashHooks;
}
```

**State, який TrashStore тримає у пам'яті** — мінімум:
- `Set<() => void>` listeners (для subscribe-нотифікацій).
- `Promise<unknown> currentOp` для serialize().
- Нічого пов'язаного з content-ом trash. Диск — single source of truth.

## 6. Algorithms

### 6.1 `intercept(path)` — copy bytes to trash

Public-метод, path-based. Викликається з двох сторін: (a) monkey-patched
`vault.delete/trash` через `trash-watcher.ts` (user-driven), і (b) опосередковано
через `asHooks().captureForDelete` з `sync2.applyRemoteDeletion` (pull-driven, R3.4).
Послідовність наслідує Path B 3-step pattern (PSEUDO-MERGE-MODE §9.4):

**Spec context.** Realistic N ≈ 3–5 trash-entries між двома sync-кліками,
рідко 10–20. Vault ~300 файлів. Тому всі query-операції (`list`, `get`,
cleanup-hook iterations) — це просто `readdir(.trash/)` + N×readMetaJson, де
N мізерне. Жодного in-memory index не потрібно; диск — single source of truth.

**Helper-функція**, на яку посилаються алгоритми нижче:

```ts
// Читає всі валідні TrashRecord з диску. Скип-ить директорії без валідного meta.json
// (recovery sweep розбирає orphan-и; тут вони просто ігноруються — query-level robustness).
async readAllRecords(): Promise<TrashRecord[]> {
  const entries = await adapter.list(.trash/);   // returns folders
  const records: TrashRecord[] = [];
  for (const dirName of entries) {
    const meta = await tryReadMetaJson(.trash/<dirName>/meta.json);
    if (meta && meta.id === dirName) records.push(meta);
  }
  return records;
}
```

```
intercept(path):
  1. id = await allocateUniqueId()
  2. fileContent = await adapter.readBinary(path)   ← caller гарантує що файл ще на диску
  3. sha = computeBlobSha(fileContent)
  4. stat = await adapter.stat(path)                ← {size, mtime}
  5. dstFile = .trash/<id>/vault/<path>
  6. await ensureParentDirs(dstFile)                ← recursive mkdir
  7. await adapter.writeBinary(dstFile, fileContent)
  8. meta = { id, originalPath: path, originalDeletedAt: nowIso(), sha, size, mtime }
  9. await atomicWriteJson(.trash/<id>/meta.json, meta)
  10. notifyListeners()
  11. return meta
```

**Двосторонній in-flow до intercept** (R3.4 переформульовано):

| Caller | Mechanism |
|---|---|
| (a) User-driven delete через Obsidian UI | `trash-watcher.ts` monkey-patch-ить `app.vault.delete` + `app.vault.trash` на onload. Patched-метод викликає `trashStore.intercept(file.path)` ДО `originalDelete(file)`. На unload патчі знімаються (LIFO-safe для конкуруючих плагінів). |
| (b) Sync-driven pull-delete | `sync2-manager.ts::applyRemoteDeletion` (line ~1620) викликає `trashHooks.captureForDelete(path)` ДО `vault.adapter.remove(path)`. `captureForDelete` мапиться у `intercept(path)` через `asHooks()`. |

Обидва шляхи best-effort: catch-around-intercept logs warning і continue, ніколи не блокує
delete (trash це safety net, не sync-blocker).

**Design boundary** TrashStore реагує **тільки** на видалення, ініційовані безпосередньо користувачем — два 
expected-канали:
- (a) `vault.delete`/`vault.trash` через Obsidian UI (file explorer, command palette,
shortcuts) — monkey-patch перехоплює;
- (b) sync2-driven pull-delete — explicit `captureForDelete` hook.

Видалення через `vault.adapter.remove(path)`, ініційовані **іншими плагінами** чи скриптами, **не потрапляють у
trash** — і це коректно за визначенням, а не gap для закриття. Аргументація:

- *Це не наша sphere of responsibility.* Сторонній плагін, що видаляє файли — це не дія, скерована користувачем,
  в семантиці нашого плагіну. Користувач не клікав "Delete" в Obsidian UI, а отже не очікує побачити цей файл у
  нашому Deleted list. Намагатися "врятувати" будь-яке зникнення файлу з vault — це гіперактивна
  поведінка, що засмічує trash чужими-плагінів-temp-файлами, lock-файлами, cache-evict-ами, тощо.
- *Адаптерний уровень — не event surface.* `adapter.remove` за дизайном Obsidian
  не fire-ить vault events. Перехоплення на цьому рівні вимагало б monkey-patch
  адаптера, що ламає всю архітектуру (адаптер shared між vault, settings,
  плагінами всередині них; patch-ити його — кратно більший blast radius ніж
  vault.delete).
- *Сторонні плагіни мають свої механізми undo.* Якщо інший плагін видаляє файли
  без використання Obsidian's native delete, він бере на себе відповідальність
  за рестов-механіку (свій undo stack, свій log).

Якщо колись виявиться важливий use-case "користувач використовує плагін X, який
видаляє через adapter, і хоче бачити ці файли у нашому trash" — це окрема feature,
не bug-fix. Документуємо у README user-facing розділі для прозорості.

### 6.2 `confirmDeleted(paths)` — Layer 1a

```
confirmDeleted(paths):
  records = await readAllRecords()
  changed = false
  for record in records:
    if record.liftedAsSessionId: continue   ← shield
    if record.originalPath in paths:
      await rmrf(.trash/<record.id>/)
      changed = true
  if changed: notifyListeners()
```

### 6.3 `confirmResolved(basePath)` — Layer 1b

```
confirmResolved(basePath):
  records = await readAllRecords()
  changed = false
  for record in records:
    if record.liftedAsSessionId: continue
    if stripConflictSuffix(record.originalPath) === basePath:
      await rmrf(.trash/<record.id>/)
      changed = true
  if changed: notifyListeners()
```

`stripConflictSuffix(path)` — pure helper у `src/diff2/strip-conflict-suffix.ts`.
Регекс відповідає invariant-gitignore patern `*.conflict-from-*`:

```
^(.+?)\.conflict-from-[^.]+-[\d\-T:Z]+\.([^.]+)$  → reconstruct "<stem>.<ext>"
```

Edge cases (file без extension, hidden file типу `.gitignore.conflict-from-...`)
покриваються тестами `strip-conflict-suffix.test.ts`.

### 6.4 `sweepOlderThan(threshold)` — Layer 2

```
sweepOlderThan(threshold):
  records = await readAllRecords()
  changed = false
  for record in records:
    if record.liftedAsSessionId: continue
    if record.id < threshold:   ← string compare на 17-digit timestamps
      await rmrf(.trash/<record.id>/)
      changed = true
  if changed: notifyListeners()
```

### 6.5 `liftForCompare(id)` — metadata-only, disk-read+write

```
liftForCompare(id):
  meta = await tryReadMetaJson(.trash/<id>/meta.json)
  if !meta: throw "Trash entry <id> not found"
  if meta.liftedAsSessionId: throw "Already lifted as session <...>"

  sessionId = generateTimestampId()
  meta.liftedAsSessionId = sessionId
  await atomicWriteJson(.trash/<id>/meta.json, meta)   ← single atomic step

  notifyListeners()
  return {
    trashPath: .trash/<id>/vault/<meta.originalPath>,   ← UI reads from here
    sessionId,
    record: meta,
  }
```

Жодного rename файлу. Файл залишається у `.trash/<id>/vault/<originalPath>`
усю compare-сесію. UI читає байти звідти напряму через `adapter.read*`.

### 6.6 `returnFromCompare(sessionId)` — metadata-only

```
returnFromCompare(sessionId):
  records = await readAllRecords()
  meta = records.find(r => r.liftedAsSessionId === sessionId)
  if !meta: throw "Session <sessionId> not found"

  meta.liftedAsSessionId = undefined
  await atomicWriteJson(.trash/<meta.id>/meta.json, meta)   ← single atomic step

  notifyListeners()
```

**Властивість, що випливає (R3.7).** Якщо `return` відбувається ДО старту
наступного drain-у — файл утилізується нормальним flow, ніби ніколи не
lift-вився. Всі три прошарки R3.5 спрацьовують природно для record-у, у якого
`liftedAsSessionId` clear. Деталі — DIFF2_IMPLEMENTATION_PLAN.md R3.7.

### 6.6b `resetLifts()` — defensive normalize

```
resetLifts():
  records = await readAllRecords()
  changed = false
  for record in records:
    if record.liftedAsSessionId:
      record.liftedAsSessionId = undefined
      await atomicWriteJson(.trash/<record.id>/meta.json, record)
      changed = true
  if changed: notifyListeners()
```

**Invariant, який цей метод підтримує:** *"коли 0 active diff2 detail-view tabs,
тоді 0 lifted markers у `.trash/`"*.

**Phase 9b UI calling pattern** (документується для Phase 9b implementer):

```ts
// Phase 9b: src/diff2/deleted-list.ts (or equivalent)
let activeDetailViewCount = 0;

onOpenDetailView() { activeDetailViewCount++; }

onCloseDetailView(sessionId: string) {
  trashStore.returnFromCompare(sessionId);   // primary path — clear own marker
  activeDetailViewCount--;
  if (activeDetailViewCount === 0) {
    trashStore.resetLifts();                 // defensive — catch any escapees
  }
}
```

Primary path (`returnFromCompare`) — це нормальний код для кожного tab-у; коли
поведінка коректна, після close-у останнього tab-у lifted markers вже = 0, і
`resetLifts()` — no-op. Defensive шлях ловить programmer-error /
async-race / un-caught exceptions, що залишили orphan markers.

Throw-on-duplicate-lift (§6.5) + defensive `resetLifts()` = self-healing
system: strict failure-detection на fault site + quiet normalization на
known-safe-point.

### 6.7 `init()` — trivial

```
init():
  await adapter.mkdir(.trash/) if not exists
```

Жодного scan-у диску. Recovery sweep (§7) — окрема операція, викликається
`main.ts::onload` ПЕРЕД `Sync2Manager` instantiation.

### 6.8 Serialization — concurrent operations

Всі mutating-методи (`intercept`, `confirmDeleted`, `confirmResolved`,
`sweepOlderThan`, `liftForCompare`, `returnFromCompare`, `resetLifts`)
серіалізуються через
promise-chain:

```ts
private currentOp: Promise<unknown> = Promise.resolve();

private serialize<T>(op: () => Promise<T>): Promise<T> {
  const prev = this.currentOp;
  const next = (async () => {
    try { await prev; } catch {} // не наслідуємо помилку попередньої операції
    return op();
  })();
  this.currentOp = next.catch(() => {});
  return next;
}
```

Кожен public mutator обгортається `return this.serialize(async () => { ... })`.
Це закриває race-у `lift+sweep`, `intercept+confirmDeleted`, `return+sweep` на
рівні process-у. Race із concurrent drain (зовнішнім процесом) описаний у
DIFF2_IMPLEMENTATION_PLAN.md R3.7 "Race-аналіз".

## 7. Recovery sweep (`trash-recovery.ts`)

Викликається з `main.ts::onload` ПЕРЕД instantiating Sync2Manager. Один прохід
диску, повністю disk-authoritative — нема in-memory state-у щоб синхронізувати:

```
sweepOnload(trashStore):
  await trashStore.init()   ← створює .trash/ якщо нема

  for dirName in await adapter.list(.trash/):
    metaPath = .trash/<dirName>/meta.json
    vaultDir = .trash/<dirName>/vault/
    meta = await tryReadMetaJson(metaPath)

    if !meta:
      // Випадок A: orphan dir без валідної meta.json (intercept crash між
      //            writeBinary і atomicWriteJson).
      vaultFile = await firstFileInside(vaultDir)   ← якщо vault/ існує
      if vaultFile:
        → move vaultFile → vault/<originalPath-recovered> з collision-rename
          per R8.1 TrashStore.create row
      → rmrf .trash/<dirName>/

    elif meta.liftedAsSessionId:
      // Випадок B: stale lift marker (UI вмерло разом з Obsidian).
      meta.liftedAsSessionId = undefined
      → atomicWriteJson(metaPath, meta)
      // Файл у vaultDir не чіпаємо — він і не рухався (metadata-only protocol).

    elif !exists(.trash/<dirName>/vault/<meta.originalPath>):
      // Випадок C: meta валідна, але vault-файл зник (rare crash).
      → rmrf .trash/<dirName>/
      log.warn "trash entry vault file missing — wiping orphan"

    // else: запис валідний, нічого не робимо

  notifyListeners()   ← UI re-scans після recovery
```

Жодного `.trash-staging/` (R3.7 metadata-only). Кожен sweep-крок ідемпотентний;
повторний crash посеред recovery → наступний onload зачистить решту. Логування —
через існуючий `logger.ts`.

## 8. Tests

Розташування — три директорії за CLAUDE.md *Testing*:

### 8.1 Unit (`tests/diff2/`)

- `trash-store-intercept.test.ts` — basic move-to-trash + meta.json shape
- `trash-store-list.test.ts` — list/get/getByOriginalPath повертають disk-scan
  результат; sort by `originalDeletedAt` desc; порожній `.trash/` → `[]`
- `trash-store-confirm-deleted.test.ts` — layer 1a path-matching + skip-lifted
- `trash-store-confirm-resolved.test.ts` — layer 1b sibling-pattern matching + skip-lifted
- `trash-store-sweep-older-than.test.ts` — layer 2 threshold compare + skip-lifted
- `trash-store-lift-return.test.ts` — happy path lift + return + id preserved
- `trash-store-lift-conflicts.test.ts` — повторний lift одного id (помилка),
  lift неіснуючого id (помилка)
- `trash-store-reset-lifts.test.ts` — `resetLifts()` clear-ить ALL lifted
  markers незалежно від sessionId; idempotent (повторний виклик no-op);
  не зачіпає не-lifted records; emits one notify event (не per-record);
  Phase 9b "last tab close" invariant verification
- `trash-store-subscribe.test.ts` — listener called (bare, no args) on each
  mutation; unsubscribe-функція припиняє notifications
- `trash-store-serialize.test.ts` — concurrent calls серіалізуються через
  promise-chain (наприклад, два паралельних `intercept` не interleave-аться)
- `strip-conflict-suffix.test.ts` — pure regex helper (edge: no ext, hidden file)
- `trash-store-capture-for-delete.test.ts` — `asHooks().captureForDelete(path)` →
  `intercept(path)` flow. Перевіряє, що pull-side hook створює trash entry перед
  власне `adapter.remove`. Окремо unit-тест contract-у "якщо файл уже видалений
  до captureForDelete виклику — log warning, не throw".

### 8.2 Crash-resilience (`tests/diff2/crash-resilience/`)

R8.3 шаблон `<store>-kill-after-<step>.test.ts`:

- `trash-intercept-kill-after-writeBinary.test.ts` — bytes написані у
  `.trash/<id>/vault/<path>`, meta.json ще не записано; recovery sweep
  Випадок A (orphan dir без валідної meta): vault-файл ще на місці (intercept
  не блокує оригінальний delete) → rmrf .trash/<id>/ (orphan), нічого не
  повертаємо (бо файл і так у vault). Або, у тонкому варіанті — якщо
  оригінальний delete теж не встиг, vault/<path> залишається; sweep
  rmrf-ить trash і vault інтактний.
- `trash-intercept-kill-after-meta-write.test.ts` — bytes у .trash, meta
  написана, але оригінальний `vault.delete` ще не встиг. Recovery бачить
  валідний trash entry + vault.path-у не зник. Дублікат стану; sweep no-op;
  next drain layer 2 свайпає trash entry, vault інтактний. Користувач
  бачить файл у vault (delete фактично не дійшов), може re-delete.
- `trash-lift-then-kill-recovery.test.ts` — lift completed (meta.json з marker
  set), kill, recovery step (2) clear-ить field, файл у vault/ не зачіпається.
- `trash-lift-kill-mid-meta-write.test.ts` — kill ДО завершення atomic-write
  meta.json (temp file існує, original meta intact); recovery бачить marker
  undefined у канонічному meta, treats as not-lifted; orphan temp file
  прибирається atomic-write cleanup-ом.
- `trash-return-then-kill-recovery.test.ts` — return completed, kill під час
  іншої операції; recovery no-op (marker уже cleared).
- `trash-sweep-kill-mid-iteration.test.ts` — `sweepOlderThan` kill між
  ітераціями; recovery state — half of records cleaned, other half pending; next
  drain's sweep finishes the job (ідемпотентний).

Кожен тест: інжектує `throw new Error("simulated kill")` у точці між кроками,
викликає `sweepOnload()`, перевіряє інваріант з R8.1 walkthrough.

### 8.3 Integration (`tests/integration/scenarios/diff2/n-series-trash/`)

Новий bucket:

- `n01-base-delete-confirms-via-1a.test.ts` — delete file → drain → trash entry зник
- `n02-sibling-resolve-confirms-via-1b.test.ts` — resolve conflict через sibling-delete → drain → trash entry зник
- `n03-orphan-gitignored-swept-via-2.test.ts` — delete `.log` файл → drain → trash entry зник (layer 2)
- `n04-pull-delete-captured-to-trash.test.ts` — R3.4 verification: remote-side
  delete файлу → pull → `applyRemoteDeletion` викликає `captureForDelete` →
  `.trash/<id>/` створено з правильним originalPath + sha. Drain ends:
  layer 2 НЕ свайпає (id > drain.startedAt). Наступний drain swap: layer 2 свайпає
  → trash порожній. Recovery window verified.
- `n04b-direct-adapter-remove-bypasses-trash.test.ts` — known limitation: hand
  call `adapter.remove(path)` (без `captureForDelete` hook) → trash порожній.
  Документує contract для third-party plugins.
- `n05-lift-survives-drain.test.ts` — lift до drain → drain runs → record з `liftedAsSessionId` set пропускається усіма трьома прошарками, `.trash/<id>/vault/<path>` залишається непошкодженим (метаdaнi-only protocol)
- `n06-return-before-next-drain-treated-normally.test.ts` — lift, return до наступного drain, drain processes → файл утилізується нормальним flow (1a/1b/2 за типом)

### 8.4 MOCK_PLATFORM coverage

Тести `trash-store-intercept.test.ts` і `trash-store-lift-return.test.ts` мають бути
parametrised під обидві платформи (`describe.each([{platform:"desktop"},{platform:"mobile"}])`):
- `intercept` робить `atomicWriteJson` → `safeRename` всередині (overwrite meta.json якщо вже є).
- `liftForCompare/returnFromCompare` теж `atomicWriteJson` → `safeRename` (rewrite meta.json
  з/без `liftedAsSessionId`).

Без обох параметризацій Capacitor-rename non-overwrite семантика залишиться
непротестованою для meta-write шляхів.

## 9. Acceptance criteria

1. `pnpm build` clean (no typecheck errors).
2. Усі ~429 існуючі unit + ~106 integration тести проходять **без змін**
   (Принцип #2 + #4 DIFF2_IMPLEMENTATION_PLAN.md).
3. Нові unit тести з §8.1 — зелені.
4. Нові integration тести n01–n06 — зелені.
5. Crash-resilience тести з §8.2 — зелені.
6. Manual smoke test: видалити файл у vault через Obsidian UI → `.trash/<id>/vault/<path>`
   з'являється; `meta.json` валідний; `[Sync with GitHub]` → trash порожній. **Включити
   у smoke-сценарій файл з кирилицею + пробілами у імені** (наприклад
   `Нотатки/Моя нова ідея.md`) — cross-platform §11 corner; smoke-сценарій
   також на mobile build, якщо доступний.
7. **Жодного імпорту `src/sync2/* → ../diff2/*`** (grep check у PR opis).
8. `pnpm dev` build (з `OBSIDIAN_PLUGIN_DIR` env) у live Obsidian vault працює;
   sync2 не зламано.

## 10. Resolved decisions

1. **`vault.delete` interception підхід → monkey-patch.** На `plugin.onload`
   patch-уються `app.vault.delete` і `app.vault.trash`; кожен patched-метод
   читає байти, write-ить у `.trash/<id>/`, потім викликає оригінал. На
   `plugin.unload` патчі відновлюються (зберігаємо оригінали у closure).
   Pattern використовується у відомих Obsidian-плагінах (obsidian-recently-
   deleted та ін). Колізія з іншими плагінами, що теж patch-ять ці методи,
   розв'язується LIFO order-ом: ми patch-имо last → unwrap-имо first.
2. **`deviceLabel` у TrashRecord → НЕ зберігаємо.** Поле прибране з
   `TrashRecord` (§5) і з meta-build-кроку у §6.1. У майбутньому, якщо
   deleted-mode UI стане cross-device aware, можемо додати поле без
   breaking-зміни — старі meta.json без поля treat-имуться як "device unknown".
3. **`subscribe` granularity → bare signal + disk-authoritative store.** API:
   `subscribe(listener: () => void)`. Listener отримує no-arg сповіщення "trash
   змінився"; UI робить власний `await trashStore.list()` на notify. Більше
   того — `TrashStore` **взагалі не тримає in-memory index** trash-records:
   диск (`.trash/<id>/meta.json`) — single source of truth, всі query
   (`list`, `get`, cleanup-hooks iterations) скан-ять диск на льоту.
   Обґрунтування: realistic N ≈ 3–5 entries між sync-кліками (rare 10–20)
   при vault-і ~300 файлів → readdir + parse 5×meta.json < 5 ms навіть на
   mobile. Менше state-у у пам'яті → менше bug-сurface (Map↔disk desync),
   простіший recovery (нічого "відновлювати у пам'яті"), простіші тести
   (кожен перевіряє disk).

---

**Дотичні документи:**
- [`../DIFF2_IMPLEMENTATION_PLAN.md`](../DIFF2_IMPLEMENTATION_PLAN.md) — canonical spec; §R3 (Recently deleted/Local trash), §R8.1 (crash resilience), §R9 Phase 9a row.
- [`../PSEUDO-MERGE-MODE.md`](../PSEUDO-MERGE-MODE.md) — §5 drain pseudocode (interaction з Phase A/B), §9.4 Path B 3-step protocol pattern, §11 cross-platform contracts (safeRename).
- [`../../CLAUDE.md`](../../CLAUDE.md) — repo-wide instructions; module layout, testing conventions, dependency-direction invariant (sync2 → diff2 forbidden).
