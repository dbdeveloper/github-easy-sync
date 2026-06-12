# DIFF-EDITOR-V2 — критичний аналіз + план заміни

> Аналіз спеки `DIFF-EDITOR-V2.md` (нова модель редактора), яка має замінити поточну реалізацію
> `src/diff2/` (модель `DIFF-EDITOR.md §1`). Складено 2026-06-12 разом з /advisor.
> Стан поточної бази: гілка `fix-diff-editor`, ~6.9k рядків `src/diff2/`, ~8.8k рядків `tests/diff2/`.

---

## 0. TL;DR (висновки)

1. **V2 свідомо замінює ЛИШЕ модель `§1`, а не весь `DIFF-EDITOR.md`.** Решта `DIFF-EDITOR.md` (§2 autosave,
   §3 recovery/replay, §4 cleanup, §5 7-step commit + A–K recovery) **лишається канонічною** і має бути
   **АДАПТОВАНА** під нову модель зберігання diff-документа в CM6-widget. Це не «відсутній контракт» і не блокер —
   це навмисний поділ: V2 = спека МОДЕЛІ, `DIFF-EDITOR.md §2–§5` = решта, яку треба відредагувати під неї.
   Практичний наслідок для плану: точки, де §2–§5 ЧІПАЮТЬ представлення (поле `structure` у `history.jsonl §2.6`,
   replay `§3.3`, `split()` для commit, 0-byte guard) — треба переписати під нову модель; МЕХАНІЗМ навколо них
   (append/truncate/snapshots/done.json/recovery-matrix/modify-in-place) — лишити. Окремо: V2 відмовляється від
   `\0/\1` joined-doc → де він фігурував у §1–§5, формулювання треба оновити.

2. **Мета — прибрати НЕОБҐРУНТОВАНУ (accidental) складність, а не «менше коду».** Zero-width `Segment[]` +
   `growIdx` + inclusive/exclusive edges + auto-collapse coordinate-machinery — це **accidental complexity, що
   виникла САМЕ через відсутність термінального `\n`** (без нього порожній блок = zero-width, і весь цей апарат
   існує лише щоб не дати діапазону схлопнутись). V2 робить модель природнішою (term-`\n` ⇒ діапазон завжди ≥1)
   і прибирає цей клас цілком — це і є оптимізація архітектури, якої просили. Складність геометрії (`height:0`,
   навігація крізь приховані рядки) — здебільшого **ВЛАСТИВА** задачі: приховати порожній блок і проходити крізь
   нього треба так чи інакше. Єдиний чесний застереж: геометрична частина найменш тестована (happy-dom її не
   бачить) → device-gate обов'язковий. Тобто не «виграшу немає», а «виграш реальний, але одна частина потребує
   device-валідації, а не зеленого unit-suite».

3. **Ключова архітектурна ідея V2 — здорова і конкретна:** ґарантований **термінальний `\n`** у кожному
   ver-block робить діапазон ЗАВЖДИ ≥1 символ (ніколи zero-width). Саме zero-width діапазони були причиною, чому
   поточний код свідомо ВІДМОВИВся від RangeSet (див. коментар у `editor-model.ts:14-23`). Прибравши zero-width,
   V2 робить `Inclusive RangeSet` життєздатним. Тобто термінальний `\n` — це лінчпін, без якого вся V2-модель
   не тримається.

4. **Найдешевша правильна стратегія міграції — «minimal-bridge»** (див. §5): замінити лише ПРЕДСТАВЛЕННЯ
   (editor-model + diff-pane + decorations/markers/line-numbers/selection + *вміст* history-блоку), а
   польово-загартований персистентний шар (`exit-commit.ts` 7-step + A–K `recoverCommit` + modify-in-place +
   усі `trash-*`) — **зберегти**. Перевірено: `exit-commit.ts` приймає готові `base`/`sibling` рядки і пише байти
   файлів; представлення йому байдуже (`fromEditorModel` згадано лише в коментарях). Це і є «повна заміна
   заскладної архітектури» — бо заскладним було саме ПРЕДСТАВЛЕННЯ, а не recovery.

5. **Перед будь-яким кодом — device/Playwright SPIKE** на `height:0`-toggling + `moveVertically` крізь приховані
   рядки. Це найменш тестована й найкритичніша частина V2. Якщо вона не працює в реальному CM6/Obsidian — V2
   мертва на старті. Це точно та пастка «тести зелені, застосунок зламаний», що вже вкусила в багах TODO #4 і #10.

6. **«Краще визначена?» — у покритій частині ТАК.** Після розбору з користувачем (2026-06-12) майже всі мої
   початкові «дефекти» знято (split = тривіальний RangeSet-walk; clipboard `.....` однозначний; 0-byte —
   commit-шар, не модель; §2.2.8 канонічна над §2.2.4(9)). Реально лишилось: `§2.2.4(9b)` — ✅ вже виправлено
   (`current_range.to`); `§2.2.9` — один RESEARCH-item (scenario-2 paste-резолюція + чи CM6 дає програмний paste
   через `transactionFilter`). Деталі — §3.3.

---

## 1. Що саме змінює V2 (архітектурна суть)

