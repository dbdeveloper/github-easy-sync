# Diff-Edit Widget — Implementation Plan

> Документ описує комплексне переосмислення Diff-Edit / Conflict-View UX
> для плагіна `github-easy-sync`. Базується на діалозі автора з Claude
> Code, проведеному 2026-05-17. CLAUDE.md явно фіксує: "the conflict-view
> UX is the one area still openly known to be primitive" — цей план
> закриває цю дірку.

## 📛 Назва підпроекту: `diff2`

Цей підпроект отримує канонічну назву **`diff2`** — по аналогії з
існуючим `sync2` (модуль sync-движка). Іменування:

- **Модуль:** `src/diff2/` (новий каталог поруч з `src/sync2/`).
- **View type ID:** `diff2-edit-view` (замінює тимчасову робочу назву
  `sync2-diff-edit`, яка фігурувала в чернетці плану).
- **Імена класів/файлів** усередині `diff2/` — без префіксу `diff2-`
  (бо namespace вже даний папкою): `events.ts`, `trash-store.ts`,
  `diff-pane.ts`, `diff-edit-view.ts`, `sync-summary-modal.ts`,
  `history-list.ts`, `deleted-list.ts`, `external-diff.ts`.
- **Obsidian commands prefix:** "Diff2: …" (наприклад,
  `Diff2: Compare two files…`, `Diff2: Open Diff-Edit`,
  `Diff2: Next chunk`).

Поділ обов'язків між `sync2/` і `diff2/`:
- `sync2/` — sync engine, як зараз. Власник `ConflictStore`
  (генерує конфлікти під час sync). Лишається без структурних змін;
  точкові додатки на event-emit-и при мутаціях.
- `diff2/` — Diff-Edit widget. **Споживач** `ConflictStore`,
  **власник** `TrashStore` та `DiffPane` (CM6 редактор), власник
  pubsub-каналу `DiffEditEvents`. Підписується на sync-події і
  vault-події.

Архітектурний інваріант: `diff2/` залежить від `sync2/` (читає
конфлікти, спостерігає sync-завершення), але `sync2/` **не залежить**
від `diff2/`. Це дає змогу зібрати плагін без `diff2/` (наприклад,
для регрес-перевірок) і випустити `diff2/` як майбутній окремий
плагін, якщо колись з'явиться сенс.

## ⚠️ Принципи реалізації (обов'язкові)

**Цей розділ — обов'язковий до прочитання перед будь-якою кодовою
зміною за цим планом.**

1. **Scope — суворо в межах цього плану.** Застосовувати **тільки**
   зміни, які стосуються Diff-Edit widget і пов'язаних з ним вимог
   (R1–R7). Не причісувати інший код "заодно", не рефакторити
   суміжні модулі, не "виправляти що очі бачать".

2. **Не порушувати роботу основного плагіну.** `github-easy-sync` —
   це working production-плагін з 429 unit-тестами і ~106 integration-
   тестами (серії A–L, див. CLAUDE.md). Уся існуюча поведінка sync-
   рушія (bootstrap, adoption, normalize, incremental, atomic
   conflicts, multi-device, drift, settings, auth, manifest,
   accumulate) має лишитись **бітово ідентичною** після реалізації
   цього плану. Будь-який regression-сигнал у існуючих тестах =
   стоп-сигнал.

3. **Мінімізувати модифікації за межами Diff-Edit.** За замовчуванням
   нові файли під `src/diff2/` (новий каталог підпроекту) +
   точкові правки у `src/main.ts` для wire-up. Якщо план вимагає
   зміни у `sync2-manager.ts`, `change-detector.ts`,
   `conflict-store.ts`, `client.ts` тощо — **виокремлювати у
   найдрібніші можливі діффи** і верифікувати кожен через існуючі
   тести (`pnpm test` + `pnpm test:integration`).

4. **Тести — додаємо, не заміняємо.** Нові acceptance/unit-тести
   (A1–A23) — додаткові файли. **Не модифікувати** існуючі тести
   серій A–L без явного дозволу автора. Якщо існуючий тест починає
   падати — це означає, що зміна порушила фіксовану поведінку, а не
   що тест "застарілий". Шукати корінь проблеми у новому коді.