| Аспект | Поточна модель (`DIFF-EDITOR.md §1`) | V2 (`DIFF-EDITOR-V2.md`) |
|---|---|---|
| CM6-документ | «чистий» — точні байти ver-block, БЕЗ термінального `\n` | кожен рядок (norm + ver) має `\n`; кожен ver-block має ще й **термінальний** `\n` |
| Порожній ver-block | zero-width сегмент (`from === to`) + `height:0` фантом (працював погано) | реальний рядок `"\n"` (1 символ) + `height:0` коли не у фокусі (та сама ідея, чистіша основа) |
| Структура | `Segment[]` (ordered tiling), `mapPos` по кожному endpoint, `growIdx`, inclusive/exclusive edges | `Inclusive RangeSet` `{ver, group}`, авто-resize через `value.map(tr.changes)` + захист термінала |
| Серіалізація | `\0/\1` joined-doc (`joined-doc.ts` build/split) | немає `\0/\1`; представлення = сам doc + RangeSet; split = обхід діапазонів |
| Резолюція | doc-edit через `applyToChunk` (часто full-doc-replace у history) | in-place delete діапазонів + plain-text (мінімальна зміна) |
| Multi-cursor | присутній | **вимкнено** (`§2.2.4(10)`) — прибирає цілий клас edge-cases |
| Нумерація рядків | `line-numbers.ts` sibling-wins | on-the-fly формула: CM6-номер − рядки іншої сторони вище (`§2.2.10`) |
| Clipboard diff-group | немає | markdown-code-block `github-easy-sync` з `.....` префіксом (`§2.2.7`) |

Найважливіше: **поточний біль (cursor 0,0 після resolve/recovery, undo, рендер empty-ver) походить саме з
zero-width-Segment[] + full-doc-replace recording.** V2 атакує обидва: term-`\n` усуває zero-width, а
resolution-as-range-edit робить запис мінімальним (а не full-doc-replace) → це і має полагодити баги 9/10/16/17.

---

## 2. Сильні сторони V2

- **Усунення zero-width діапазонів** — концептуально найчистіша частина. Прибирає `growIndexFor`, `§1.8.a`
  empty-ver-activation, auto-collapse-coordinate-crash, inclusive/exclusive edge-tuning. Це реальне спрощення.
- **Resolution = in-place range edit** → history.jsonl отримує МІНІМАЛЬНУ зміну, а не full-doc-replace.
  Прямо адресує bloat + cursor-jump-to-end (TODO #10).
- **RangeSet замість ручного mapPos** — менше власного коду мапінгу; CM6 робить це сам (за умови захисту термінала).
- **Multi-cursor off** — чесне спрощення, прибирає edge-cases.
- **On-the-fly line-numbering** — елегантна O(груп) формула, без precompute/scan (`§2.2.10`).
- **Чіткіші інваріанти структури** (`§2.2.3`): `[normal* → ver1{1,N} → ver2{1,M} → normal*]*` — добре для
  евристик навігації/виділення.

---

## 3. Ризики і прогалини

> **СТАТУС (2026-06-12, після Фази-1 gate): усі екзистенційні ризики ЗНЯТО.** Спека-дефекти усунені (§3.3),
> інтеграційні шви визначені (§3.1 + DIFF-EDITOR.md §0), «drop structure» валідовано спайком 1b, **геометрія+навігація
> валідовані 1a-гейтом у реальному Chromium** (TODO #1 не відтворюється, native-nav пропускає height:0, generic
> `StateField<RangeSet>` росте inclusively). Нижче — історія розбору; жоден пункт більше не блокує Фазу 2.

### 3.1 Точки §2–§5, які треба адаптувати під нову модель (обсяг робіт, не дефект)
V2 за задумом описує лише модель; решта `DIFF-EDITOR.md` лишається й адаптується. Рішення нижче ухвалені з
користувачем (2026-06-12):
- **формат `history.jsonl §2.6` — зберігати текстову зміну, НЕ структуру** (рішення користувача 2026-06-12).
  Блок REDO = записаний інсерт: чистий текст для звичайних правок і резолюцій; **§2.2.7 clipboard-формат (текст)
  ЛИШЕ коли інсерт несе diff-групу(и)** (paste — рідкісний випадок; може містити кілька груп → текст природно
  масштабується, тому НЕ структуроване `{v1,v2}`). replay group-блоку = re-paste того тексту через той самий
  §2.2.7-парсер-фільтр. `structure`/RangeSet у лог НЕ пишемо — деривується. Механізм
  (append/truncate/snapshots/done.json/checksum) — лишається.
  **✅ ВАЛІДОВАНО спайком 1b** (`tests/diff2/spikes/v2-replay-empty-ver-spike.test.ts`, 4/4 PASS, 2026-06-12).
  Старий `history-replay-structure-spike` довів, що change-only НЕ відновлює структуру для (a) full-doc-replace
  chunk-action і (b) typing у активний empty-ver (залежав від `activeEmptyVer`). Спайк 1b довів, що V2 лагодить
  (b): empty-ver як **terminal-INSIDE** ≥1-width range (`Decoration.mark({inclusive:true})` поверх термінального
  `\n`) РОСТЕ над введеним текстом через `DecorationSet.map(change)` — детерміновано, байт-точно, БЕЗ
  `activeEmptyVer`; replay==live. (a) знято scenario-2 (мінімальний region-replace, §3.5). **✅ Terminal-inside
  закріплено:** V2 §2.2.2 виправлено з `Range(7,7)` на `Range(7,8)` (+ уся арифметика §2.2.4–§2.2.9 під
  terminal-inside, аудит 2026-06-12). 1a-гейт додатково підтвердив ріст і на generic `StateField<RangeSet>`
  (не лише `Decoration.mark`). Лишилися edge-кейси (delete-до-порожнього, multi-line, межі суміжних груп) → TDD Фаз 2/5.
- **replay `§3.3` — «програти» plain-text paste через ту саму pipeline-конверсію `§2.2.7`.** Replay повторно
  застосовує текстові зміни; `transactionFilter` упізнає §2.2.7-шаблон і відновлює правильні CM6-рядки + RangeSet
  Range-objects сам. Тобто replay = re-paste, а не «відтворення збереженої структури». Простіше й детермінованіше.
- **`split()` — ✅ ДОДАНО в V2 `§2.2.11`.** RangeSet-walk: normal → обидві сторони; ver1 → base; ver2 → sibling;
  термінальні рядки пропускаються. Точний аналог старого `joined-doc.split()`, керований RangeSet замість `\1`.
- **Zero-size — ✅ ДОДАНО в V2 `§2.2.12`.** + користувач сам виявив тонку проблему: EOL-less останній рядок у
  ver2 порушує інваріант `\n\n`. **Рішення (рекомендовано (a)):** дозволити ОСТАННЬОМУ ver-block форму `.*\n`
  (спецвипадок), НЕ безумовно додавати `\n` (варіант b змінив би байти → фантомний конфлікт у рушії). Поточний
  `editor-model.ts:134-163` уже робить (a) — POSITIONAL-нормалізація звільняє останню групу від правила term-`\n`.
  Дилема фактично вже розв'язана у збереженому шарі.

### 3.2 Геометрія (height:0 + навігація) — НЕ новий коштом V2, а успадкований і покращений
Важливо не плутати: приховані `height:0` рядки й навігація крізь них — це **НЕ те, що V2 додає**.
- **`height:0` вже був** у старій моделі (auto-collapse `§1.6`, `diff2-collapsed`) — і працював ПОГАНО (баги
  TODO #1, #16, #17: фантомні рядки, неправильний рендер empty-ver, зсув gutter). V2 не вводить `height:0` — він
  лишає його, але на чистішій основі (term-`\n` ⇒ діапазон не схлопується, рядок реальний, а не zero-width
  фантом). Очікувано — рендер empty-ver стає ПРАВИЛЬНІШИМ, не складнішим.
- **Компенсація навігації `§2.2.4(9)` — для НЕпорожніх терміналів НЕ потрібна (доведено), для empty-ver = FORK.**
  Native CM6 `moveVertically` сам пропускає height:0-рядки (каретка ніколи не застрягає) → складний підрахунок
  «скільки range.to перескочили + [Down]» для непорожніх терміналів зайвий. АЛЕ для **empty-ver entry** native теж
  ПРОПУСКАЄ — а §2.2.8 хоче «зайти і розгорнути». **РІШЕННЯ (a) (користувач 2026-06-12, валідовано real-key):**
  `moveVertically`-override (`cursorVert`) стопить каретку на empty-ver при перескоку → рядок розгортається; миша/тач
  → §1.8.a. §2.2.4(9) РОЗЩЕПЛЮЄТЬСЯ на дві частини: **(i) геометрія** — heightmap CM6 САМ (вимірює height:0=0px),
  manual «+N [Down]» компенсація ВІДПАДАЄ; **(ii) стоп-детекція** — `E.filter(f=>f>cur && f<nativeLanding)` (які
  empty-vers у перестрибнутому проміжку) ЛИШАЄТЬСЯ, snap до першого. Тобто «підрахунок перескочених» не зник —
  спростився до position-filter; ручне додавання [Down] зникло.
- **Тестованість геометрії — РИЗИК ЗАКРИТО (НЕ device-only).** Виявилось, що `mcp__MCP_DOCKER__browser_*`
  (Playwright/Chromium) = справжній heightmap + `moveVertically`, тож геометрію МОЖНА юніт-gating-ити, не чекаючи
  пристрою. 1a-гейт це й зробив: усе пройшло. Фізичний пристрій лишається тільки для mobile-touch-полишу.

### 3.3 Стан дефектів спеки (після розбору з користувачем 2026-06-12)
Більшість моїх початкових «дефектів» виявилися надмірною сторожкістю. Фактичний стан:
- **`§2.2.4(9b)` — ✅ ВИПРАВЛЕНО користувачем:** предикат → `current_range.to` (було помилково `.from`).
- **`§2.2.9` — ✅ ВИРІШЕНО: scenario-2 (paste-rewrite).** CM6-рекогносцировка проведена (див. §3.5 нижче +
  spike `tests/diff2/spikes/v2-resolution-paste-spike.test.ts`, 3/3 PASS). Емпірично доведено в state 6.6 /
  commands 6.10. scenario-1 лишається запасним для дрібних точкових випадків.
- **`split()` — ✅ ЗНЯТО:** не дефект, тривіальний RangeSet-walk (див. §3.1).
- **Clipboard `§2.2.7` — ✅ ФІНАЛІЗОВАНО** (користувач 2026-06-12, байти перевірено). Маркери: `≪` (U+226A) /
  `==` (ASCII) / `≫` (U+226B); префікси `- ` / `+ ` (ASCII); `↵` (U+21B5) перед `\n` на ver-рядках —
  trailing-whitespace захист. **Усі NFKC-stable + покриті шрифтом** — фрагментний `＝` (U+FF1D→NFKC `=`)
  ПРИБРАНО, tofu-кандидати (`⩵`/`⧺`) відхилено. Неоднозначності нема: префікс безумовний, strip один раз;
  сепаратори без префікса; `↵` strip один раз перед `\n`; + all-or-nothing. Порожній рядок = `"- ↵"`/`"+ ↵"`.
  (Unicode тут — суто естетика для `≪`/`≫`; унікальність несе fence-тег + all-or-nothing.)
- **`§2.2.8` vs `§2.2.4(9)` — ✅ ЗНЯТО:** не дефект, а вибір джерела істини. **`§2.2.8` канонічна** (повніша,
  детальніша модель станів focused×empty×last-line); `§2.2.4(9)` узгодити з нею.

### 3.4 Що V2 робить ПРАВИЛЬНО, лишаючи поза собою
V2 свідомо не чіпає recovery/commit — і це правильно, бо вони representation-independent (перевірено:
`exit-commit.ts` приймає `base`/`sibling` рядки, `fromEditorModel` — лише в коментарях). Варто лише додати в
`DIFF-EDITOR.md` один явний рядок: «модель §1 замінено на V2; §5 commit/recovery — representation-independent,
без змін», щоб поділ був задокументований, а не неявний.

### 3.5 CM6-рекогносцировка §2.2.9 (проведено 2026-06-12) — scenario-2 ОБРАНО
Питання: чи scenario-2 (резолюція = «paste» + filter-rewrite) життєздатна й чиста для UNDO/REDO + persistent
replay у встановлених `@codemirror/state 6.6` / `commands 6.10`. Дві лінії доказів:

**(1) Існуючий код уже містить цей патерн** (`diff-pane.ts`):
- `collapseGuard` (814-838) — `transactionFilter` ПЕРЕПИСУЄ транзакцію в composed-spec з `{changes, effects:
  [setDiffPaneState…], selection, scrollIntoView}`. Це і є «paste→rewrite-зі-структурним-ефектом».
- `detectSpanningResolve`/`rebuildSpanningResolve` (730-805) — детектує region-spanning replace і перебудовує
  структуру в normal → це resolution-as-region-replace, **уже реалізована для вільних правок**.
- `structureHistory` (`invertedEffects`, 674) — версіонує структурне поле через undo/redo.
- `sentinelGuard` (687) — фільтр БАЧИТЬ вставлений текст (доказ, що paste проходить через `transactionFilter`).

**(2) Емпіричний spike** `tests/diff2/spikes/v2-resolution-paste-spike.test.ts` (3/3 PASS) — мінімальний CM6 з
structure-полем + history(newGroupDelay:0) + invertedEffects + resolutionFilter. Доведено:
- **A.** Програмний «paste» (transaction з `userEvent:"input.paste"`, БЕЗ OS-clipboard) проходить через
  `transactionFilter` — `filterSawPaste === true`.
- **B.** Фільтр переписує його в composed-spec з `setStructure`-ефектом (doc + поле змінюються в ОДНІЙ tr).
- **C.** `history({newGroupDelay:0})` → резолюція = ОДИН undo-крок.
- **D.** `undo` повертає І doc, І структурне поле (`invertedEffects`); `redo` відновлює обидва.
- **E.** Replay детермінований: той самий вхідний текст → той самий doc + поле.

**Висновок:**
- **scenario-2 ОБРАНО** як канонічна резолюція. **OS-clipboard для резолюції НЕ потрібен** — достатньо
  dispatch-нути replace-транзакцію з `userEvent:"input.paste"`.
- `history.jsonl` блок резолюції = **plain-text region-replace**; replay = re-dispatch через той самий фільтр →
  структура (RangeSet) деривується. (Шаблон §2.2.7 потрібен лише для ОКРЕМОЇ фічі — user-facing copy/paste
  diff-групи §2.2.6/2.2.7, де paste-back теж покривається patterns sentinelGuard/collapseGuard.)
- У V2 `Segment[]`+`setDiffPaneState` стають RangeSet-полем + його ефектом; патерн фільтр-rewrite +
  invertedEffects переноситься 1:1.

---

## 4. Чи дійсно «оптимальніша архітектура і краще визначено»? (чесна відповідь)

- **Прибирає необґрунтовану складність:** zero-width `Segment[]`, `growIdx`, inclusive/exclusive edge-tuning,
  auto-collapse coordinate-machinery, ручний `mapPos`, `\0/\1` сентинели. Усе це — accidental complexity від
  відсутності term-`\n`. ✅ Це і є оптимізація архітектури.
- **Покращує те, що раніше працювало погано:** рендер empty-ver і навігація крізь приховані рядки (старий
  `height:0` без компенсації → баги #1/#16/#17) стають коректнішими на здоровішій моделі. ✅
- **Єдиний залишковий ризик — тестованість геометрії**, і він НЕ новий (успадкований від старої моделі):
  device-gate обов'язковий. ⚠️
- **Краще визначено:** МОДЕЛЬ — так, чіткіше за старий §1. Те, що §2–§5 `DIFF-EDITOR.md` ще треба адаптувати під
  неї — не «невизначеність V2», а заплановані правки решти спеки (поправка користувача: V2 замінює лише модель).
  Перед кодом лишається усунути локальні дефекти §3.3.

**Підсумок (оновлено 2026-06-12 після правок користувача):** V2 — правильний НАПРЯМ (term-`\n` + RangeSet +
minimal-edit resolution розв'язують реальні баги). Після додавання `§2.2.11` (split) + `§2.2.12` (zero-size) +
фіксу `§2.2.4(9b)` спека МОДЕЛІ практично готова. Лишилось **одне** перед кодом: рішення по `§2.2.9`
(scenario-1 vs scenario-2) — research-item, не блокер для решти.

---

## 5. Розв'язка міграції (РІШЕННЯ, яке треба ухвалити першим)

### Варіант A — Minimal-bridge (РЕКОМЕНДОВАНО)
Замінити ЛИШЕ представлення; зберегти польово-загартований механізм персистентності.

- **Переписати:** `editor-model.ts` → нова RangeSet-модель; `diff-pane.ts` (StateField/filters); `decorations.ts`,
  `markers.ts`, `line-numbers.ts`, `selection-rules.ts`; `joined-doc.ts` split/build (новий split над RangeSet,
  build переиспользує jsdiff-логіку).
- **Адаптувати (механізм лишити, формат блоку оновити):** `history-log.ts`, `history-replay.ts`, `cursor-store.ts`.
- **Зберегти БЕЗ ЗМІН:** `exit-commit.ts` (7-step + A–K recover + modify-in-place), `autosave-store.ts`,
  `onload-recovery.ts`, `autosave-cleanup.ts`, усі `trash-*`, `synthetic-detector.ts`, `conflicts-list.ts`,
  `toolbar-conflicts.ts`, `reopen-action.ts`, `recovery-dialog.ts`.
- **Чому виграє:** «повна заміна заскладної архітектури» = заміна ПРЕДСТАВЛЕННЯ (саме воно заскладне). Recovery-код
  коштував багів #3 і #5, щоб загартувати — переписувати його = re-litigate вирішене. Поважає CLAUDE.md «чіпай
  тільки те, що мусиш».
- **Доказ representation-independence:** `exit-commit.ts` приймає `base`/`sibling: string` і пише байти через
  `done.json`/`commit7Step`; `fromEditorModel` — лише в коментарях. ✅

### Варіант B — Повний rewrite
V2-представлення канонічне; заново описати split/history/replay/commit з нуля.
- **Коли виправдано:** лише якщо виявиться, що персистентний шар НАСПРАВДІ залежить від форми структури глибше,
  ніж «структура у блоці history». Поки що доказів цього немає.
- **Ціна:** викинути ~2k рядків загартованого recovery + його crash-resilience тести. Високий ризик регресій у
  єдиній частині, що зараз працює надійно.

> **Рекомендація: Варіант A.** Він буквально виконує запит користувача («замінити заскладну архітектуру»), бо
> замінює саме заскладну частину, не чіпаючи надійну.

> **Зворотна сумісність — НЕ потрібна** (єдиний користувач, 2026-06-12): у переписуваних частинах — чистий
> розрив, без compat-шимів і dual-support; старий код представлення видаляємо повністю; on-disk формати
> (`meta.json`/`history.jsonl`/autosave-сесії) можна викидати, без міграцій. Це НЕ змінює Варіант-A (він про
> збереження загартованої recovery-ЛОГІКИ, не про on-disk compat) — лише прибирає весь міграційний код.

---

## 6. План рефакторингу (фази, sequenced tightest-constraint-first)

### Фаза 0 — Дозакрити спеку V2 (паперова, перед кодом)
- [x] `§2.2.4(9b)` → `current_range.to` (зроблено користувачем).
- [x] `split()` визначено → V2 `§2.2.11`.
- [x] Zero-size → V2 `§2.2.12` (+ EOL-less останній рядок: варіант (a), як у `editor-model.ts:134-163`).
- [x] Clipboard `.....` — однозначність підтверджено (фіксований 5-префікс + all-or-nothing).
- [x] `§2.2.8` — канонічна над `§2.2.4(9)`.
- [x] **`§2.2.9` → scenario-2** (CM6-рекогносцировка §3.5 + spike 3/3 PASS). history-блок = plain-text
      region-replace; replay = re-dispatch через filter; OS-clipboard для резолюції НЕ потрібен.
- [x] Інтеграційний контракт → **DIFF-EDITOR.md §0** (написано 2026-06-12; шви §0.2, інваріанти §0.3,
      gate-спайки §0.4). Включно з «exit-commit/recovery/trash/autosave — representation-independent, без змін».
- [x] **Reconcile V2 §2.2.9** — scenario-2 виведено як «ОСНОВНИЙ СЦЕНАРІЙ» (region-replace), scenario-1 →
      «варіант 2, КОНЦЕПТУАЛЬНА ІЛЮСТРАЦІЯ superseded, НЕ шлях реалізації» (off-by-one в ньому неактуальні).

### Фаза 1 — GATE-СПАЙКИ
**✅✅ 1a ГЕОМЕТРІЯ-GATE ПРОЙДЕНО (Playwright/Chromium, esm.sh CM6 6.x, 2026-06-12) — модель життєздатна.**
Прогнано в реальному Chromium (heightmap + `moveVertically`), весь real-layout кластер у ОДНОМУ живому редакторі:
- **TODO #1 (line-stealing) НЕ відтворюється:** 11 doc-рядків → 11 rendered, БЕЗ фантома; `≫` block-widget з
  `side:-1` НЕ краде `Decoration.line` наступного normal (`beta`/`gamma` лишились `cls=""`); gutter 1:1, без зсуву.
- **height:0** працює: усі 4 термінальні рядки рендеряться 0px; empty-ver термінал колапсує, коли каретки нема.
- **⭐ Native `moveVertically` САМ пропускає height:0-рядки** — каретка НІКОЛИ не застрягає на прихованому
  (`onCollapsedLine:false`, `caretH:17` на КОЖНОМУ кроці Down: L1→R1→beta→R2→gamma). **Велике спрощення:
  §2.2.4(9) ручна nav-компенсація для НЕпорожніх терміналів — НЕ ПОТРІБНА; лишається тільки empty-ver
  «stop-to-enter» через §1.8.a-активацію.**
- **⭐ Структура-механізм (1a-pin РОЗВ'ЯЗАНО):** generic `StateField<RangeSet>` з `VerRV {startSide:-1,endSide:1}`
  РОСТЕ inclusively через `RangeSet.map` — empty-ver `[19,20)`→`[19,22)` над `"X\n"`; sibling зсунувся; interior
  edit росте на +1. Тобто окремий field працює (не лише DecorationSet з 1b) — обидва варіанти валідні.
- **changeFilter terminal-protection** працює: видалення термінального `\n` (idx 9) заблоковано.
- ⏳ selection-over-hidden: треба `drawSelection()` extension (як стара реалізація, TODO §6.9) — НЕ екзистенційно.
- Харнес: `window.__cm`/`window.__h` у Playwright-сесії (esm.sh, без локального білда). Скрін: `/tmp/diff2-1a-harness.png`.

**Додаткові 3 проби (advisor, warm harness, 2026-06-12):**
- ✅ **Wrapped-line nav** — Down крокує по візуальних рядках довгої (wrap) ver-лінії, тоді пропускає height:0-термінал
  → наступний content. Wrapped × height:0 × moveVertically композуються нативно.
- ✅ **Delete-to-empty** (зворотне до 1b-росту) — видалення контенту ver-блоку мапить range у width-1 `[F,F+1)`,
  термінал `\n` виживає (changeFilter), стає коректним empty-ver. «drop structure» валідовано в ОБИДВА боки.
- ✅ **Empty-ver keyboard-ENTRY — РІШЕННЯ (a) ОБРАНО користувачем + ВАЛІДОВАНО end-to-end (2026-06-12):**
  повне керування клавіатурою + миша/тач. `moveVertically`-override (`cursorVert`, ~10 рядків): обчислити native
  ціль; якщо рух перескочив empty-ver-позицію (`r.to-r.from===1`, `r.from` строго між cur і native) — поставити
  каретку НА неї (стоп). Доведено: **реальний** `ArrowDown` з `beta` → head 19 (empty-ver), рядок розгорнувся
  (h:20), каретка видима; наступний `Down` лишає; `Up`-дзеркало стопить і лишає; непорожні термінали native
  пропускає сам. `Prec.highest` keymap. **Покриття всіх клавіш входу (валідовано real-key + проби):**
  - **`Right`/`Left`** — горизонтальний рух position-based → заходить у empty-ver **ПРИРОДНО** (Right з кінця
    попереднього normal → 19; Left з початку наступного normal → 19), БЕЗ override; decoField розгортає сам.
  - **`Up`/`Down`** — geometry-based → override `cursorVert(fwd)`: native landing (heightmap САМ враховує height:0)
    + **snap (стоп) до першого empty-ver** у `(cur, nativeLanding)`. real-key Down→19 ✅.
  - **`PgUp`/`PgDn` — JUMP-PAGE (рішення користувача 2026-06-12), БЕЗ force-stop:** native повна сторінка; розгортає
    empty-ver ЛИШЕ якщо ВИПАДКОВО приземлився на нього (decoField). Досяжність empty-ver зберігають Down/Up (стоп) +
    Right/Left. Зберігає сенс «сторінки» (інакше PgDn «повзе» в конфлікт-щільному файлі). force-stop-варіант
    (cursorVert для Pg) теж feasible (проба: native→30, override→19) — ВІДХИЛЕНО на користь jump-page.
  - **Уточнення (користувач — моя неточність виправлена):** «count ranges jumped» НЕ зникло цілком — для Down/Up
    розпадається на (i) геометрію (heightmap) + (ii) стоп-детекцію (position-filter `f>cur && f<nat`).
  - Миша/тач → §1.8.a click-активація (як стара реалізація). NB: override має зберігати goalColumn — у проді.
  - NB heightmap measurement-based → коректний після рендеру (1-кадрова затримка на свіжому collapse — edge).

**Висновок:** Фазу 2 (build/split/round-trip) НЕ блокує ніщо. Геометрія/нав/ріст/протекція доведені; fork empty-ver-entry
— рішення перед Фазою 3 (рекомендація (b)). drawSelection — деталь Фази 3.

---

**1a (опис гейту — для повноти).** ПРОГНАТИ ЧЕРЕЗ PLAYWRIGHT (не device-only!). happy-dom не має heightmap/layout,
АЛЕ `mcp__MCP_DOCKER__browser_*` = реальний Chromium з справжнім heightmap + `moveVertically`. Це і є правильне
середовище для екзистенційного gate; фізичний пристрій — лише для mobile-touch-полишу пізніше.
- [ ] Standalone CM6-харнес (esbuild крихітну сторінку АБО `browser_evaluate` + CM6 6.x з esm.sh), драйв
      `browser_press_key`, інспекція геометрії `browser_evaluate` (`view.coordsAtPos`, висоти DOM-рядків,
      `view.state.selection` після стрілок).
- [ ] Тестувати ВЕСЬ real-layout кластер РАЗОМ в одному живому редакторі (стара модель померла саме тут — TODO #1:
      `side:1` block-widget вкрав `Decoration.line` → фантомний рядок + зсув gutter + пропуск навігації):
   - block-widget маркери `≪`/`==`/`≫` рендеряться, НЕ крадучи `Decoration.line` сусіднього рядка;
   - `height:0` toggle на focus/blur порожнього ver;
   - `moveVertically` крізь приховані термінальні рядки (`§2.2.4(9)`);
   - selection малюється поверх прихованих рядків;
   - **terminal-protection (`changeFilter`) І inclusive-growth в ОДНІЙ транзакції** (1b перевірив `.map()`
     ІЗОЛЬОВАНО — тут перевіряємо реальний `StateField + changeFilter + map` pipeline разом).
- [ ] Якщо кластер тримається → пишемо `editor-model.ts` впевнено. Якщо ламається → block-replace-decoration
      замість height:0 ДО написання моделі.

**1a-pin. Рішення про механізм структури (перед Фазою 2).** Спайк 1b довів ріст на `Decoration.mark({inclusive})`
ізольовано. V2 §2.2.2 NOTE каже структура = `StateField`, що робить `value = value.map(tr.changes)` — ГЕНЕРИЧНИЙ
RangeSet, не обов'язково DecorationSet. Generic `RangeValue` росте inclusively ЛИШЕ якщо його `startSide`/`endSide`
відтворюють те, що `Decoration.mark` ставить сам. **Вибрати явно:** структура = САМ decoration-set (1b-proven), чи
окремий `StateField<RangeSet>` + `setStructure`-ефект (тоді 1a-харнес мусить ганяти реальний pipeline, не `.map()`).

**1b. Replay-без-структури спайк (unit, vitest — НЕ device): ✅ PASS (2026-06-12).**
- [x] `tests/diff2/spikes/v2-replay-empty-ver-spike.test.ts` (4/4) — typing у щойно-порожній ver відтворюється
      байт-точно з `change` БЕЗ збереженої структури; `DecorationSet.map` детермінований без `activeEmptyVer`;
      replay==live. **Передумова для коду:** модель = **terminal-inside** ≥1-width ranges (виправити V2 §2.2.2
      `Range(7,7)`→`Range(7,8)`). «drop structure» → з PROVISIONAL у ВАЛІДОВАНО (для empty-ver-typing).

### Фаза 2 — Ядро представлення (TDD, unit-тестоване)
- [x] **`src/diff2/diff-model.ts` — `buildModel`/`splitModel` (terminal-inside, plain `VerRange[]`, jsdiff).** ✅
      19/19 round-trip + invariants (`tests/diff2/diff-model.test.ts`): identical, modify-modify, delete/modify обидва
      боки, 0-byte обидва боки, both-empty, EOL-less both/one, multi-line, multi-group, leading/trailing diff,
      empty-line-content, whole-file. EOL-less variant-(a) + 0-byte падають з round-trip самі (split дропає рівно той
      термінал, що build додав). tsc-clean. (НЕ-CM6, чистий — RangeSet-обгортка = Фаза 3.)
- [ ] **Рішення-pin: структура = САМ DecorationSet чи окремий `StateField<RangeSet>`.** 1a довів ОБИДВА (generic
      `VerRV{startSide:-1,endSide:1}` росте через `.map`). Вибрати при написанні `diff-pane.ts` (Фаза 3).
- [ ] Видалити старі `joined-doc.ts`(`\0/\1`)/`editor-model.ts`(`Segment[]`) — коли Фаза-3 wiring перемкне споживачів.
- [ ] collision `\0/\1` більше не потрібен (немає сентинелів) — прибрати `findSentinelCollision` зі шляху відкриття.

### Фаза 3 — DiffPane + фільтри (частина device, частина unit)
- [x] **`src/diff2/diff-structure.ts` — спина (state-level, unit-tested 10/10).** `VerRangeValue` (inclusive
      startSide=-1/endSide=1) + `to/fromRangeSet` + `setStructure`/`structureField` (map через кожну tr) +
      `terminalProtected`/`terminalProtectionFilter` (§2.2.4(1,3)) + `cursorVertTarget` (§2.2.4(9) stop, pure).
      Переносить валідований 1a/1b browser-прототип у реальний код. `tests/diff2/diff-structure.test.ts`: growth у
      empty-ver через field.map, interior-grow+shift, setStructure-replace, terminal protection, cursorVert. tsc-clean.
- [~] **`src/diff2/diff-pane-v2.ts` — view-зборка (render+nav спина DONE, 4/4 happy-dom+state).** `buildDecorations`
      (markerSpecs+verLineDecisions → CM6 `DecorationSet`: block-widget маркери + ver-class + collapse + glyph) +
      `decorationsField` + `diffNavKeymap` (`Prec.highest` Up/Down→`cursorVert`; Shift+arrow/PgUp/PgDn → defaultKeymap)
      + `createDiffPaneState`/`mountDiffPaneV2` (seed structure через `.init()`). Дзеркалить 1a-прототип. Новий файл —
      стане `diff-pane.ts` при wiring (старий §1 видалити). `tests/diff2/diff-pane-v2.test.ts`.
- [x] **`src/diff2/diff-edits.ts` — editing-filters (8/8: pure + dispatch-level).** `autoNewlineInserts`/
      `autoNewlineFilter` (§2.2.4(2) — transactionFilter дописує `\n` перед терміналом, compose+caret-map; типування
      в empty-ver → `"w\n\n"`, split round-trips) + `externalGuardOk`/`externalGuardFilter` (§2.2.5(1) — блок
      single-char Delete роздільника normal→group). §2.2.5(2) = вже terminalProtectionFilter. Wired у
      `createDiffPaneState`. **§2.2.12(a) EOL-less edge (виявлено користувачем):** auto-`\n` ПРОПУСКАЄ останню групу
      (ту, чий `ver2.to===doc.length` — після неї нема жодного normal), бо її ver-blocks = хвости файлів, останній
      рядок може бути без `\n`. `diff-decorations` теж: collapse ТІЛЬКИ голий термінальний `"\n"`-рядок (порожній);
      EOL-less останній рядок (термінал = рядок із контентом) + порожній CONTENT-рядок — ВИДИМІ; `↵` на EOL-less не
      малюється (він terminal). Тести на обидва боки. **Лишилось:** selection-legalization §2.2.6 + shift+arrow nav;
      кнопки на маркерах §1.9 (Phase 4); повна browser-валідація бандла (device-gate).
- [x] **`src/diff2/diff-selection.ts` — selection-legalization (13/13: pure + dispatch).** `legalizeSelection`
      (§2.2.4(5): плоске виділення в межах одного ver-block, термінал `\n` ніколи не входить; §2.2.6: перетин межі
      diff-group → ВСЯ група атомарно, через expand `[lo,hi]` на кожну зачеплену групу; Ctrl+A → весь doc випадає
      сам) + `groupsOf` + `selectionLegalizeFilter` (transactionFilter на pure-selection tr; курсор не чіпає).
      Wired у `createDiffPaneState`. Shift+arrow проходить через defaultKeymap → легалізується фільтром (без
      empty-ver-stop під час drag — прийнятно). `tests/diff2/diff-selection.test.ts`.
- [x] **`src/diff2/diff-decorations.ts` — decision-rules (pure, unit-tested 7/7).** `verLineDecisions` (§2.2.8:
      collapse non-empty-terminal завжди / empty-terminal коли каретка off; `↵`-glyph на ver-рядках крім terminal) +
      `markerSpecs` (§2.2.2: open/mid/close, `side:-1` TODO #1-safe, `side:1` лише для group-в-кінці-doc).
      `tests/diff2/diff-decorations.test.ts`. CM6 `Decoration`-збірка + геометрія (height:0=0px, маркери не крадуть
      `Decoration.line`) — у diff-pane.ts (1a-validated). Лишилось: split-gradient `=====`, кольорові gutter-cells,
      кнопки на маркерах (view-layer).
- [ ] `line-numbers.ts`: on-the-fly формула `§2.2.10` (з урахуванням прихованих term-рядків), right-align (TODO #18).

### Фаза 4 — Резолюція + навігація
- [ ] `chunk-actions.ts`/`conflict-merge-all.ts`: резолюція = in-place delete діапазонів + plain-text, з cursor
      на початок resolved-групи (TODO #9). Реалізувати ОДИН обраний варіант `§2.2.9`.
- [ ] Навігаційна компенсація `§2.2.4(9)` (delegated до moveVertically) — device-перевіряна.
- [ ] Hotkeys `§1.9`/`§2.2.9`: `[Keep]/[Apply]/[Apply Both]/[Remove]/[Join]` + bulk toolbar.

### Фаза 5 — Адаптація персистентності (механізм лишити)
- [ ] `history-log.ts`: блок `{seq, at, change, structure, sum}` — `structure` тепер RangeSet-серіалізація.
- [ ] `history-replay.ts`: replay будує RangeSet через `setDiffPaneState`; зберегти інваріант
      «replay N → undo k == replay N−k» + undo-truncate (TODO #5).
- [ ] `cursor-store.ts`: без змін у механізмі (2-слот ping-pong), лише clamp до нового doc.
- [ ] Перевірити: `diff-pane.modelNow()` → `split(...)` → `base/sibling` → `commit7Step` без змін у `exit-commit.ts`.

### Фаза 6 — Нові фічі V2
- [ ] Clipboard diff-group `§2.2.7` (з escape-правилом).
- [ ] Multi-cursor off `§2.2.4(10)`.
- [ ] Закрити TODO-баги, які V2 адресує: #11 (sub-diff точність — окремо, word-level-diff), #12/#13 (Join текст),
      #14 (selection колір dark), #16/#17 (empty-ver рендер), #18 (gutter align).

### Фаза 7 — Device-gate «done»
- [ ] Manual + Playwright проходи (світла/темна тема, mobile): навігація, рендер, резолюція, recovery після краху.
- [ ] «Done» = device pass, НЕ лише зелений unit-suite.

---

## 7. План тестів (дзеркалить розв'язку міграції)

### Переписати (representation-залежні)
- `editor-model.test.ts`, `build-split-roundtrip.test.ts`, `save-reopen-stability.test.ts`
- `empty-ver-nav.test.ts`, `empty-ver-activation.test.ts`, `init-empty-ver.test.ts`
- `selection-rules.test.ts`, `selection-shapes.test.ts`, `diff-pane-selection.test.ts`
- `auto-collapse.test.ts`, `more-edge-cases.test.ts`, `focus-leave-normalization.test.ts`
- `newline-glyph.test.ts`, `diff-pane-render.test.ts`, `diff-pane-actions.test.ts`, `hotkeys.test.ts`
- `large-docs.test.ts`, `free-edit-resolve-bug.test.ts`, `stage1-review-findings.test.ts`

### Адаптувати (механізм той самий, формат блоку/структури новий)
- `history-log.test.ts`, `history-replay.test.ts`, `history-replay-stress.test.ts`, `diff-pane-replay.test.ts`
- `w2-history-feed.test.ts`, `undo-redo.test.ts`, `undo-truncate.test.ts`, `cursor-store.test.ts`

### Зберегти БЕЗ ЗМІН (representation-independent)
- `exit-commit.test.ts`, `exit-toctou.test.ts`, `diff-edit-view-commit.test.ts`, `w4c-resume.test.ts`
- `autosave-id*.test.ts`, `autosave-session-start.test.ts`, `autosave-root.test.ts`, `autosave-cleanup.test.ts`
- `onload-recovery.test.ts`, `recovery-dialog.test.ts`, `reopen-*.test.ts`
- `crash-resilience/exit-commit-recovery-matrix.test.ts`, `crash-resilience/autosave-session-start-crash.test.ts`
- усі `trash-*.test.ts` + `crash-resilience/trash-*`, `synthetic-detector.test.ts`, `word-level-diff.test.ts`,
  `strip-conflict-suffix.test.ts`

### Нові тести
- `split()` round-trip над RangeSet (0-byte, empty-ver, modify-vs-delete, всі 4 типи груп).
- Захист термінального `\n` (changeFilter не дає видалити; auto-`\n` відновлення).
- Зовнішні guard-и `§2.2.5` (Delete перед групою / Backspace після).
- Clipboard `§2.2.7` round-trip + escape.
- **Device/Playwright** (поза unit): навігація крізь height:0, gutter-кольори, рендер empty-ver.

---

## 8. Що зробити ПЕРШИМ

1. **Ухвалити розв'язку §5** (Minimal-bridge vs Full-rewrite) — рекомендація: Minimal-bridge.
2. **Дозакрити дефекти спеки §3.3 + інтеграційний контракт §6 Фаза 0** — інакше V2 не імплементовна.
3. **Device spike §6 Фаза 1** — gating-перевірка height:0 + moveVertically ДО продакшн-коду.

Лише після 1–3 запускати Фази 2+.