5. **Якщо все ж потрібно змінити існуючий файл/тест** — зупинитись,
   **запитати дозволу автора** з конкретним обґрунтуванням ("для
   реалізації R-X треба змінити Y, ось альтернативи, ось ризики"),
   і вносити зміну дуже ретельно з повним прогоном тестів до і
   після.

6. **Phase-by-phase, не "великий вибух".** Реалізація йде фазами
   (Phase 0 → Phase 8). Кожна фаза — окремий PR, що сам по собі
   не ламає main. Розгортання інкрементально, з можливістю
   зупинитись на будь-якій фазі і мати працюючий плагін.

7. **CLAUDE.md як джерело істини про існуючу поведінку.** Перед
   зміною будь-якого існуючого механізму — перечитати відповідний
   розділ CLAUDE.md і відповідні integration-тести. Якщо знайдена
   суперечність план-vs-CLAUDE.md — виносити обговорення, не
   "вирішувати на ходу".

## Мотивація

Поточний стан:
- Під час sync-у на кожен 3-way-merge conflict вискакує блокуюча
  модалка `ConflictModal` з чотирма опціями (Resolve now / Later /
  Merge into one / Defer ALL). Це дратує і неефективно — групові
  операції повинні бути в робочому tab-і, а не у блокуючому діалозі.
- Існує `ConflictView` (`sync2-conflict-view`) з DiffPane, але вона
  обмежена сценарієм "вирішити готовий конфлікт" — не дозволяє ані
  порівняти довільні два файли, ані подивитись історію змін, ані
  відновити видалене. Кром того, вона не працююча у багатьох сценаріях.
- Авто-resolve конфлікту, коли користувач сам довів основний файл і
  його sibling до однакового стану поза Diff-Edit редактором, **не
  спрацьовує** — конфлікт лишається у списку та статусбарі.
- Видалене (як локально перед sync-ом, так і назавжди на GitHub-і)
  не можна повернути без сторонніх інструментів.

Цілі:
- Прибрати блокуючу per-file модалку. Замість неї — одна summary
  модалка у кінці sync-у з переходом на Diff-Edit.
- Перетворити Diff-Edit на **уніфікований інструмент** для всіх
  пов'язаних задач: конфлікти, порівняння довільних файлів, історія
  змін, відновлення видалених. Форма UI обговорюється окремо (див.
  розділ **TBD**).
- Усі видалені у плагіні артефакти повинні зникати з усіх UI/manifest
  каскадно і автоматично через тригери.

---

## Вимоги (зафіксовані з користувачем)

### R1. Заміна per-file конфліктної модалки

**R1.1.** Видалити блокуючу логіку `ConflictModal` під час drain.
Sync2-manager при отриманні конфлікту повинен **завжди** йти шляхом
"create sibling + ConflictStore.create() + продовжити". Тобто
`onConflict` callback у `main.ts` (`handleSync2Conflict`) перестає
відкривати модалку і повертає `{ kind: "deferred" }` безумовно.
Прапорці `suppressConflictModals`, `openConflictViewAfterSync`,
`resolveNowPath` стають непотрібними і видаляються.

**R1.2.** Після завершення `drain()`, якщо за час цього sync-у було
створено хоча б один новий запис у ConflictStore, показати **одну**
summary-модалку:

> **New conflicts have appeared!**
>
> You now have `NNN` unresolved conflicts.
>
> `[ OK ]`    `[ Go to Diff-Edit ]`

де `NNN` — поточна повна кількість записів у ConflictStore (тобто сума
старих + нових). Кнопка "Go to Diff-Edit" відкриває Diff-Edit tab
(view type, що замінить `sync2-conflict-view`).

**R1.3.** ConflictModal (файл `src/sync2/views/conflict-modal.ts`)
видалити цілком разом з тестом `tests/sync2/conflict-modal.test.ts`.
"Merge into one" як **операція** не зникає — вона переходить у
Diff-Edit tab як кнопка над списком конфліктів (групова дія).
Логіка `conflict-merge-all.ts` лишається без змін.

### R2. Diff-Edit widget — функціональні режими і навігація

**Дві основні мети використання widget-у** (mental model для
користувача):

1. **Conflicts mode** — список pending конфліктів. Клік по конфлікту
   → diff-edit на весь tab між поточним файлом (ours) і його
   sibling-версією (theirs). Користувач resolve-ить через кнопки
   `[select]/[remove]` per chunk або групові `[Keep all local]` /
   `[Apply all remote]` тощо.

2. **File history mode** — список попередніх версій конкретного
   файлу (з GitHub або push-queue). Клік по версії → diff-edit на
   весь tab між поточним файлом (ours) і обраною історичною версією
   (theirs).

   Цей режим має **дві суб-поведінки** з перемиканням через
   **toggle-іконку у top toolbar** (напр., `🔒` коли read-only,
   `✏️` коли editable; точна іконка обирається при імплементації):

   - **Edit mode** (default, іконка `✏️`): працює як conflict
     resolution — chunk-action кнопки `[select]/[remove]` доступні,
     edits у поточному файлі зберігаються. Користувач може вибірково
     "повернути" частину старого тексту (наприклад, відновити
     випадково видалений абзац з 3 коммітів тому), не повертаючи
     весь файл.
   - **Reference mode** (toggle: `🔒`): **read-only** перегляд.
     Обидві сторони (current та historical) заблоковані від
     модифікації. Chunk-action кнопки та `[select]/[remove]`
     приховані. Залишаються:
     - Виділення тексту і **копіювання** (Cmd/Ctrl+C працює).
     - Навігація між chunk-ами (`[↑]`/`[↓]` у footer).
     - Кнопки `[Restore entire version]` (rewrite current file
       байтами обраної версії) та `[←]` back залишаються — це
       не "редагування", а атомарна операція над файлом цілком.
     - Візуальний індикатор: невеликий "Read-only" badge біля
       заголовка path, плюс трохи дімований фон pane-у.

   Default — Edit, бо це частіший сценарій. Reference mode для
   випадків "просто подивитись/скопіювати без ризику внести
   випадкову зміну".

   *Та сама toggle-іконка доступна у Compare mode* (R2.1) — для тих
   самих причин (хочу порівняти, але не редагувати). У Conflicts
   mode (R2.2) тоggle не доступний — там сенс саме у resolve, який
   потребує edit-у. У Deleted mode (R2.4) widget вже фактично
   read-only за замовчуванням (нема "ours" як такого).

**Інші два режими** (Compare any two, Deleted files) — корисні
доповнення (R2.1, R2.4), але **Conflicts** і **History** — це дві
основні стежки, заради яких widget існує.

Diff-Edit widget підтримує чотири функціональні режими (Conflicts /
Compare / History / Deleted) та **single-pane навігацію** між ними.

**R2.0. Single-pane shell.** На відміну від поточного two-pane
layout-у (`ConflictView` з лівою колонкою списку + правою з DiffPane),
новий widget — це **один tab без побічних колонок**. У будь-який
момент tab показує або:
- **list view** (список конфліктів / список історії / список видалених),
  на ширину всього tab-у, або
- **detail view** (один обраний файл — DiffPane з top-toolbar-ом
  для повернення назад до list view)

Перехід між list і detail — стрілкою `[←]` у toolbar детального
viewer-а (повернення в list); кліком по елементу списку (відкриття
detail для нього).

Причини відмови від двопанельного layout-у:
1. На мобільному екрані ліва панель забирає 30–50% ширини, що робить
  detail view нечитабельним.
2. Якщо користувач працює через зовнішній diff (R6), detail-частина
  взагалі не потрібна — він хоче бачити повноширокий список.
3. Узгоджена single-pane модель спрощує state-машину і відповідає
  Obsidian mobile-native поведінці (back-stack навігація).

**R2.1. Compare any two files.**

*Що порівнюємо*:
- два звичайні файли з vault (`a.md` vs `b.md`)
- файл vs sibling (`note.md` vs `note.conflict-from-...md`)
- файл vs trash entry (`note.md` vs видалений `note.md`)
- (desktop only) файл з vault vs файл з filesystem (вибраний через
  OS-нативний picker — наприклад, файл з іншого vault, або взагалі
  будь-який текст на диску).

*Точки входу*:
1. **Контекстне меню файлу** у file-explorer-і Obsidian: натиснути
   right-click (або long-tap на mobile) на файлі → пункт "Compare with…".
   Реєструється через `app.workspace.on('file-menu', cb)` стандартним
   API.
2. **Command palette**: команди "Diff-Edit: Compare two files…"
   (просить вибрати обидва), і "Diff-Edit: Compare active file with…"
   (active file = top, picker для bottom).
3. **Зсередини Diff-Edit widget**: режим Compare у мode-перемикачі
   (TBD-розділ про навігацію між режимами).

*File picker*:
- **Same-vault** (default, кросплатформово): `FuzzySuggestModal` зі
  списком `app.vault.getFiles()`. Так само як стандартний "Quick
  switcher" Obsidian. Працює на desktop і mobile однаково.
- **Filesystem browse** (desktop only): під списком fuzzy-suggest —
  кнопка `[Browse filesystem…]`. Клік відкриває Electron-нативний
  `dialog.showOpenDialog` через
  `require('@electron/remote').dialog` (або еквівалент). Обраний
  файл читається через `require('fs').readFileSync`. Gated на
  `Platform.isDesktopApp` — на mobile кнопка просто не рендериться,
  і весь filesystem-код лежить за лінивим `require()` (як R6 з
  child_process). Файл, обраний з filesystem, отримує "віртуальний
  path" `fs://${absolute-path}` для відображення у заголовку
  DiffPane; не імпортується у vault.
- **Cross-vault** як окремий концепт не виділяємо — фактично це
  довільний filesystem-файл, який desktop-picker покриває.

*Mobile-обмеження*: на iOS/Android доступ до файлів поза vault-каталогом
неможливий через sandboxing ОС. Mobile користувач може порівнювати
тільки два файли зі свого vault. Це обмеження платформи, не плагіна;
fix не передбачається.

*Режим відображення*: unified DiffPane (R7) у Compare-toolbar-варіанті
(R7.9c). Default — **Reference (read-only)** (✏️ toggle перемикає у
Edit). Per-chunk `[select]/[remove]` доступні в Edit mode (для тих
хто хоче синхронізувати один файл з іншим). Marker block-widgets
(`<<</===/>>>`) тут **не рендеряться** — нема "conflict context",
просто кольорове підсвічення diff-chunks + word-level highlight.

**R2.2. Conflicts list (повноширокий, list view).** Список усіх
sibling-файлів `*.conflict-from-*` з групуванням за оригінальним
vault path. Список займає **усю ширину tab-у**.

Зверху над списком — **toolbar з груповими операціями над усіма
конфліктами**:
- `[Keep all local changes]` — для всіх записів зберегти ours,
  видалити всі sibling-и (масовий take-ours).
- `[Apply all remote changes]` — для всіх записів перезаписати
  ours = theirs, видалити всі sibling-и (масовий take-theirs).
- `[Join all changes]` *(markdown only)* — для всіх md-записів
  викликати `conflict-merge-all.ts::mergeIntoOne()` каскадом
  (theirs додається як `> blockquote` callout під ours). Кнопка
  прихована або disabled, якщо у списку немає markdown-конфліктів,
  щоб не наводити користувача на помилку.

Кожен елемент списку клікабельний → перехід у **detail view** з
DiffPane (R7), де є додатковий top-toolbar з тими ж операціями, але
для одного файлу (R7.9-onepan).

**R2.3. File history** — для довільного файлу з vault показати
історію його змін. Джерела:
1. **GitHub** — список commit-ів, що змінили цей шлях. Потребує
   нової обгортки `GithubClient.listCommitsForPath(path, branch,
   {since?, perPage?, page?})` навколо
   `GET /repos/{owner}/{repo}/commits?path={path}&sha={branch}`.
2. **Push queue fallback** — якщо немає мережі або клієнт у
   `bare` стані, показати локальні pending-батчі (читання
   `.push-queue/<id>/vault/<path>` + meta).

Кожен елемент історії клікабельний → відкриває DiffPane (current vs
selected-version). У DiffPane при перегляді історії `theirsReadOnly:
true` (вже передбачено у DiffPane API). Кнопка "Restore this version"
у footer DiffPane — перезаписує current vault file байтами обраної
версії.

**R2.4. Deleted files (Recently deleted)** — той самий single-pane shell
(R2.0), що й Conflicts mode, але **спрощений detail view**.

*List view*: повноширокий список trash-entries + GitHub-recent-deletions
(уніфіковано, як описано в R3.6). Кожен елемент показує: vault path,
коли видалено, джерело (`local trash` / `GitHub history`), розмір.
Top toolbar:
- `[Empty trash]` — видалити ВСІ local-trash записи (без впливу на
  GitHub-restorable; ті залишаються доступними з repo).
- `[Refresh from GitHub]` — примусово витягнути свіжий
  `listCommitsForPath` для оновлення віддалених видалень.

*Detail view* (кліком по елементу): **read-only прев'ю**, що
використовує ту саму CM6-інфраструктуру, що й Diff-Edit (R7), але
у спрощеному режимі:
- **Без `<<</===/>>>` marker block-widgets** (нема двох сторін —
  файл просто видалений, є тільки одна версія: deleted content).
- **Без per-chunk action кнопок** (нема конфлікту).
- **Без word-level diff** (нема пари для порівняння).
- Документ показується як **plain markdown / text** з line numbers
  у gutter — як одностороння версія DiffPane.
- Заголовок: `<vaultPath> · deleted <ts> from <local trash> | <GitHub history>`.

Top toolbar (detail):
- `[←]` — back to list view.
- `[Restore]` — повернути файл за оригінальним path-ом. Якщо у vault
  вже існує файл з тим самим іменем (наприклад, користувач створив
  новий пізніше) — модалка "Файл вже існує. `[Overwrite]` /
  `[Restore as new name…]` / `[Cancel]`".
- `[Restore as…]` — окрема кнопка для безпечного відновлення під
  іншим іменем (одразу відкриває rename-промпт).

Diff-Edit widget (R7) **переюзовується**, але з прапорцем
`mode: "preview"` (на додачу до існуючого `mode: "merge"`, який буде
введений у Phase 7). Не окреме нове вікно, не окремий редактор.
Кодова база лишається єдиною.

**R2.5. Delete-vs-modify conflict — конфлікт без основного файлу.**

Сценарій: користувач локально видалив `note.md`. Одночасно на іншому
пристрої цей файл був модифікований. sync2-manager це бачить як
delete-vs-modify і викликає `onConflict` з `ours = ""` (порожньо =
видалення), `theirs = <remote content>`. ConflictStore створює запис
і sibling-файл `note.conflict-from-<remoteDevice>-<ts>.md` з theirs
байтами.

Унікальна особливість: **`vaultPath` файл відсутній у vault** (його
видалив користувач), але `siblingPath` присутній. Це єдиний випадок,
коли запис у ConflictStore вказує на vault path, що не існує.

*Візуалізація в list view (R2.2)*: цей запис показується з
**badge `[deleted locally]`** одразу після path-у, в italic
кольорі. Поведінка кліку та сама — переход у detail view.

*Візуалізація в detail view (R7)*: DiffPane рендериться нормально,
але ours-сторона порожня (0 рядків). Конфліктний блок виглядає так:

```
   | <<< Obsidian (Mac): [select][remove]
   | === [select All][remove All]
 1 +| <theirs line 1>
 2 +| <theirs line 2>
 3 +| <theirs line 3>
   | >>> GitHub (Phone): [select][remove]
```

Тобто верхній (red/ours) блок порожній — між `<<<` маркером і `===`
маркером немає жодного рядка. Це **природна** ситуація для нашої
розмітки і не потребує спеціальних винятків у CM6 коді.

*Семантика top-toolbar кнопок для delete-vs-modify*:
- `[Keep all local changes]` = "залишити видалення" → final = empty
  → vault file НЕ створюється; sibling + ConflictStore запис
  видаляються; видалення лишається у `batch.deletions` і дотягується
  на GitHub на наступному sync.
- `[Apply all remote changes]` = "відновити з GitHub" → final =
  theirs → vault file створюється з theirs контентом; видалення
  забирається з `batch.deletions`; sibling + запис очищуються.
- `[Join all]` *(md only)* — **сховано** для delete-vs-modify (нема
  ours щоб об'єднувати з; результат був би просто theirs).

*Auto-resolve T2 (R4)*: якщо користувач створює файл `note.md` у vault
вручну і він стає байт-рівним sibling-у — конфлікт resolve-иться
"resurrection"-шляхом (файл створено, видалення забрано з queue).
Edge case, але узгоджено з R4.

*sync2-manager уже підтримує* цей сценарій (CLAUDE.md: "Local-deleted
vs remote-modified"). Все що нам треба — коректно відрендерити у
DiffPane коли `ours === ""` і додати `[deleted locally]` badge у
list view.

**R2.6. Sync на файлі з pending конфліктами — refuse, не комітимо.**

Файли, у яких є хоча б один запис у ConflictStore, **не комітяться**
жодним зі sync-шляхів — ні через `Sync all`, ні через `Sync this file`.
Поки конфлікти не вирішені у Diff-Edit, файл лишається у поточному
стані у vault, але не йде на GitHub.

*Sync all*: файли з pending конфліктами **автоматично виключаються
з push-batch**. Sync інших (чистих) файлів проходить нормально.
Summary-модалка у кінці sync (R1.2) додає рядок "`K files skipped
due to pending conflicts`" — без окремих модалок.

*Sync this file* (на файлі з конфліктами): команда **відмовляється**
з пояснюючим Notice:

> Файл `<path>` має `N` pending конфліктів і не може бути
> синхронізований, доки вони не вирішені.
>
> `[ Cancel ]`   `[ Open in Diff-Edit ]`

Кнопка `[Open in Diff-Edit]` відкриває Diff-Edit tab у режимі
Conflicts list з фокусом на цьому файлі. Жодного "take local & sync"
shortcut — користувач свідомо проходить через resolve у Diff-Edit,
де він бачить що саме приймає / відкидає. Це усуває можливість
випадкової втрати remote-змін одним кліком.

*Sibling-файли вже у `.gitignore`* (через `gitignore-invariants.ts` —
секція, яку користувач не може видалити), тому push-у sibling-файлів
на GitHub нема — це окремий guarantee на рівні гитіґнору, не залежить
від поведінки sync-commands.

**R2.6.1. "Авгієві конюшні" — очікуване і чесне накопичення.**
Оскільки ми не комітимо файл з конфліктами, але pull продовжує
працювати, можлива ситуація: remote змінює `note.md` кілька разів,
поки користувач не resolved-нув попередній конфлікт. У такому
випадку sibling-файлів стає N (по одному на кожну унікальну remote-версію).
Це **очікувана і свідома** поведінка, не bug.

Чому це не страшно:
- **ConflictStore dedup** (вже існує, CLAUDE.md рядок 189):
  ідентична пара `(vaultPath, theirsBlobSha)` дедуплікується.
  Якщо remote двічі прийшов з ідентичним контентом, sibling
  створюється тільки один раз. Новий sibling — тільки для **справді
  нової** версії.
- **Групування у list view** (R2.2): `note.md (3 versions)` — три
  копії як один expandable пункт, не три окремих рядки. Візуально
  не виглядає як хаос.
- **Швидке масове очищення**: у Diff-Edit detail view є
  `[Apply all remote changes]` (R7.9), який resolve-ить усі N
  конфліктів цього файлу за один клік (бере останню remote-версію
  як authoritative). Користувач очищає "конюшні" за 2 кліки:
  `[Open in Diff-Edit]` → `[Apply all remote]`.

Альтернатива (auto-collapse N siblings в один) була б проблемною: ми
б приховували від користувача факт, що було кілька різних remote-версій,
і він втрачав би можливість обрати конкретну версію. Тому залишаємо
N окремих записів — користувач бачить повну картину.

### R3. Recently deleted / Local trash

**R3.1.** Створити локальний "smart-trash":
`<configDir>/plugins/github-easy-sync/.trash/<id>/`
де `<id>` — 17-цифровий timestamp (та сама схема, що
у `.conflicts/` та `.push-queue/`).

Кожен запис trash містить:
```
.trash/<id>/
  meta.json   ← TrashRecord {id, originalPath, deletedAt, deviceLabel, sha, size, mtime}
  <basename.ext>   ← фактичний файл (move, не copy)
```

**R3.2. Move, не copy.** При локальному видаленні файлу через UI
плагін перехоплює подію `vault.on('delete', file)` і **переміщує**
файл (`adapter.rename`) у `.trash/<id>/<basename>`. Дисковий простір
не дублюється; ліміти на розмір не вводяться у v1.

**Виняток для conflict-sibling**: якщо `file.path` — це
sibling-файл (`*.conflict-from-*`), він **НЕ** йде у `.trash`. Це
плагін-генеровані анотації, не користувацький контент. Замість того
просто видаляється (T1 у R4 виконується природно). Аналогічно для
`.trash/<id>/` директорій, які видаляються cascade-cleanup-ом (R4.1
T3) — вони видаляються atomically, без рекурсивного `.trash`.

**R3.3. Move/rename hardening.** Obsidian для перейменування зазвичай
видає `rename` event, але для деяких drag-drop сценаріїв може бути
послідовність `delete` + `create`. Якщо протягом ~500мс після `delete`
прийде `create` для файлу з тим самим (SHA+size), вважаємо що це був
move — просто видаляємо запис з `.trash` (файл уже існує під новим
ім'ям, нічого повертати не треба).

Реалізація: `pendingDeletes: Map<sha+size, {id, timer}>`. Подія
`create` шукає у мапі — match → cancel timer + видалити trash entry.

**R3.4. Pull-deletes НЕ йдуть у trash.** Якщо видалення прийшло з
GitHub (через `applyRemoteDeletion`), `.trash` обходиться: файл
просто видаляється. Логіка: pull-delete = "GitHub-офіційне видалення",
яке вже в історії repo — користувач відновлює через GitHub history,
не trash. Це робить семантику trash однозначною: trash = "локально
видалив, sync ще не підтвердив".

**R3.5. TTL = 0.** Як тільки push-batch з цим path у `deleted-paths.txt`
успішно зкомічений на GitHub (тобто `processBatch` завершився
`delete(batchId)`), відповідний `.trash/<id>/` миттєво видаляється.
Інтеграція точкова: `Sync2Manager.processBatch` або callback з нього
у `main.ts` повідомляє `TrashStore.confirmDeleted(paths[])`.

**R3.6. Уніфікований UX restore.** У "Recently deleted" секції
Diff-Edit-у користувач не розрізняє джерела. Список будується так:
1. Усі поточні `.trash/<id>/` записи (свіжі, до sync).
2. Видалення з GitHub history (тільки якщо trash порожній по цьому
   path, щоб уникнути дублів) — за останні N днів (default 30,
   налаштовується). Витягуються через `client.listCommitsForPath`
   + `compare()` для виявлення `status: "removed"`.

Кнопка `[Restore]` на елементі:
- Якщо trash entry → `adapter.rename` назад до `originalPath` +
  delete `.trash/<id>/`.
- Якщо GitHub-only → `client.getContentsAtRef(path, beforeDeletionSha)`
  → write до vault + recordSync через ChangeDetector + наступний sync
  push-не файл назад до repo. (Тобто restore з GitHub генерує
  "resurrection commit" автоматично.)

### R4. Авто-resolve конфліктів — реактивні тригери

**R4.1.** Конфлікт `(ours, sibling)` повинен автоматично і миттєво
розв'язуватись **за будь-яких обставин**, коли:
- (T1) Sibling файл видаляється (вже працює через
  `ConflictStore.notifySiblingDeleted`).
- (T2) Sibling файл стає байт-еквівалентним основному:
  `gitBlobSha(ours) === gitBlobSha(sibling)` AND
  `size(ours) === size(sibling)`. Authority: **на користь основного**
  (resolve як ours, бо файли вже однакові — дилеми нема). Sibling
  видаляється.
- (T3) **Основний файл видаляється — bundle до trash разом з усіма
  його конфліктами**. Якщо користувач видаляє `note.md`, який має N
  pending конфліктів, то:
  - `note.md` переміщується у `.trash/<id>/note.md` (звичайний trash).
  - **Усі N sibling-файлів `note.conflict-from-*.md` видаляються з
    vault**, але їх `theirs`-контент і ConflictStore-метадані
    зберігаються у `.trash/<id>/.conflicts/<conflictId>/` (та сама
    структура, що й оригінальний `.conflicts/`).
  - Trash meta.json фіксує `bundledConflicts: [{conflictId, siblingPath,
    deviceLabel, ts, theirsBlobSha}, ...]` — щоб на restore точно
    знати, що відтворювати.
  - In-memory indexes ConflictStore очищуються для цих записів;
    подія `conflict-resolved` emit-иться для кожного, щоб UI
    оновився.

  Семантика: основний файл і всі його похідні (sibling + conflict
  records) — це **одне ціле**, яке мандрує в trash і назад **atomically**.

  **Restore до sync** повертає bundle цілком:
  - `note.md` ← з `.trash/<id>/note.md` на оригінальний path
  - Для кожного `conflictId` у bundle: `.conflicts/<conflictId>/`
    повертається у `<configDir>/plugins/<self>/.conflicts/<conflictId>/`,
    sibling-файл записується у vault з theirs-байтів
    (`.conflicts/<conflictId>/theirs.<ext>`), ConflictStore
    re-індексує запис.
  - Pending конфлікти повертаються у UI: список, статусбар, все.

  **Restore після sync** неможливе через `.trash` (TTL=0, R3.5 — bundle
  очищений). Залишається тільки GitHub history → відновлюється
  **тільки основний файл**, без конфліктів (бо вони були pre-sync
  anomaly і не лишили слідів у repo).

**R4.2. Trigger source.** Підписка у `main.ts` на:
- `vault.on('modify', file)`, `vault.on('create', file)` — для T2.
- `vault.on('delete', file)` — для T1 (sibling) **і** T3 (основний).

Для кожної події:
- Якщо `file.path` — це watched ours-path (`vaultPath === file.path`
  у ConflictStore):
  - У випадку `modify`/`create`: перевірити кожен sibling цього
    path; SHA+size match → T2 resolve.
  - У випадку `delete`: T3 cascade-cleanup — викликати
    `conflictStore.cascadeDelete(vaultPath)`, який пройде всі
    sibling-и цього path, видалить кожен `adapter.remove(siblingPath)`,
    видалить `.conflicts/<id>/` директорії і очистить in-memory
    indexes. Подія `conflict-resolved` emit-иться для кожного запису,
    щоб всі UI (список, статусбар) оновились.
- Якщо `file.path` — це watched sibling-path:
  - У випадку `modify`/`create`: T2 check vs ours.
  - У випадку `delete`: T1 — `notifySiblingDeleted` (вже існує).

**Захист від циклів у T3**: коли `cascadeDelete` викликає
`adapter.remove(siblingPath)`, це триггерить ще один `vault.on('delete')`
для sibling-а. У звичайному режимі це б викликало `notifySiblingDeleted`
(T1), яка спробувала б видалити вже видалений запис. Простий guard:
ConflictStore у in-memory indexes уже не має запису (видалили на
кроці 1), тому `notifySiblingDeleted` no-op-ить. Без додаткових
прапорців.

Витрати: hash обчислюється тільки для path, що в ConflictStore (їх
звичайно одиниці-десятки). На vault з тисячами файлів накладні
витрати — O(1) per modify event.

**R4.3. Каскадне очищення.** Resolve повинен оновити:
1. `ConflictStore.byId / bySiblingPath / byVaultPath` (вже робиться)
2. `.conflicts/<id>/` rmdir (вже робиться)
3. Sibling file `adapter.remove` (вже робиться у T2; у T1 sibling
   уже видалений користувачем)
4. ConflictStatusBar refresh (через `onConflictResolved` deps hook)
5. Diff-Edit tab refresh — якщо відкритий, переактуалізувати список;
   якщо цей запис у DiffPane відкритий, закрити DiffPane (через
   evented model — emit `conflict-resolved` подію, до якої tab
   підписаний).

**R4.4. Drain start sweep.** Окрім реактивних тригерів, на самому
початку `drain()` пройти весь ConflictStore і resolve ті записи, у
яких T2 виконується. Це підстраховка проти ситуацій, коли vault
events не спрацювали (наприклад, файл змінений зовнішнім
інструментом до запуску Obsidian).

### R5. Видалення артефактів каскадно

**Принцип**: будь-який артефакт, який видно у Diff-Edit (sibling,
trash entry, conflict record), при будь-якому шляху видалення
**миттєво** зникає з усіх UI:

- ConflictView list (зараз `ConflictView` живий тільки коли tab
  відкритий — треба зробити PubSub-канал, на який підписаний tab)
- Статусбар (`ConflictStatusBar.refresh(count)`)
- ConflictStore in-memory indexes
- `.conflicts/<id>/` директорія на диску
- `.trash/<id>/` директорія на диску для trash-кейсу
- "Recently deleted" UI section

Реалізація: малий event-emitter `DiffEditEvents` у `src/diff2/events.ts`:
- `conflict-added(record)`
- `conflict-resolved(record)`
- `conflict-store-cleared()`
- `trash-added(record)`
- `trash-removed(record)`
- `trash-cleared()`

Підписники: `ConflictView` (тепер `DiffEditView`), `ConflictStatusBar`,
`main.ts::handleSync2Conflict`. Кожен публікатор (ConflictStore,
TrashStore) emit-ить при мутаціях. `main.ts` залишається єдиною
точкою wire-up.

### R6. Зовнішній diff-tool (desktop-only)

**R6.1.** На Desktop користувач може налаштувати зовнішній diff-інструмент
(наприклад `gvimdiff`, `windiff`, `meld`, `kdiff3`, `code --diff`) і
запускати його з Diff-Edit замість/паралельно вбудованому DiffPane.

**R6.2. Settings UI.** У Settings tab плагіна нова секція
"External diff tool" з полями (видимими тільки якщо `Platform.isMobile`
== false; на мобільному вся секція прихована):

- **Enable external diff** — toggle.
- **Command template** — рядок з плейсхолдерами `{ours}` і `{theirs}`.
  Приклади у placeholder-у:
  - `gvimdiff -f "{ours}" "{theirs}"`
  - `meld "{ours}" "{theirs}"`
  - `code --diff "{ours}" "{theirs}"`
  - `kdiff3 "{ours}" "{theirs}"`
- **Read result back** — toggle. Якщо ON, після виходу зовнішнього
  процесу плагін перечитує `{ours}` і застосовує зміни до vault
  (як ніби користувач відредагував у вбудованому DiffPane).
- **Test command** — кнопка, що запускає `command --version` (або
  просто перший токен з `--version`) і показує stdout/stderr у Notice.

**R6.3. Тригер.** У Diff-Edit tab, коли DiffPane відкрита, додаткова
кнопка `[Open in external tool]` (приховується якщо `enable === false`
або mobile). По кліку:
1. Записати `ours` та `theirs` у тимчасові файли:
   `<configDir>/plugins/github-easy-sync/.tmp/<id>/ours.<ext>` та
   `theirs.<ext>`. Файли у плагін-каталозі (не в системному `/tmp`)
   бо так доступно через Obsidian adapter і кросплатформово.
2. Spawn процес через Node API (`require("child_process").spawn` або
   `exec`). Доступно тільки на Desktop (`Platform.isDesktopApp` /
   `app.isMobile === false`).
3. Безпека: NE пускати `command` як shell-string. Парсити її простим
   shell-arg splitter-ом (повага до подвійних лапок) і викликати
   `spawn(argv[0], argv.slice(1))` без `shell: true` — це блокує
   ін'єкції типу `; rm -rf ~`. Документувати у settings tooltip:
   "Команда виконується без shell. Лапки навколо плейсхолдерів
   обов'язкові, якщо шляхи містять пробіли."
4. Очікувати на `exit`. Якщо `Read result back === true` —
   перечитати tmp `ours`, обчислити SHA, якщо змінився — записати
   назад у vault через `writeResolved`. Якщо ours тепер
   байт-рівне theirs → авто-resolve спрацьовує природно через R4.
5. Cleanup `.tmp/<id>/` після виходу процесу.

**R6.4.** На Desktop де неможливо знайти команду (ENOENT) — показати
Obsidian Notice з помилкою і pointer-ом на settings.

**R6.5. Mobile.** На мобільному вся ця функціональність недосяжна:
- Settings секція прихована.
- Кнопка `[Open in external tool]` у DiffPane не рендериться.
- Жодного коду через `child_process` (інакше esbuild на mobile-цільовій
  збірці буде падати). Імпорт `child_process` лежить за лінивим
  `require()` в captured-функції, яка викликається тільки після
  `Platform.isDesktopApp` гарду.

### R7. Форма Diff-Edit widget — Unified-only

**R7.1. Один режим, один редактор.** Diff-Edit має лише **unified-режим**
(зміни одна під одною у єдиному текстовому вікні). Бічного side-by-side
немає. Аргументація: вузький екран — мобільні влаштовує; для desktop
power-users є зовнішній diff (R6). Кодова база скорочується (нема
ResizeObserver, нема MergeView side-by-side branch, нема двох
синхронізованих CodeMirror інстансів).

**R7.2. Розмітка конфліктних блоків** в стилі git merge markers,
але з вбудованими action-кнопками. Локальні (ours) рядки **завжди
зверху**, remote (theirs) — **завжди знизу**. Без виключень: фіксована
орієнтація прибирає необхідність розглядати "звідки взявся блок". Приклад
рендеру:

```
 1  | спільний рядок перед зоною конфлікту
    | <<< <local deviceName>: [select][remove]
 2 −| рядок з локального файлу
    | === [select All][remove All]
 2 +| рядок з github repo
    | >>> <remote deviceName>: [select][remove]
 3  | спільний рядок після зони конфлікту
```

Деталі:
- Зліва — **зона нумерації** (virtual line numbers). Спільні рядки
  нумеруються послідовно (1, 3, ...). Локальний та remote-рядки
  конфлікту мають **однаковий номер** (2 у прикладі) — це позиція,
  яку зайняв би переможець після resolve. Marker-рядки (`<<<`, `===`,
  `>>>`) не нумеруються.
- Праворуч від номера, **прилеглий до розділювача** — diff-sign:
  - `−` (мінус) для локальних (ours) рядків
  - `+` (плюс) для remote (theirs) рядків
  - відсутній (пробіл) для спільних і marker-рядків
  - Знак "тулиться" до розділювача (`2 −|` без пробілу між знаком і
    розділювачем) — щоб око одразу зчитало "diff-sign" як єдине ціле
    з лінією, що відділяє нумерацію від тексту.
- Вертикальна риска `|` — це **розділювач** між зоною нумерації і
  зоною редагованого тексту. Це не "пайп" у сенсі shell-метафори,
  а CodeMirror gutter-border. Рендериться як межа між gutter-ом і
  text-area, природно для CM6 архітектури.
- Маркер-рядки (`<<<`, `===`, `>>>`) рендеряться як CodeMirror
  block-widget decorations (вбудовані DOM-елементи), не як справжні
  рядки в документі — щоб не плутати парсер markdown /
  md-frontmatter / тощо. При write-back у vault marker-рядки
  відсутні: документ містить тільки результат resolve.

**R7.3. Кольорове кодування** (через CodeMirror line decorations).
Логіка git-diff: local — те що "знімається/замінюється", remote —
"альтернатива, яка приходить":
- "ours"-рядки + `<<<` marker → **червоний фон**
  (`var(--background-modifier-error)` або подібний Obsidian-token).
  У gutter — `−`.
- `===` middle marker → нейтральний фон
  (`var(--background-secondary-alt)`).
- "theirs"-рядки + `>>>` marker → **зелений фон**
  (`var(--background-modifier-success)` або подібний).
  У gutter — `+`.
- Темна тема: token-ова палітра автоматично адаптується.

> **Примітка про конвенцію**: користувач свідомо обрав red(ours)/green(theirs)
> — це git-diff візуалізація (видалюване = червоне, додаване = зелене), а
> не "успіх vs помилка". Тобто ours тут не "погана сторона" — це просто
> візуальна звичка з git.

**R7.4. Word-level diff highlighting** всередині рядків ours/theirs.
Для кожної пари (ours-chunk, theirs-chunk) обчислюється character/word
diff (наприклад через `diff` або `diff-match-patch` npm-пакет —
вибір при імплементації) і змінені слова отримують додаткову мітку
(жирніший фон / underline). На прикладі рядка
"`рядок з локального файлу`" vs "`рядок з github repo`" — слова
"`локального файлу`" і "`github repo`" мають жирніший фон, "`рядок з`"
лишається на основному фоні блоку.

**R7.5. Action-кнопки** (Widget decorations).

Семантика:
- `[select]` на верхньому маркері (`<<<`) — "залишити ours, видалити
  theirs". Результат для цього chunk: ours-рядки.
- `[remove]` на верхньому маркері — "видалити ours, залишити theirs".
  Результат: theirs-рядки.
- `[select]` на нижньому маркері (`>>>`) — дзеркало: "залишити theirs".
  Результат: theirs-рядки.
- `[remove]` на нижньому маркері — "видалити theirs, залишити ours".
  Результат: ours-рядки.
- `[select All]` на середньому маркері (`===`) — "залишити обидва"
  (ours, потім theirs, конкатенацією; нова порожня лінія між ними якщо
  обидва закінчуються на текст). Корисно для markdown-нотаток де
  обидва варіанти інформативні.
- `[remove All]` на середньому маркері — "видалити обидва" (chunk
  стає порожнім; навколишні спільні рядки злипаються).

Дублювання `[select]/[remove]` навмисне: одні користувачі думають
"що залишити", інші — "що видалити". Натиснути на одній стороні =
автоматично визначити іншу. Це знижує когнітивне навантаження і
кількість помилок.

**R7.6. Візуальні стрілки в кнопках.** Кожна кнопка містить unicode
arrow або SVG, що позначає позицію блока:
- Верхній блок (`<<<` маркер): обидві кнопки мають **стрілку ↓**
  (вказують на нижній блок — те, з чим вони "взаємодіють").
- Нижній блок (`>>>` маркер): обидві кнопки мають **стрілку ↑**.
- Середній блок (`===`): кнопки `[select All]` і `[remove All]`
  мають парні стрілки `↓↑` поруч (бо діють на обидва блоки).

Точна семантика arrow напрямку (вказує на "що буде видалено" vs
"позиція блока") уточниться на mock-up етапі. Принципово: стрілки —
це візуальна підказка, яка зменшує плутанину які кнопки відносяться
до якого блока.

**R7.7. Auto-finalize.** Як тільки **всі** конфліктні блоки в файлі
resolve-нуті (тобто документ містить тільки спільні рядки + один з
варіантів кожного блоку), DiffPane викликає `onByteEqual(finalText)`
(існуючий механізм). Resolve пишеться у vault, ConflictStore видаляє
запис, sibling-файл видаляється — каскадно через DiffEditEvents (R5).

**R7.8. Free editing of everything.** Користувач має право **вільно
редагувати усе** у файлі — будь-який рядок без обмежень:
- спільні (common) рядки — як у звичайному markdown-редакторі
- ours-рядки конфлікту (червоний фон) — можна правити typo, додавати
  слова, видаляти частини
- theirs-рядки конфлікту (зелений фон) — так само
- частково resolve-нуті результати — можна доповнити вручну те, що
  не вирішується самими select/remove кнопками

Marker-рядки (`<<<`, `===`, `>>>`) — це візуальні decorations, не
текст документа: вони не блокують курсор і не "редагуються" у
звичайному сенсі, бо їх немає у документі взагалі. Натискання `Enter`
на маркер-decoration переводить курсор у наступний справжній рядок
без вставки нового рядка маркера.

Word-level highlight (R7.4) і кольорове підсвічення (R7.3)
автоматично перераховуються при кожному edit. Якщо користувач довів
ours і theirs до байт-рівності — auto-finalize спрацьовує (R7.7).

**R7.9. Detail view toolbar (top) + footer — per-mode.**

Toolbar над DiffPane відрізняється залежно від режиму (Conflicts /
History / Compare / Deleted). Спільне: `[←]` back завжди перший
елемент ліворуч; `[Open in external tool]` (desktop only) завжди
останній правий, якщо R6 enabled.

**R7.9a. Conflicts mode (R2.2) detail toolbar:**
- `[←]` back to conflicts list.
- `[Keep all local (<localDeviceName>) changes]` — масовий take-ours.
- `[Apply all remote (<remoteDeviceName>) changes]` — масовий
  take-theirs.
- `[Join all changes]` *(markdown only)* — викликати
  `conflict-merge-all.ts::mergeIntoOne()`; theirs додається як
  `> blockquote` callout під ours з header-ом "`> changes from
  <remoteDeviceName> at <date> <time>`".
- Toggle `⏩` **Auto-advance** — коли увімкнено, після resolve будь-якого
  одного chunk-у (через `[select]/[remove]` per-chunk кнопки)
  автоматично переходимо до наступного нерозв'язаного chunk-у:
  курсор + scroll позиціонуються на ньому. Default — **OFF**. Стан
  toggle-у зберігається у settings (`autoAdvanceConflicts: boolean`)
  і живе між сесіями. Корисно для досвідчених користувачів з
  купою однотипних конфліктів; OFF за замовчуванням, бо стрибок
  viewport-у може дезорієнтувати тих, хто переглядає результат
  resolve перед переходом.
- `[Open in external tool]` (desktop).
- **Без read-only toggle** — конфлікти існують щоб бути resolve-нутими,
  read-only тут не має сенсу.

**R7.9b. History mode (R2.3) detail toolbar:**
- `[←]` back to history list.
- Toggle `✏️` (Edit) / `🔒` (Reference) — перемикає DiffPane між
  редагованим та read-only станом (за замовчуванням Edit). У Reference
  обидві сторони заблоковані від модифікації; навігація і копіювання
  тексту працюють.
- `[Restore this version]` — атомарно перезаписати поточний файл
  байтами обраної історичної версії. Confirm-модалка перед write
  ("Перезаписати `<path>` версією з `<commit-or-ts>`?").
- `[Open in external tool]` (desktop).
- **Без `[Keep all local]` / `[Apply all remote]`** — у history-контексті
  ці назви не мають сенсу (немає "remote contributor", є тільки past
  version of same file). Селективне "повернення" частин старої версії
  робиться через per-chunk `[select]/[remove]` всередині DiffPane
  (Edit mode), масове — через `[Restore this version]`.

**R7.9c. Compare any two (R2.1) detail toolbar:**
- `[←]` back to compare picker.
- Toggle `✏️` (Edit) / `🔒` (Reference) — default **Reference**
  (порівняння рідко передбачає правки; коли треба правити, юзер
  явно перемикає).
- `[Swap]` — поміняти місцями який файл згори, який знизу.
- `[Open in external tool]` (desktop).
- **Без group resolve buttons** — це не конфлікт, нема концепту "ours"
  vs "theirs". Per-chunk `[select]/[remove]` доступні у Edit mode
  (для тих хто хоче синхронізувати один файл з іншим).

**R7.9d. Deleted mode (R2.4) detail toolbar:**
- `[←]` back to deleted list.
- `[Restore]` — повернути файл за оригінальним path-ом (з модалкою
  "Файл вже існує" якщо потрібно).
- `[Restore as…]` — restore під іншим іменем.
- `[Open in external tool]` (desktop).
- **Завжди read-only** — нема активної версії для edit-у.

**Md-only safety** (R7.9a): `[Join all]` рендериться **тільки** для
файлів з markdown-розширенням (`isMarkdown(path) === true`). Для
JSON/YAML/CSS/CSV blockquote вставка корумпує синтаксис, тому
операція там недоступна.

**Footer** (внизу DiffPane, у всіх режимах однаковий):
- Лічильник "`N` unresolved chunks · `M` resolved" (live update при
  кліках/edit-ах). У History/Compare режимах "unresolved" просто
  означає "diverging" (відмінні), без resolve-семантики.
- **Навігаційні кнопки** `[↑ prev chunk]` / `[↓ next chunk]` — клік
  переходить курсор до попереднього/наступного diverging-блоку у
  документі. Працюють у всіх режимах, включно з Reference (бо це
  навігація, не редагування).

**Жодних дефолтних hotkey-ів** плагін не задає. Причини:
- `Alt`-based комбінації (як `Alt-N`) на macOS зайняті системою для
  спецсимволів (`Alt-N` → `ñ`), користувач не може ними скористатись.
- Mobile (iOS/Android) hotkeys взагалі не релевантні — Obsidian
  mobile не має зовнішньої клавіатури типово.

Замість дефолтних hotkey-ів усі операції (next chunk / prev chunk /
take ours / take theirs / take both / resolve all / open external)
експортуються як **Obsidian commands** у command palette.
Користувач, який хоче hotkey-и, прив'язує їх через стандартну Obsidian
"Hotkeys" сторінку — там він сам обере зручну комбінацію, що не
конфліктує з його ОС.

**Назви кнопок — TBD**: робочі назви у цьому плані (`Keep all local`,
`Apply all remote`, `Join all`, `select`, `remove`) залишаються
відкритими. Можливі альтернативи: `apply`/`delete`, `take`/`drop`,
або інше. Фінальний набір обирається на UI-полірувальному етапі
Phase 7; принципово — узгоджена пара "залишити цю сторону" /
"видалити цю сторону" і назви не змінюються між різними частинами UI.

**R7.10. Compare & history mode** використовує ту ж форму, але без
`<<</===/>>>` маркерів і без action-кнопок:
- chunks теж кольорові (зелений = тільки у першому файлі, червоний =
  тільки у другому/старій версії, жовтий = змінено) + word-level
  diff.
- Документ read-only (для history) або editable (для compare two —
  але без auto-finalize, бо це не конфлікт).
- Для history mode footer містить `[Restore this version]`.

---

## Архітектурні зміни (план файлів)

### Нові файли (новий каталог `src/diff2/`)

- `src/diff2/trash-store.ts` — `TrashStore` (analogue до
  `ConflictStore`): `load()`, `create({path, content/move})`,
  `createBundle({mainPath, conflictIds})` (R4 T3), `restore(id)`,
  `restoreBundle(id)`, `confirmDeleted(paths[])`, `list()`,
  `clearAll()`. In-memory indexes `byId`, `byOriginalPath`.
- `src/diff2/events.ts` — невеликий типобезпечний event-emitter
  (`EventTarget` wrapper) `DiffEditEvents`. 30–50 рядків.
- `src/diff2/diff-pane.ts` — CM6 unified diff editor (R7). Переноситься
  з існуючого `src/sync2/views/diff-pane.ts`, скорочується (зняти
  side-by-side MergeView branch + ResizeObserver), розширюється
  під R7.2–R7.9 (marker block-widgets, +/− gutter, red/green
  decorations, word-level highlight, mode-aware toolbar,
  auto-advance).
- `src/diff2/diff-edit-view.ts` — нова `ItemView` `DiffEditView`,
  що замінить `ConflictView`. View type id — `"diff2-edit-view"`
  (за конвенцією іменування підпроекту).
- `src/diff2/sync-summary-modal.ts` — нова summary-модалка з тексту
  R1.2 і двома кнопками.
- `src/diff2/history-list.ts` — побудова списку commit-ів для
  path-а (GitHub + push-queue fallback).
- `src/diff2/deleted-list.ts` — побудова уніфікованого списку для
  "Recently deleted" (trash + GitHub-only).
- `src/diff2/external-diff.ts` — argv-splitter + child_process
  launcher, gated через `Platform.isDesktopApp`.
- `src/diff2/compare-picker.ts` — `FuzzySuggestModal` для R2.1
  (compare any two files) з опційним desktop-only кнопкою
  `[Browse filesystem…]`.

### Зміни в існуючих файлах

- `src/sync2/views/conflict-modal.ts` — **видалити**
  (разом з тестом `tests/sync2/conflict-modal.test.ts`).
- `src/sync2/views/conflict-view.ts` — **видалити** після того, як
  `diff2/diff-edit-view.ts` готовий. Опційно лишити thin
  alias-redirect у `main.ts` (від старого `sync2-conflict-view`
  → новий `diff2-edit-view`), щоб відкриття старих linked
  workspaces не падало.
- `src/sync2/views/diff-pane.ts` — **перенести у
  `src/diff2/diff-pane.ts`** і переробити під R7. Уся стара
  поведінка лишається у git-історії; якщо щось ламається —
  можна повернутись через blame.
- `src/sync2/conflict-store.ts` — **точкові** додатки: emit подій
  `conflict-added` / `conflict-resolved` у `create()`/`resolve()`;
  додати метод `tryAutoResolve(vaultPath)` для T2-перевірки;
  додати метод `cascadeBundleToTrash(vaultPath, trashStore)` для
  T3-bundle-сценарію (R4.1 T3). **Жодних** змін у поведінці
  існуючих методів — лише додаткові hook-и.
- `src/github/client.ts` — додати `listCommitsForPath(path, branch,
  opts)` обгортку над REST `GET /commits`. Уже використовуваний
  `getContentsAtRef` лишається.
- `src/sync2/sync2-manager.ts` — у `applyRemoteDeletion`
  гарантовано НЕ створювати trash entry (R3.4); у `processBatch`
  після успішного commit викликати
  `trashStore.confirmDeleted(batch.deletions)` через deps. Файли з
  pending конфліктами виключити з batch.files / batch.deletions
  на етапі `findChanges` (R2.6).
- `src/main.ts` —
  - видалити state `suppressConflictModals`,
    `openConflictViewAfterSync`, `resolveNowPath`
  - переробити `handleSync2Conflict` під R1.1 (без модалки,
    безумовний deferred return)
  - після `drain()` показати summary modal (R1.2)
  - підписатись на `vault.on('delete')` → trash routing
    (звичайний move ABO bundle для файлів з конфліктами).
    На `vault.on('modify' | 'create')` → auto-resolve T2 +
    rename-deduplication (R3.3).
  - зареєструвати view type `diff2-edit-view`, при потребі
    додати alias-redirect зі старого `sync2-conflict-view`.
  - додати context-menu пункт "Compare with…" через
    `app.workspace.on('file-menu', cb)` (R2.1).
  - зареєструвати нові commands з префіксом "Diff2: …",
    без `defaultHotkeys`.

### Видалене / спрощене

- ConflictModal.ts (~160 рядків)
- логіка `availableChoices`, `defer-all`, `resolve-now`, `merge-into-one`
  з прийняття рішення під час sync
- стейт-машина `suppressConflictModals` / `openConflictViewAfterSync`
  у main.ts (~50 рядків)
- `conflict-modal.test.ts`

---

## Фази реалізації (incremental, кожна фаза тестабельна)

### Phase 0 — Контракти і інфраструктура
- [ ] `src/diff2/events.ts` + unit тести
- [ ] Тип `TrashRecord` у `types.ts`
- [ ] Тип `HistoryEntry` у `types.ts`

### Phase 1 — Зняти per-file модалку
- [ ] Видалити `ConflictModal` та її тест
- [ ] Переробити `handleSync2Conflict` під R1.1 — безумовний deferred
- [ ] Видалити `suppressConflictModals` / `openConflictViewAfterSync`
- [ ] Додати `SyncSummaryModal` (R1.2)
- [ ] Викликати її у `afterSync()` (якщо `newConflictsCount > 0`)
- [ ] Інтеграційний тест: 3 конфлікти в одному sync → 0 per-file
  модалок, 1 summary в кінці

### Phase 2 — Auto-resolve T2 (SHA-конвергенція)
- [ ] `ConflictStore.tryAutoResolve(vaultPath)` — перевіряє SHA+size
  ours vs кожного sibling-а, resolve матчі
- [ ] `vault.on('modify')` + `vault.on('create')` listeners у main.ts
- [ ] Drain-start sweep у `sync2-manager.drain()`
- [ ] Тест: користувач редагує sibling у звичайному tab-і → конфлікт
  зникає зі статусбара без відкриття Diff-Edit
- [ ] Тест: користувач редагує main file до байт-рівності → так само

### Phase 3 — TrashStore + Recently-deleted UX (без GitHub-частини)
- [ ] `TrashStore.create()`/`restore()`/`confirmDeleted()`/`list()`
- [ ] `vault.on('delete')` → trashStore.create + move
- [ ] Rename-deduplication (R3.3): pendingDeletes map + 500мс window
- [ ] `processBatch` post-commit → `confirmDeleted(batch.deletions)`
- [ ] Тест: delete файлу → з'являється у Recently deleted → restore
  → файл назад у vault, trash порожній
- [ ] Тест: rename файлу (delete+create від Obsidian) → trash не
  накопичує (deduplication працює)
- [ ] Тест: delete + sync → trash entry зникає миттєво після commit

### Phase 4 — GitHub Commits API + File history
- [ ] `client.listCommitsForPath()` обгортка + unit-тест на mocked
  fetch
- [ ] `HistoryList` побудова для path-у (GitHub + push-queue fallback)
- [ ] DiffPane у режимі `theirsReadOnly: true` для перегляду
  старої версії
- [ ] Кнопка "Restore this version" у DiffPane footer
- [ ] Тест: відкрити історію файлу → клік на стару версію →
  DiffPane показує both → restore → файл відкочений, наступний sync
  push-ить change

### Phase 5 — GitHub-частина для "Recently deleted"
- [ ] Витягти deletions з останніх N commit-ів через
  `listCommitsForPath` + `compare`
- [ ] Об'єднати з trash list (R3.6)
- [ ] Restore з GitHub: `getContentsAtRef(path, parentCommit)` →
  write → next sync push-ить resurrection
- [ ] Тест: видалити + sync (trash очищується) → "Recently deleted"
  все ще показує файл (з GitHub) → restore → файл повернувся → sync
  → resurrection commit на GitHub

### Phase 6 — Compare any two files
- [ ] `app.workspace.on('file-menu', cb)` — додати пункт
  "Compare with…" у контекстне меню файлу
- [ ] `CompareSuggestModal extends FuzzySuggestModal<TFile>` — picker
  зі списком `app.vault.getFiles()`. Кросплатформово.
- [ ] (Desktop only, gated на `Platform.isDesktopApp`) кнопка
  `[Browse filesystem…]` під списком, що відкриває
  `dialog.showOpenDialog` і читає файл через `require('fs')`. Імпорт
  Electron/fs лежить за лінивим require, щоб не ламати mobile bundle.
- [ ] Commands: "Diff-Edit: Compare two files…",
  "Diff-Edit: Compare active file with…"
- [ ] DiffPane у Compare-режимі (R7.9c toolbar, default Reference,
  toggle `✏️/🔒`, `[Swap]`, без resolve-buttons, без `<<<` marker
  widgets)
- [ ] Тест A21: контекстне меню → Compare with… → fuzzy picker → дві
  md-файли відкриваються у DiffPane
- [ ] Тест A22 (desktop): Browse filesystem → обрати файл з-поза
  vault → DiffPane показує його як theirs з `fs://` заголовком
- [ ] Тест A23 (mobile): кнопка `[Browse filesystem…]` НЕ
  рендериться; `require('fs')`/`@electron/remote` не імпортуються

### Phase 7a — External diff tool (Desktop only)
- [ ] Settings UI: секція "External diff tool" (toggle, command,
  read-back, test command) під Platform-guard
- [ ] `src/diff2/external-diff.ts` — argv-splitter (з повагою до
  лапок), launcher через `require("child_process").spawn`,
  cleanup `.tmp/<id>/`
- [ ] Кнопка `[Open in external tool]` у DiffPane footer (desktop only)
- [ ] Тест unit: argv-splitter ("a b c", `'a "x y" c'`, escape edge cases)
- [ ] Тест integration: підставити mock `gvimdiff` що пише known
  bytes у `{ours}` → перевірити, що vault file оновлений + конфлікт
  auto-resolved через R4
- [ ] Документувати в README шість прикладів команд для популярних
  інструментів на Win/macOS/Linux

### Phase 7 — Unified DiffPane (форма R7)
- [ ] Spike: оцінити чи можна побудувати потрібну розмітку
  (`<<</===/>>>` block widgets + diff-sign gutter + red/green
  line decorations + word-level highlight) на основі
  `@codemirror/merge::unifiedMergeView`, чи треба зробити власний
  набір CM6 Decorations поверх ChangeSet. **Critical path** — від
  цього залежить кодова складність усіх інших кроків Phase 7.
- [ ] Видалити side-by-side MergeView branch з `DiffPane`, прибрати
  ResizeObserver і `wide/narrow` режим — лишити тільки unified.
- [ ] Реалізувати virtual line-number gutter (спільні рядки —
  послідовно, ours+theirs у конфлікті — однаковий номер,
  marker-рядки — без номера).
- [ ] Реалізувати diff-sign gutter (`−` для ours, `+` для theirs,
  знак тулиться до розділювача).
- [ ] Реалізувати red(ours)/green(theirs) line decorations з Obsidian
  CSS-токенів (підтримка темної теми).
- [ ] Реалізувати block-widget marker decorations для
  `<<< deviceName: [select][remove]`, `=== [select All][remove All]`,
  `>>> deviceName: [select][remove]` з функціональними кнопками.
- [ ] Реалізувати word-level diff highlight (бібліотеку обрати між
  `diff` та `diff-match-patch` на основі bundle-size + perf на 5KB файлі).
- [ ] Action-кнопки: семантика `select`/`remove` для верхнього /
  середнього / нижнього блоків (R7.5).
- [ ] **Auto-advance toggle** (`⏩`) у Conflicts mode toolbar:
  після кожного per-chunk resolve переходимо до наступного
  нерозв'язаного chunk-у (R7.9a). Default OFF, стан зберігається у
  `settings.autoAdvanceConflicts`.
- [ ] Auto-finalize при resolve усіх блоків (R7.7) — використати
  існуючий `onByteEqual` хук.
- [ ] Перевірка free editing (R7.8): редагування ours/theirs/common
  без обмежень; маркер block-widgets не блокують курсор.
- [ ] Single-pane shell (R2.0): state-машина "list view" / "detail
  view" у `DiffEditView`. Без двопанельного layout-у.
- [ ] Top toolbar в detail view (R7.9): `[←]` + group-action buttons
  + (desktop) external diff button. Md-only guard для `[Join all]`.
- [ ] Top toolbar в list view (R2.2): group-action buttons для
  усіх конфліктів одночасно. Кнопки md-only сховані якщо у списку
  немає md-файлів.
- [ ] Footer (R7.9): лічильник `N unresolved · M resolved`,
  навігаційні кнопки `[↑ prev]`/`[↓ next]`.
- [ ] **Жодних дефолтних hotkey-ів.** Команди для command palette:
  next/prev chunk, take ours/theirs, join all, open external
  (per file). Без `defaultHotkeys`.
- [ ] Прибрати з `main.ts` існуючі команди з дефолтними Alt-N/Alt-1/2/3
  hotkey-ами.
- [ ] Compare & history mode (R7.10): та сама pane без marker
  block-widgets, без action-кнопок, з `[Restore this version]` у
  footer для history.
- [ ] Підписки на DiffEditEvents для live-update списків секцій.
- [ ] Replace `sync2-conflict-view` registration на
  `diff2-edit-view`, додати alias-redirect.
- [ ] Інтеграція з структурою UI (бічна панель / таби — окреме
  питання, див. TBD).

### Phase 8 — Doc + cleanup
- [ ] Оновити CLAUDE.md: розділ "Conflict resolution" → "Diff-Edit
  widget", прибрати згадку "primitive UX"
- [ ] Оновити README з новим UX
- [ ] Інтеграційний прогон `pnpm test:integration` — переконатись,
  що жодна conflict-related E-серія не зламана

---

## Тести (acceptance)

### Поведінкові гарантії, які повинні бути забезпечені integration-тестами

1. **A1**: 1 файл, 1 конфлікт → sync проходить без блокування →
   summary modal "1 невирішений конфлікт" → клік "Перейти" відкриває
   Diff-Edit.
2. **A2**: 3 файли, 3 конфлікти → sync проходить без блокування →
   1 summary modal "3 невирішені конфлікти".
3. **A3**: користувач у звичайному tab-і робить ours-файл байт-рівним
   sibling-у → конфлікт зникає (T2 trigger).
4. **A4**: користувач у звичайному tab-і робить sibling-файл
   байт-рівним ours → так само.
5. **A5**: користувач видаляє sibling файл вручну → конфлікт зникає
   (T1 trigger, регресія до існуючої поведінки).
6. **A6**: delete + sync → trash entry зник після commit. Restore
   тільки через GitHub history.
7. **A7**: delete + restore (до sync) → файл назад, trash порожній,
   жодного commit на GitHub.
8. **A8**: file move (Obsidian rename) → trash не наповнюється
   (rename detection).
9. **A9**: pull видалив файл → файл зник з vault, у trash нічого
   не з'являється. Restore тільки через GitHub history.
10. **A10**: запит історії файлу → отриманий список commit-ів,
    кліки відкривають read-only DiffPane.
11. **A11**: відкрити Diff-Edit на mobile (Obsidian iOS) → unified
    diff mode, всі основні дії досяжні; кнопка "External diff" та
    секція settings не показуються.
12. **A12** (desktop): налаштувати external diff command → клік
    `[Open in external tool]` → процес запустився з очікуваними
    arg-ами → після exit з модифікованим `{ours}` vault оновлюється,
    `.tmp/<id>/` cleanup, конфлікт авто-resolve якщо SHA зрівнялась.
13. **A13** (desktop security): команда `; rm -rf "{ours}"` не
    виконується як shell — другий аргумент пропарсений як literal
    arg, процес `spawn(';', ['rm', ...])` падає з ENOENT.
14. **A14** (T3 bundle): `note.md` має 2 pending конфлікти →
    користувач видаляє `note.md` → у `.trash/<id>/` лежить
    bundle (note.md + .conflicts/<id1>/ + .conflicts/<id2>/),
    у vault зник і `note.md`, і обидва sibling-файли, ConflictStore
    очищено, статусбар оновлено.
15. **A15** (T3 bundle restore до sync): після A14 користувач робить
    Restore у Recently deleted → `note.md` повертається, обидва
    sibling-файли відновлюються з theirs-байтів, ConflictStore
    re-індексує 2 записи, статусбар знову показує `🔀 2`.
16. **A16** (T3 bundle після sync): після A14 користувач робить sync →
    delete пушиться на GitHub, trash bundle очищується (TTL=0). Тепер
    Recently deleted показує тільки GitHub-restore варіант, який
    повертає тільки `note.md` без конфліктів.
17. **A17** (delete-vs-modify рендеринг): локальне видалення +
    одночасна remote-модифікація → у list view `note.md` з badge
    `[deleted locally]`. У detail view ours-сторона порожня (0
    рядків між `<<<` і `===`), theirs-сторона показує remote
    контент з зеленим фоном і `+` у gutter.
18. **A18** (delete-vs-modify resolve як remote): A17 → клік
    `[Apply all remote changes]` → файл створюється у vault з theirs
    контентом, видалення забирається з batch.deletions, наступний
    sync push-ить файл як "resurrection".
19. **A19** (Sync this file refuse): `note.md` має конфлікт →
    `Sync this file` → Notice "Файл `note.md` має 1 pending конфлікт"
    з кнопкою `[Open in Diff-Edit]`. Файл НЕ пушиться на GitHub.
    Команда `Sync all` пропускає цей файл, інші чисті файли
    sync-аться нормально.
20. **A20** (авгієві конюшні): 3 послідовні pull-и приносять різні
    remote-версії `note.md`, поки користувач не resolved → у
    ConflictStore 3 sibling-записи (dedup не дублює, бо theirsBlobSha
    різні). List view: `note.md (3 versions)` як один expandable.
    Detail view `[Apply all remote changes]` → resolve усіх 3 за один
    клік (бере найсвіжіший theirs як authoritative).

### Unit-тести
- `TrashStore.tryAutoResolve` — все позитивні і негативні матчі SHA+size
- `TrashStore.create` / `restore` / `confirmDeleted` ізольовано
- `TrashStore.createBundle` / `restoreBundle` для T3 (R4.1 T3)
- `client.listCommitsForPath` — пагінація, error paths
- Rename-deduplication window (R3.3) — таймінг
- DiffPane render with `ours === ""` (delete-vs-modify) — empty
  top block, full bottom block, no React/CM6 errors

---

## Відкриті питання (TBD)

- **Перемикання між 4 режимами** (Conflicts / Compare / History /
  Deleted). Single-pane shell в межах одного режиму вже визначений
  (R2.0: list ↔ detail через `[←]`). Залишається обрати **як саме
  стрибати між самими режимами** — наприклад, окремі command palette
  команди для кожного режиму, або один shared header з 4 segment-tabs.
- **Назви кнопок** (R7.9 TBD): `[Keep all local]`/`[Apply all remote]`
  vs `[Take ours]`/`[Take theirs]` vs `[Apply]`/`[Delete]`. Фінальний
  набір обирається на UI-полірувальному етапі.
- **Налаштування періоду GitHub history** для "Recently deleted" —
  default 30 днів, але треба вирішити куди покласти в settings tab
  і чи показувати "Load more" UX.
- **Performance: how many commits/page** для file history. Default
  GitHub `per_page=30`, можна збільшити до 100. Треба переконатись
  що для великих vault-ів з частими комітами це не лагає UI.
- **Deleted with renames** — GitHub-API повертає renames як deleted
  на одному path + added на іншому. Як саме показувати такі випадки
  в "Recently deleted"? Imho — приховувати, якщо рукою з'явилось
  створення з тим самим content на іншому path у тому ж commit.

---

## Не входить у скоуп

- Branch switching у Diff-Edit (плагін принципово однобранчевий).
- Конфлікти більше ніж між двома сторонами (3+ devices одночасно)
  — поточна 1-on-1 модель залишається.
- Експорт/імпорт trash між пристроями.
- Visual diff для binary files (PDF, PNG) — рендер не входить;
  binary конфлікти продовжують вирішуватись atomic mtime.
- Restore цілої папки одним кліком (тільки file-by-file у v1).

---

## Резюме

План закриває п'ять пов'язаних slip-ів поточного дизайну:
1. **Прибирає** дратівливу per-file модалку, заміняючи її однією
   summary-модалкою у кінці sync-у.
2. **Робить** auto-resolve конфліктів реактивним і повним —
   будь-яка SHA-конвергенція ours/sibling каскадно очищає всі UI.
3. **Додає** smart-trash для миттєвого відновлення локальних
   видалень до sync-у; після sync-у відновлення йде через GitHub
   history, але UX для користувача — той самий уніфікований список.
4. **Розширює** Diff-Edit до повноцінного інструменту: порівняння
   довільних файлів, історія змін, відновлення видалених.
5. **Додає** на Desktop інтеграцію з зовнішніми diff-інструментами
   (`gvimdiff`, `meld`, `windiff`, `code --diff` тощо) через
   налаштовуваний command template і безпечний `spawn` без shell.

Розробка йде дев'ятьма фазами (з 7a як sub-phase), кожна тестабельна
окремо. Форма UI самого widget — окреме обговорення.