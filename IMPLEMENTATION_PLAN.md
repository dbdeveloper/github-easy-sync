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
- **Obsidian commands** — **БЕЗ ручного префіксу "Diff2:"**.
  Obsidian command palette **автоматично** префіксує усі команди
  display-ім'ям плагіна з `manifest.json` (`github-easy-sync`).
  Тому у коді задаємо тільки coмандні імена, наприклад
  `Compare two files…`, `Open Diff-Edit`, `Next chunk`,
  `Show history of active file`. У палітрі вони відображаються як
  `github-easy-sync: Compare two files…`. Подвійний префікс
  ("github-easy-sync: Diff2: …") нечитабельний — уникаємо.

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
   (A1–A25) — додаткові файли. **Не модифікувати** існуючі тести
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

8. **NO LEGACY.** Коли нова реалізація готова, відповідна стара
   видаляється **тим же PR**. Жодного співіснування legacy-коду
   паралельно з новим:
   - `src/sync2/views/conflict-modal.ts` видаляється у Phase 2 (не "пізніше").
   - `src/sync2/views/diff-pane.ts` видаляється у Phase 4 (заміняється
     `src/diff2/diff-pane.ts`; жодного fall-back-у на старий).
   - `src/sync2/views/conflict-view.ts` видаляється у Phase 6.
   - Жодних "thin alias-redirect-ів" (видалити з плану).
   - Жодних feature-flag-ів типу "use new diff-pane: true" — або новий
     код у проді, або не мержимо.
   Стара поведінка лишається тільки у git-історії; якщо щось ламається —
   `git blame` + `git revert`. У робочому tree — тільки нова реалізація.

9. **Crash resilience — обов'язкова дисципліна, не "якщо встигнемо".**
   Для кожної багатокрокової операції з боком-ефектом на диску
   (TrashStore create/restore, ConflictStore create, R3.3 rename,
   R4 T3 bundle, R7.7 autosave, R6 spawn з tmp files):
   - Запитати "що буде, якщо Obsidian killed / батарея сяде / power
     loss між кроками 1 і 2?" — для **кожної пари** сусідніх кроків.
   - Визначити recovery sweep, що запускається при `onload` плагіна і
     відновлює half-done state у консистентний.
   - Покрити сценарій "killed mid-operation" окремим тестом у відповідній
     фазі. Якщо тест неможливий через залежність від ОС-сигналів —
     зімулювати через injection (`throw` у точці-між-кроками).
   - Документувати інваріант "після recovery sweep стан = або повністю
     завершений, або повністю відкочений; never half-applied".
   Деталі — у новій секції R8 ("Crash resilience") нижче.

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
   `[apply]/[remove]` per chunk або групові `[Keep all local]` /
   `[Apply all remote]` тощо.

2. **File history mode** — список попередніх версій конкретного
   файлу (з GitHub або push-queue). Клік по версії → diff-edit на
   весь tab між поточним файлом (ours) і обраною історичною версією
   (theirs).

   Цей режим має **дві суб-поведінки** з перемиканням через
   **toggle-іконку у top toolbar** (напр., `🔒` коли read-only,
   `✏️` коли editable; точна іконка обирається при імплементації):

   - **Edit mode** (default, іконка `✏️`): працює як conflict
     resolution — chunk-action кнопки `[apply]/[remove]` доступні,
     edits у поточному файлі зберігаються. Користувач може вибірково
     "повернути" частину старого тексту (наприклад, відновити
     випадково видалений абзац з 3 коммітів тому), не повертаючи
     весь файл.
   - **Reference mode** (toggle: `🔒`): **read-only** перегляд.
     Обидві сторони (current та historical) заблоковані від
     модифікації. Chunk-action кнопки та `[apply]/[remove]`
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
2. **Command palette**: команди `Compare two files…`
   (просить вибрати обидва), і `Compare active file with…`
   (active file = top, picker для bottom). Префікс `github-easy-sync:`
   додається Obsidian автоматично.
3. **Зсередини Diff-Edit widget**: режим Compare у мode-перемикачі
   (TBD-розділ про навігацію між режимами).

*File picker*:
- **Same-vault** (default, кросплатформово): `FuzzySuggestModal` зі
  списком `app.vault.getFiles()`. Так само як стандартний "Quick
  switcher" Obsidian. Працює на desktop і mobile однаково.
- **Filesystem browse** (desktop only, **API TBR — to be researched**):
  Під списком fuzzy-suggest опційна кнопка `[Browse filesystem…]`.
  **Однак, `@electron/remote` deprecated з Electron 12** і не доступний у
  свіжих Obsidian-збірках. Тому на Phase 11 (Compare any two files):
  - **Спочатку дослідити сучасні API**: чи Obsidian експортує
    `app.fileManager`-API для filesystem picker; чи доступний
    `electron.ipcRenderer` + main-process bridge; чи Capacitor-API
    (`@capacitor/filesystem`) працює на Obsidian Desktop під капотом.
  - **Якщо знайшли сучасний шлях** — реалізуємо filesystem picker за
    ним; gated на `Platform.isDesktopApp`; обраний файл отримує
    "віртуальний path" `fs://${absolute-path}` у заголовку DiffPane,
    не імпортується у vault.
  - **Якщо не знайшли** — **scope-cut**: filesystem browse видаляється
    з R2.1; перелік супутніх можливостей (compare з файлом поза vault)
    переноситься у "Не входить у scope". Користувач, якому потрібно
    порівняти з зовнішнім файлом, копіює його у vault (тимчасово),
    або використовує external diff tool R6 з manual path-аргументами.
  - Жодного `@electron/remote` у production-бандлі — навіть як lazy
    `require()`. Це deprecated API; ризик ENOENT на свіжих Obsidian
    збірках + майбутні мажорки Electron повністю його приберуть.
- **Cross-vault** як окремий концепт не виділяємо — фактично це
  довільний filesystem-файл, який desktop-picker (якщо реалізовано)
  покриває.

*Mobile-обмеження*: на iOS/Android доступ до файлів поза vault-каталогом
неможливий через sandboxing ОС. Mobile користувач може порівнювати
тільки два файли зі свого vault. Це обмеження платформи, не плагіна;
fix не передбачається.

*Режим відображення*: unified DiffPane (R7) у Compare-toolbar-варіанті
(R7.9c). Default — **Reference (read-only)** (✏️ toggle перемикає у
Edit). Per-chunk `[apply]/[remove]` доступні в Edit mode (для тих
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
- `[Refresh from GitHub]` — примусово витягнути свіжий
  `listCommitsForPath` для оновлення віддалених видалень.

Жодної кнопки масової очистки trash немає — local-trash записи й так
очищуються автоматично після того, як sync підтвердив відповідне
видалення на GitHub (TTL=0, R3.5). Залишати "Empty trash" кнопку
означало б давати ризиковану дію, яка нічого корисного не покриває.

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
- `[Restore]` — повернути файл за оригінальним path-ом. Колізії немає
  за визначенням (див. нижче "Path-only-when-empty filter").

**Path-only-when-empty filter.** Recently deleted list (як local-trash,
так і GitHub-history entries) рендериться через фільтр: запис
показується **лише якщо path зараз порожній у vault**
(`app.vault.getAbstractFileByPath(path) === null`). Якщо користувач
створив новий файл з тим самим іменем — запис автоматично
зникає зі списку:
- TrashStore підписаний на `vault.on('create', file)`: при матчі
  `originalPath` запис прибирається з in-memory index (фізично
  `.trash/<id>/` ще лежить на диску до наступного [Sync with GitHub] —
  для можливого manual recovery через filesystem, але у UI його нема).
- GitHub-history entries фільтруються лінивим API на момент рендеру
  списку.

Логіка: система **не розрізняє** "файл був видалений і відновлений"
vs "файл був видалений і створено новий за тим самим іменем" — для
неї це просто історія path-а. Минулі версії того, що було за цим path-ом
до повторного створення, доступні через File history mode (R2.3) —
там видно ланцюжок "...commits, deletion commit, ...commits,
re-creation commit, ...current commits", як у звичайному `git log <path>`.

Кнопка `[Restore as…]` (відновлення під іншим іменем) **не потрібна** —
у списку немає колізій за визначенням, тому єдина дія "restore" завжди
безпечна.

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
   | <<< Obsidian (Mac): [apply][remove]
   | === [apply both][remove both]
 1 +| <theirs line 1>
 2 +| <theirs line 2>
 3 +| <theirs line 3>
   | >>> GitHub (Phone): [apply][remove]
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

> **🚨 R2.6-RESEARCH-NEEDED (не розв'язано):** механіка виключення.
> Чернетка спочатку казала "виключити на етапі `findChanges`" — але
> це створює потенційний конфлікт з C3-інваріантом (CLAUDE.md "Pull
> defers to push-side reconcile for queue-overlap paths"):
>
> Сценарій до перевірки: батч у queue містить `note.md` без конфліктів;
> pull приносить новий конфлікт на `note.md` (sibling створюється,
> ConflictStore.create); далі drain переходить до Case 4
> reconcileBatchAgainstHead для цього path-у. Якщо ми `findChanges`-рівнем
> виключаємо файли з pending конфліктами, **повторний sync** не побачить
> цей path як змінений — але **поточний батч** уже містить його у
> `batch.files`. Чи відбудеться reconcile коректно? Чи `applyRemoteAddOrModify`
> -path для цього файла спрацює до того, як ми його виключаємо?
>
> Альтернативи, які треба порівняти у code-аналізі **перед Phase 2**:
> 1. Виключити на `findChanges`-рівні (поточний draft).
> 2. Виключити на `processBatch`-рівні (після reconcile, перед
>    `createTree`), щоб reconcile-conflict-creation встиг спрацювати.
> 3. Не виключати взагалі — нехай конфлікт сам блокує push через
>    окремий guard у `processBatch` (просто пропустити цей path у tree).
> 4. Перепакувати batch після reconcile-conflict — split batch на
>    "clean files (proceed)" + "files-with-new-conflicts (defer)".
>
> Trade-off: чим раніше виключаємо — тим простіше, але тим вища
> ймовірність зламати C3 reconcile-проти-snapshot інваріант. Чим
> пізніше — тим консервативніше, але більше edge case-ів у `processBatch`.
>
> **TODO до старту Phase 2** (зняття per-file модалки):
> провести code-аналіз сценарію у `Sync2Manager.drain()` →
> `pullIfNeeded` → `processBatch.case4` для path-у `X`, який
> отримав новий конфлікт під час pull-у цього-ж drain-у. Підготувати
> mini-design під одну з 4 опцій вище, узгодити з користувачем,
> **тільки тоді** імплементувати R2.6 у Phase 2.

*Sync all* (після того, як R2.6-RESEARCH-NEEDED розв'язано): файли з
pending конфліктами **автоматично виключаються з push-batch** на
обраному рівні. Sync інших (чистих) файлів проходить нормально.
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

### R2.7. Перемикання між 4 режимами (entry-points)

Resolved 2026-05-17 (раніше TBD). Принцип — **асиметричні
entry-points за природою режимів**:

- **Conflicts і Deleted — глобальні списки** (не прив'язані до
  конкретного файлу). Усередині diff2 view вони живуть як дві
  **sub-tabs у header-і view-tab-а**: `[Conflicts (N)] [Deleted (M)]`,
  з лічильниками. Кожна sub-tab має власний single-pane shell
  (list ↔ detail, R2.0).
- **Compare і History — file-bound** (прив'язані до конкретного path).
  У глобальному shell-і їм нема де "жити" без вибраного файлу
  (empty state "виберіть файл" — поганий UX). Тому вони **відкриваються
  у тому ж diff2 view як одноразові detail-сесії з готовим контекстом**,
  без sub-tab перемикача. Header у цьому випадку показує тільки
  заголовок поточної сесії і `[←]` назад (для History `[←]` веде у
  list of versions, для Compare — закриває detail у picker або у
  попередню sub-tab).

**Shared 4-segment header (Conflicts | Compare | History | Deleted)
відкинуто**: Compare/History без файлу дають empty state, що
ламає симетрію tabs.

#### R2.7.1. Entry-points для Conflicts

- **Summary modal після sync** (R1.2) — кнопка `[Go to Diff-Edit]`
  відкриває diff2 view із sub-tab `Conflicts`. Модалка показується
  **тільки коли за цю транзакцію з'явилися нові конфлікти** (як уже
  зафіксовано в R1.2). Постійне нагадування про борг забезпечує
  status bar з лічильником; блокуючий діалог після кожного sync-у
  привчив би користувача клікати OK не читаючи.
- **Status bar icon** (див. R2.7.3) — клік відкриває diff2 view із
  default sub-tab за пріоритетом.
- **Ribbon button** (див. R2.7.4) — те саме.

#### R2.7.2. Entry-points для Compare / History

- **Контекстне меню файлу** у file-explorer-і Obsidian (через
  `app.workspace.on('file-menu', cb)`):
  - `Compare with…` → відкриває picker (R2.1), потім diff2 view у
    Compare-detail з обраною парою.
  - `Show history` → відкриває diff2 view у History list для цього path
    (R2.3).
- **Command palette** (Obsidian сам префіксує `github-easy-sync:`):
  - `Compare two files…` — picker для обох сторін.
  - `Compare active file with…` — active як top, picker для bottom.
  - `Show history of active file` — History list для active file.

Глобальні entry-points (ribbon, status bar) для Compare/History
**не передбачені** — це context-bound операції.

#### R2.7.3. Status bar

Одна групова іконка з двома лічильниками: `🔀 N · 🗑 M` (де
`N` — кількість unresolved конфліктів, `M` — кількість trash-entries).
Клік відкриває diff2 view з default sub-tab за пріоритетом:
1. `Conflicts`, якщо `N > 0`.
2. Інакше `Deleted`, якщо `M > 0`.
3. Інакше `Conflicts` (порожній стан з підказкою).

Якщо `N === 0 && M === 0` — іконка може бути dimmed або прихована
(вирішується на UI-полірувальному етапі Phase 7).

#### R2.7.4. Ribbon button (опційно)

Одна кнопка `[diff-edit]` у ribbon-і. Клік відкриває diff2 view
за тим же правилом дефолтного sub-tab-у, що й status bar (R2.7.3).
Ribbon button може бути відключений у settings — для користувачів,
які працюють лише через status bar / контекстне меню.

#### R2.7.5. Default sub-tab при відкритті diff2 view

Якщо diff2 view відкривається без явного режиму (ribbon, status bar,
summary modal) — sub-tab визначається пріоритетом з R2.7.3.

Якщо diff2 view відкривається з явним контекстом (Compare picker,
History command, "Show history" з контекстного меню) — sub-tabs
header **приховується** для цієї сесії, видно тільки `[←]` назад
і заголовок поточного режиму. Це уникає змішування "глобальних
боргів" з "одноразовою detail-сесією".

### R3. Recently deleted / Local trash

**R3.1.** Створити локальний "smart-trash":
`<configDir>/plugins/github-easy-sync/.trash/<id>/`
де `<id>` — 17-цифровий timestamp (та сама схема, що
у `.conflicts/` та `.push-queue/`).

Кожен запис trash містить:
```
.trash/<id>/
  meta.json              ← TrashRecord {id, originalPath, deletedAt, deviceLabel, sha, size, mtime}
  vault/                 ← дзеркало vault-структури — як у .push-queue/<id>/vault/
    <originalPath>       ← фактичний файл (move, не copy)
  .conflicts/            ← опціонально, лише для bundle (R4.1 T3)
    <conflictId>/
      meta.json
      base.<ext>
      theirs.<ext>
```

Структура `vault/<originalPath>` важлива: вона **повторює повний path
з vault-кореня** (наприклад, `vault/Folder1/note.md`), не просто
basename. Це:
- Уникає колізій, якщо в trash потрапили файли з однаковим basename
  з різних папок vault-у (наприклад, `Folder1/note.md` та
  `Folder2/note.md` в одному bundle або у різних entries з близьким
  timestamp).
- Self-documenting: подивившись у `.trash/<id>/vault/`, одразу видно
  з якого місця vault-а файл походить, без необхідності читати
  `meta.json`.
- Узгоджується з конвенцією `.push-queue/<id>/vault/<path>`,
  яка вже використовується sync-движком для байт-снапшоту батча.

**R3.2. Move, не copy.** При локальному видаленні файлу через UI
плагін перехоплює подію `vault.on('delete', file)` і **переміщує**
файл (`adapter.rename`) у `.trash/<id>/vault/<originalPath>`,
створюючи проміжні підкаталоги за потреби (повторюючи структуру
оригінального шляху). Дисковий простір не дублюється; ліміти на
розмір не вводяться у v1.

**Виняток для conflict-sibling**: якщо `file.path` — це
sibling-файл (`*.conflict-from-*`), він **НЕ** йде у `.trash`. Це
плагін-генеровані анотації, не користувацький контент. Замість того
просто видаляється (T1 у R4 виконується природно). Аналогічно для
`.trash/<id>/` директорій, які видаляються cascade-cleanup-ом (R4.1
T3) — вони видаляються atomically, без рекурсивного `.trash`.

**R3.3. Move/rename — конфлікти слідують за файлом.**

**Базова rename-detection** (для файлів **без** pending конфліктів):

Obsidian для перейменування зазвичай видає `rename` event, але для
деяких drag-drop сценаріїв може бути послідовність `delete` + `create`.
Якщо протягом ~500мс після `delete` прийде `create` для файлу з тим
самим (SHA+size), вважаємо що це був move — просто видаляємо запис
з `.trash` (файл уже існує під новим ім'ям, нічого повертати не треба).

Реалізація: `pendingDeletes: Map<sha+size, {id, timer, oldPath,
hadConflicts}>`. Подія `create` шукає у мапі — match → cancel timer
+ видалити trash entry.

**Для файлів з pending конфліктами — конфлікти переміщуються разом**:

Якщо файл `Folder1/note.md` має N pending конфліктів (siblings
`Folder1/note.conflict-from-*.md` і відповідні `.conflicts/<id>/`
записи), і користувач переміщує його у `Folder2/note.md`, то **всі
N конфліктів переміщуються разом атомарно через двофазний commit**.

**Транзакційна модель** (захист від kill mid-rename, Принцип #9):

Усі N×(rename sibling + перепис `.conflicts/<id>/meta.json` + reindex)
операції об'єднуються у транзакцію через тимчасову папку:

```
<configDir>/plugins/<self>/.tmp/rename-<txId>/
  manifest.json           ← {phase: "prepare"|"commit"|"done",
                              oldVaultPath, newVaultPath,
                              entries: [{conflictId, oldSiblingPath,
                                         newSiblingPath, oldMeta, newMeta}, ...]}
```

**Фази**:

1. **Prepare** (`manifest.phase = "prepare"`): записати manifest з усіма
   запланованими переміщеннями (без side-effects). Жодних
   `adapter.rename` поки що не виконано — на диску ще все old-path.

2. **Commit** (`manifest.phase = "commit"`): по черзі для кожного entry:
   - `adapter.rename(oldSiblingPath, newSiblingPath)`
   - перепис `.conflicts/<conflictId>/meta.json` з `newMeta`
   - оновити in-memory indexes ConflictStore
   Якщо kill mid-loop — manifest на диску фіксує, що ми у `commit`-фазі.

3. **Done** (`manifest.phase = "done"`): після успіху всіх entries —
   видалити tmp директорію.

**Manifest itself must be atomic.** Сам `manifest.json` — recovery-pointer,
тож його запис теж через temp-file + atomic rename:
```
adapter.write(`<tmpDir>/manifest.json.tmp`, JSON.stringify(state));
adapter.rename(`<tmpDir>/manifest.json.tmp`, `<tmpDir>/manifest.json`);
```
Інакше power-loss мiж байтами manifest-у залишить torn JSON, який
recovery sweep не зможе розпарсити і не визначить, у якій фазі ми
зупинились. Те ж саме застосовується до кожного оновлення фази
(prepare → commit, commit → done).

**Recovery sweep при `onload`** (новий обов'язок ConflictStore.load):
1. Знайти всі `<configDir>/plugins/<self>/.tmp/rename-*/manifest.json`.
2. Якщо `phase = "prepare"` — нічого не зроблено, видалити манифест,
   `vault.on('rename')` спрацює знову коли користувач відкриє файл
   (або тиха no-op, бо ConflictStore вже re-load-нувся з диску).
3. Якщо `phase = "commit"` — пройти `entries` і **довершити** кожен:
   - Якщо `oldSiblingPath` ще існує → finish rename для цього entry.
   - Якщо `oldSiblingPath` зник і `newSiblingPath` існує → entry вже
     перейменований, оновити meta.json якщо not done.
   - Onload recovery іде до кінця, після чого manifest видаляється.
4. Якщо `phase = "done"` — manifest видаляється, нічого більше не робимо
   (це залишок, який не встиг прибратись).

Інваріант: після recovery sweep — або всі N siblings перейменовані і
ConflictStore консистентний, або нічого з partial rename не лишилось.
Never half-applied.

- `vault.on('delete', file)` + `create` (drag-drop edge case) для
  файлу з конфліктами: коли `create` у 500мс-вікні матчиться як move,
  замість простого drop trash entry виконуємо migration через ту ж
  двофазну модель:
  - Manifest у `.tmp/rename-<txId>/` з джерелом = trash-bundle.
  - Phase commit: кожен `.conflicts/<conflictId>/` повертається з
    trash-bundle у плагін-config dir; sibling-файли пишуться у vault
    під новими шляхами з theirs-байтів; ConflictStore re-індексує.
  - Trash-bundle видаляється у кінці фази.

Семантика: **конфлікти — це анотації над path-ом, які логічно
прив'язані до файлу як артефакта**, а не до конкретного path-у.
Користувач очікує, що переміщення файлу веде до переміщення усіх
пов'язаних з ним метаданих (так само як bundle у trash переїжджає
атомарно у R4.1 T3).

Це **простіше і безпечніше** за альтернативу "блокувати rename, поки
є конфлікти": нема відкату через `adapter.rename`, нема ризику
неконсистентного wiki-link оновлення, нема потреби пояснювати
користувачу чому його drag-drop "не спрацював".

Edge cases:
- **Move цілої папки**: Obsidian fire-ить rename для кожного файлу
  всередині. Кожен файл з конфліктами обробляється індивідуально
  (його sibling-и теж переміщуються). Sibling-и інших файлів папки
  переміщуються через звичайний vault-rename, без участі ConflictStore.
- **Колізія імен на новому path-і**: малоймовірно, бо в назві
  sibling-у міститься timestamp (`-<YYYY-MM-DDTHH-MM-SS>Z`), що
  робить collision практично неможливою.
- **Sibling-у не існує у vault на момент rename** (наприклад, був
  видалений вручну поза Obsidian-сесією — orphan): ConflictStore
  обробить це через існуючий orphan-cleanup на `load()` (CLAUDE.md
  ConflictStore orphan cleanup). Rename-handler може це додатково
  перевіряти і пропускати такі записи без помилки.

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
  його конфліктами**. Якщо користувач видаляє `Folder/note.md`,
  який має N pending конфліктів, то:
  - `Folder/note.md` переміщується у `.trash/<id>/vault/Folder/note.md`
    (звичайний trash, з повторенням vault-структури — R3.1).
  - **Усі N sibling-файлів `Folder/note.conflict-from-*.md`
    видаляються з vault**, але їх `theirs`-контент і
    ConflictStore-метадані зберігаються у
    `.trash/<id>/.conflicts/<conflictId>/` (та сама структура, що й
    оригінальний `.conflicts/`).
  - Trash meta.json фіксує `bundledConflicts: [{conflictId, siblingPath,
    deviceLabel, ts, theirsBlobSha}, ...]` — щоб на restore точно
    знати, що відтворювати (siblingPath тут — повний vault-path
    sibling-файлу, не basename).
  - In-memory indexes ConflictStore очищуються для цих записів;
    подія `conflict-resolved` emit-иться для кожного, щоб UI
    оновився.

  Семантика: основний файл і всі його похідні (sibling + conflict
  records) — це **одне ціле**, яке мандрує в trash і назад **atomically**.

  **Restore до sync** повертає bundle цілком:
  - `Folder/note.md` ← з `.trash/<id>/vault/Folder/note.md` на
    оригінальний path
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

**Захист від циклів у T3** — **двошаровий, event-timing-independent**:

1. **In-memory index очищується ПЕРЕД `adapter.remove`** — коли
   `notifySiblingDeleted` спрацює (синхронно чи асинхронно), у
   ConflictStore вже немає запису, тому handler no-op-ить.
2. **`cascadeInProgress: Set<vaultPath>`** — експліцитний прапорець на
   час bundle-операції. `cascadeBundleToTrash(vaultPath)`:
   ```
   cascadeInProgress.add(vaultPath);
   try {
     // ... bundle конфліктів і siblings, fs-операції ...
   } finally {
     cascadeInProgress.delete(vaultPath);
   }
   ```
   `notifySiblingDeleted` додатково перевіряє: якщо
   `cascadeInProgress.has(record.vaultPath)` — no-op без жодних
   побічних дій (не emit, не rmdir).

Це робить guard незалежним від event-timing-у Obsidian (`vault.on()`
у деяких сценаріях async). Покривається тестом A14 + окремим unit-тестом
на mock-event-emitter, що fire-ить `delete` синхронно і асинхронно.

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

**R4.4. Drain start sweep + кешування.** Окрім реактивних тригерів,
на самому початку `drain()` пройти весь ConflictStore і resolve ті
записи, у яких T2 виконується. Це підстраховка проти ситуацій, коли
vault events не спрацювали (наприклад, файл змінений зовнішнім
інструментом до запуску Obsidian).

**Кешування** `gitBlobSha(ours)` — обов'язкове:
- Кеш-ключ: `(path, mtime, size)`.
- При вході у `tryAutoResolve(vaultPath)` спочатку перевіряємо
  `file.stat.mtime` + `file.stat.size` проти кешу. Match — використовуємо
  кешований SHA без читання байтів. Mismatch — читаємо, хешуємо, оновлюємо
  кеш.
- Інвалідація: запис вилучається з кешу при `conflict-resolved` подіях
  для цього path (більше не потрібен) і при rename (новий path).
- Без кешу drain-sweep на vault з N застарілими конфліктами ("авгієві
  конюшні", R2.6.1) коштує N file reads + N hash обчислень на кожен
  drain — неприйнятно для interval-scheduler-а з 5-хвилинним watchdog.

Інваріант: жоден файл не хешується двічі, якщо його `(mtime, size)` не
змінились між драйнами. Це паттерн з `SnapshotStore.lastCommitMtime`
(CLAUDE.md "Polling model"), застосований локально для ConflictStore.

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

- **Command template** — рядок з плейсхолдерами `{ours}` і `{theirs}`.
  Якщо порожньо — external tool не налаштований; вся функціональність
  R6 fall back-ить на "off". Приклади у placeholder-у:
  - `gvimdiff -f "{ours}" "{theirs}"`
  - `meld "{ours}" "{theirs}"`
  - `code --diff "{ours}" "{theirs}"`
  - `kdiff3 "{ours}" "{theirs}"`
- **Use external as default conflict editor** — toggle (default
  OFF). Визначає **поведінку кліку по конфлікту у Conflicts list
  (R2.2)**:
  - OFF: клік відкриває внутрішній Diff-Edit (R7); звідти можна
    опційно запустити external через кнопку `[Open in external tool]`
    у top toolbar (R6.3).
  - ON: клік **одразу запускає external tool** (минаючи Diff-Edit
    повністю). Користувач не "потрапляє" у Diff-Edit для цього
    конфлікту взагалі.
  Toggle активний тільки якщо command template не порожній. Якщо
  template порожній — toggle disabled із підказкою "Set command
  first".
- **Read result back** — toggle. Якщо ON, після виходу зовнішнього
  процесу плагін перечитує `{ours}` і застосовує зміни до vault
  (як ніби користувач відредагував у вбудованому DiffPane).
- **Test command** — кнопка, що запускає `command --version` (або
  просто перший токен з `--version`) і показує stdout/stderr у Notice.

**R6.3. Точки входу у external tool.** Дві штатні стежки:

**(A) Default-route через клік у Conflicts list** — лише коли
"Use external as default" = ON і template не порожній. Користувач
клікає по конфлікту → плагін одразу робить spawn (кроки R6.4 нижче),
**не відкриваючи Diff-Edit для цього файлу**. Після виходу процесу
(якщо Read result back = ON) result застосовується, конфлікт
авто-resolve-иться (R4) при відповідності SHA.

**(B) Ad-hoc через кнопку у Diff-Edit toolbar** — коли користувач
**уже знаходиться** у внутрішньому Diff-Edit (R7) і хоче
запустити external. Кнопка `[Open in external tool]` у top toolbar
(R7.9a-d) видима тоді, коли:
- `Platform.isDesktopApp === true`
- command template не порожній

Як саме користувач опинився у Diff-Edit:
- "Use external as default" = OFF (Diff-Edit — основний редактор)
- Інший режим, ніж Conflicts (Compare R2.1 / History R2.3 / Deleted
  R2.4) — там default-route у external не передбачений
- Через command palette (`Open Diff-Edit for this conflict`) —
  навіть якщо default = ON, користувач може явно потрапити у
  внутрішній

Тобто кнопка `[Open in external tool]` — це **escape hatch у external**
з внутрішнього редактора, а default-route — це **bypass внутрішнього**
для тих, хто хоче external завжди.

**R6.4. Spawn-механіка** (спільна для обох точок входу A і B):

1. Записати `ours` та `theirs` у тимчасові файли:
   `<configDir>/plugins/github-easy-sync/.tmp/<id>/ours.<ext>` та
   `theirs.<ext>`. Файли у плагін-каталозі (не в системному `/tmp`)
   бо так доступно через Obsidian adapter і кросплатформово.
2. Spawn процес через Node API (`require("child_process").spawn` або
   `exec`). Доступно тільки на Desktop (`Platform.isDesktopApp` /
   `app.isMobile === false`).
3. Безпека: НЕ пускати `command` як shell-string. Парсити її простим
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

**R6.5.** На Desktop, де неможливо знайти команду (ENOENT) — показати
Obsidian Notice з помилкою і pointer-ом на settings. У default-route
сценарії (A) такий fall-back: показати Notice і **fall back на
внутрішній Diff-Edit**, щоб користувач не залишився ні з чим.

**R6.6. Mobile.** На мобільному вся ця функціональність недосяжна:
- Settings секція прихована.
- Кнопка `[Open in external tool]` у DiffPane не рендериться.
- "Use external as default" toggle прихований (його default-стан
  fall back-ить на OFF, бо command empty).
- Default-route (A) ніколи не активується.
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
    | <<< <local deviceName>: [apply][remove]
 2 −| рядок з локального файлу
    | === [apply both][remove both]
 2 +| рядок з github repo
    | >>> <remote deviceName>: [apply][remove]
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

**Layout маркер-рядка**: device-name як **label-prefix**, далі дві
кнопки. Тобто верхній і нижній маркери виглядають як
`<deviceName>: [apply] [remove]`, середній — `[apply both] [remove both]`.

Семантика (для кожної кнопки результат для цього chunk-у):
- `[apply]` на верхньому маркері (`<<< <localDeviceName>:`) — "застосувати
  ours-сторону" → результат: ours-рядки (theirs відкидається).
- `[remove]` на верхньому маркері — "видалити ours-сторону" → результат:
  theirs-рядки (ours відкидається).
- `[apply]` на нижньому маркері (`>>> <remoteDeviceName>:`) — "застосувати
  theirs-сторону" → результат: theirs-рядки.
- `[remove]` на нижньому маркері — "видалити theirs-сторону" → результат:
  ours-рядки.
- `[apply both]` на середньому маркері (`===`) — конкатенація обох сторін
  (ours, потім theirs; порожня лінія між ними, якщо обидва закінчуються
  на текст). Корисно для markdown-нотаток, де обидва варіанти інформативні.
- `[remove both]` на середньому маркері — chunk стає порожнім, навколишні
  спільні рядки злипаються.

Математичні відповідності: `[apply]` top ≡ `[remove]` bottom (обидва дають
ours); `[apply]` bottom ≡ `[remove]` top (обидва дають theirs). Дублювання
навмисне — одні користувачі думають "що залишити", інші — "що видалити".
Натиснути на одній стороні = автоматично визначити іншу. Це знижує
когнітивне навантаження і кількість помилок.

**R7.6. Візуальні стрілки в кнопках.** Кожна кнопка містить unicode
arrow або SVG, що позначає позицію блока:
- Верхній блок (`<<<` маркер): обидві кнопки мають **стрілку ↓**
  (вказують на нижній блок — те, з чим вони "взаємодіють").
- Нижній блок (`>>>` маркер): обидві кнопки мають **стрілку ↑**.
- Середній блок (`===`): кнопки `[apply both]` і `[remove both]`
  мають парні стрілки `↓↑` поруч (бо діють на обидва блоки).

Точна семантика arrow напрямку (вказує на "що буде видалено" vs
"позиція блока") уточниться на mock-up етапі. Принципово: стрілки —
це візуальна підказка, яка зменшує плутанину які кнопки відносяться
до якого блока.

**R7.7. Undo/commit model — Obsidian-style з persistent autosave.**

Поки користувач у DiffPane:
- **Усі дії — звичайні CM6-транзакції** у документному буфері:
  `[apply]`/`[remove]` per-chunk, групові `[Keep all local]` /
  `[Apply all remote]` / `[Join all]`, ручне редагування тексту.
- **`Ctrl+Z` / `Cmd+Z`** працює стандартно — відкочує одну дію за
  раз, можна йти назад до самого початку сесії. `Ctrl+Y` /
  `Cmd+Shift+Z` — redo.
- **Vault-файл `ours` НЕ переписується на кожну transaction** — це
  свідомий вибір на користь "експериментуй вільно, поки не вийдеш"
  моделі. Інакше кожен Ctrl+Z триггерив би `vault.on('modify')` →
  T2 check → потенційно resolve/un-resolve мерехтіння.

**R7.7.a. Persistent autosave (захист від crash / battery die).**

CM6-буфер живе у пам'яті, але **дзеркалиться на диск** кожні
1–2 секунди (throttled, як Obsidian autosaves вміст редактора):

```
<configDir>/plugins/<self>/.diff2-autosave/<conflictId>/
  buffer.txt              ← поточний документний стан DiffPane
  history.json            ← serialized CM6 history (undo/redo stack)
  cursor.json             ← {anchor, head, scrollPos} для відновлення
                            позиції курсору і прокрутки
  meta.json               ← {conflictId, startedAt, lastWriteAt,
                              oursShaAtStart, theirsShaAtStart}
```

CM6 `history` має API серіалізації (`historyField.spec.fromJSON`),
тож відновлення undo-стеку після crash — реалістичне.

**Throttle**: 1.5 секунди між записами (compromise між "втратити
максимум 1.5с роботи" і "не флешити диск при швидкому набиранні").
Reset throttle-таймера при кожному CM6 update; запис відбувається
у тихий момент (1.5с без edit-ів) або при tab `blur` (втрата фокусу).

**Bytes-economy**: якщо `buffer.txt` байт-ідентичний попередньому
запису — skip (типово при rapid undo/redo, які повертають у вже
бачений стан).

**R7.7.b. Recovery dialog при відкритті раніше-перерваного конфлікту.**

Сценарій: користувач відкрив conflict `X`, редагував 10 хв, Obsidian
killed → naступного запуску плагіну клікнув у Diff-Edit на той самий
конфлікт `X`.

Плагін при відкритті detail view перевіряє існування
`.diff2-autosave/<conflictId>/`:
- **Match (autosave існує)** → modal:

  > **Editing was interrupted**
  >
  > You were editing this conflict `<lastWriteAt>` ago.
  > Your changes (`N` undoable steps) are preserved on disk.
  >
  > `[ Continue editing ]`   `[ Start over ]`

  - `[Continue editing]` → завантажити `buffer.txt` як document state,
    `history.json` → CM6 `historyField`, `cursor.json` → курсор/scroll.
    Користувач продовжує з того самого місця, Ctrl+Z працює як до
    crash.
  - `[Start over]` → видалити `.diff2-autosave/<conflictId>/`, відкрити
    чисту сесію з `ours-on-disk`. Чорновик безповоротно втрачено.
    Confirm-крок не потрібен — користувач свідомо обрав цю опцію.

- **No match (autosave відсутній)** → чиста сесія з `ours-on-disk`,
  як завжди.

Edge case: autosave існує, але `oursShaAtStart` (у `.diff2-autosave/`)
≠ SHA того ours, який зараз у vault → значить, користувач (або інший
device через sync) модифікував файл між сесіями. Pause + dialog:

  > **Vault file changed since last session**
  >
  > The vault file `<path>` was modified while this editing session
  > was on disk. Continuing would restore the editing buffer that was
  > based on the *previous* file content.
  >
  > `[ Continue editing (based on old content) ]`   `[ Start over with current content ]`

Default — `[Start over]` (підсвічений), бо continue з застарілим
буфером ризиковано.

**R7.7.c. Дві дії "виходу" з detail view — оновлено.**

- **`[←]` back arrow** (у toolbar) — **точка коміту**:
  1. Записати поточний document buffer у vault (заміщає ours).
  2. Видалити `.diff2-autosave/<conflictId>/` повністю (чорновик
     спожитий, не потрібен).
  3. CM6-історія анулюється.
  4. Закрити detail view, повернутись у list view (R2.2).
  5. Vault-event `modify` → T2 trigger (R4.1) перевіряє
     `SHA(ours) === SHA(theirs sibling)`:
     - **Match** → auto-resolve, sibling видаляється, ConflictStore
       очищується, конфлікт зникає зі списку.
     - **No match** → конфлікт лишається у списку, але з прогресом
       (наступного разу diff покаже менше divergent chunks).

- **Native tab close** (X у tab-header / `Cmd+W` / `Ctrl+W`) —
  **discard буфер цієї сесії + видалити autosave**:
  1. CM6-буфер скидається з пам'яті.
  2. `.diff2-autosave/<conflictId>/` видаляється (це чорновик, не
     результат).
  3. Vault-файл лишається у тому стані, що був при відкритті сесії
     (або після попереднього `[←]`).

  Семантика: "закриваю вікно — викидаю редагування поточної сесії".
  Конфлікт сам **не зникає** — він лишається у списку з тим прогресом,
  що був у vault до цієї сесії. Повторне відкриття конфлікту → чиста
  нова сесія від `ours-on-disk`, без recovery dialog (бо autosave вже
  видалений).

  Це нова семантика порівняно з ранньою чернеткою плану: tab-close
  тепер **експліцитно знищує чорновик**, а не залишає його як "повернись
  пізніше". Логіка: користувач має чіткий вибір — `[←]` зберегти,
  `[x]` викинути. Без `[Continue/Start over]` плутанини при наступному
  відкритті.

- **Crash / Obsidian killed / battery die** — **НЕ те саме що tab-close**:
  CM6-буфер у пам'яті втрачається, але `.diff2-autosave/` лишається
  на диску. Наступне відкриття → recovery dialog (R7.7.b). Користувач
  має шанс **відновити** роботу.

Чітке розрізнення:
- `[←]` = "зберегти і вийти" (autosave видаляється, ours у vault).
- `[x]` = "викинути і вийти" (autosave видаляється, ours у vault без змін).
- Crash = "несподіване переривання" (autosave **зберігається**,
  recovery dialog при наступному відкритті).

**R7.7.d. Tab switching у межах Obsidian** не активує `[x]`-поведінку —
leaf лишається живим у background, CM6-буфер у пам'яті переживає,
autosave throttle продовжує писати. Тільки **явне закриття tab-у**
(`[x]` / `Cmd+W` / `Ctrl+W` на цьому конкретному tab-і) видаляє autosave.

**Clean Obsidian shutdown ≠ tab close.** Якщо користувач робить `Cmd+Q`,
`Alt+F4`, OS restart, або Obsidian Mobile killed по low memory **поки
diff2 tab відкритий** — це **те саме, що kill**:
- CM6-буфер у пам'яті втрачається (звичайно — Obsidian закривається).
- `.diff2-autosave/<conflictId>/` **залишається** на диску (autosave
  throttle встиг записати state у попередні 1.5с).
- Наступний запуск Obsidian + повторне відкриття цього конфлікту →
  recovery dialog (R7.7.b) `[Continue editing] / [Start over]`.

**НЕ wire-ити** `workspace.on('quit')` / `app.on('quit')` як alias до
tab-close handler-а — це б тихо стерло autosave при кожному звичайному
закритті Obsidian, ламаючи саме той сценарій, заради якого autosave
існує. Тільки explicit tab `[x]` дроп-ить autosave. Усі інші форми
"Obsidian більше не показує цей tab" (shutdown, crash, swap, sleep) —
зберігають autosave.

Recovery-сценарії:
- "Хочу зберегти і продовжити пізніше" → `[←]` → tab можна закривати,
  на disk-у вже vault-state.
- "Все, я наплутав, скасуйте усе" → close tab `[x]` → autosave
  видалений → re-open → той самий конфлікт чекає з ours-on-disk.
- "Зробив пів-роботи, хочу відкласти, не закриваючи Obsidian" →
  `[←]` зараз (save partial → R4 T2 виявить, що file still divergent,
  конфлікт лишається з прогресом).
- "Робив 20 хв, Obsidian Mobile killed по low memory" → перезапуск →
  re-open → recovery dialog → `[Continue editing]` → курсор там же,
  Ctrl+Z працює.

**Crash resilience для autosave** (Принцип #9):
- `buffer.txt` пишеться через temp-file + atomic rename
  (`adapter.write(tmp); adapter.rename(tmp, buffer.txt)`) — щоб
  partial-write не пошкодив попередній валідний autosave.
- `history.json` пишеться так само атомарно.
- `meta.json` (з `lastWriteAt`) пишеться **ОСТАННІМ** у кожному
  throttled-update — це pointer, який підтверджує, що `buffer.txt`
  + `history.json` уже на диску. На recovery-sweep, якщо
  `meta.json` відсутній, але `buffer.txt` існує → autosave вважається
  пошкодженим, видаляється цілком (наступний `[Continue]` неможливий,
  fall through до `[Start over]`-equivalent).

**Жодної окремої `[Discard changes]` кнопки** у toolbar немає. Користувач,
який хоче відмінити багато дій під час сесії, тримає `Ctrl+Z`. Для
"discard all and exit" — `[x]` tab-close. Для "save partial and
keep working on it later" — `[←]`.

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
  одного chunk-у (через `[apply]/[remove]` per-chunk кнопки)
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
  робиться через per-chunk `[apply]/[remove]` всередині DiffPane
  (Edit mode), масове — через `[Restore this version]`.

**R7.9c. Compare any two (R2.1) detail toolbar:**
- `[←]` back to compare picker.
- Toggle `✏️` (Edit) / `🔒` (Reference) — default **Reference**
  (порівняння рідко передбачає правки; коли треба правити, юзер
  явно перемикає).
- `[Swap]` — поміняти місцями який файл згори, який знизу.
- `[Open in external tool]` (desktop).
- **Без group resolve buttons** — це не конфлікт, нема концепту "ours"
  vs "theirs". Per-chunk `[apply]/[remove]` доступні у Edit mode
  (для тих хто хоче синхронізувати один файл з іншим).

**R7.9d. Deleted mode (R2.4) detail toolbar:**
- `[←]` back to deleted list.
- `[Restore]` — повернути файл за оригінальним path-ом. Колізій немає
  за визначенням — список R2.4 фільтрує entries за умовою "path
  зараз порожній" (path-only-when-empty filter, R2.4).
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

**Назви кнопок — RESOLVED 2026-05-18**. Узгоджені на трьох рівнях UI:

1. **Conflicts list (R2.2) — над усіма конфліктами**:
   `[Keep all local]` `[Apply all remote]` `[Join all]` *(md only)*.
2. **Detail view (R7.9a) — над одним файлом**:
   `[Keep all local (<localDeviceName>)]` `[Apply all remote (<remoteDeviceName>)]`
   `[Join all]` *(md only)*. Те саме що список, плюс імена девайсів.
3. **Per-chunk (R7.5) — над одним chunk-ом**:
   `<localDeviceName>: [apply] [remove]` / `[apply both] [remove both]` /
   `<remoteDeviceName>: [apply] [remove]`.

Принцип: на **list/file-level** залишається довша, явна форма
("Keep all local", "Apply all remote") — бо це масові, потенційно
руйнівні дії, де користувач має чітко зчитати, що саме станеться.
На **per-chunk level** — коротка форма (`apply`/`remove`), бо контекст
chunk-у і device-label поряд вже усе пояснюють, а економія місця
важлива (chunk може бути в один рядок).

**R7.10. Compare & history mode** використовує ту ж форму, але без
`<<</===/>>>` маркерів і без action-кнопок:
- chunks теж кольорові (зелений = тільки у першому файлі, червоний =
  тільки у другому/старій версії, жовтий = змінено) + word-level
  diff.
- Документ read-only (для history) або editable (для compare two —
  але без auto-finalize, бо це не конфлікт).
- Для history mode footer містить `[Restore this version]`.

### R8. Crash resilience — наскрізний контракт

**Принцип**: для кожної багатокрокової disk-операції у diff2 повинно
бути визначено:
1. **Точки можливого crash-у** — між якими двома кроками stale state
   може потрапити на диск.
2. **Інваріант стану на диску** — що "консистентний" означає для цього
   store-у.
3. **Recovery sweep** — функція, яка запускається при `onload` плагіна
   і відновлює half-applied state у консистентний (або повністю
   відкочений, або повністю завершений — never half-applied).
4. **Kill-mid-op тест** — окремий integration-тест (з fault-injection),
   який підтверджує recovery.

**R8.1. Walkthrough — основні операції і їх recovery contracts:**

| Операція | Точки crash | Інваріант | Recovery sweep |
|---|---|---|---|
| `TrashStore.create(file)` (R3.2) | (a) move-у `.trash/<id>/vault/<path>` зроблено, `meta.json` ще не записано → (b) `meta.json` записано, `vault.on('delete')` ще не emit-нув подію | Кожен `.trash/<id>/` має валідний `meta.json` АБО директорія вилучається при recovery (orphan move без meta = відкочуємо move назад у vault). **`meta.json` пишеться atomic-rename** (temp+rename) — щоб torn JSON не виглядав як "валідний meta-stub" | `TrashStore.recoverIncomplete()`: сканувати `.trash/`, для кожного `<id>/` перевірити `meta.json`. Відсутній/невалідний → відновити файл назад у `originalPath` (зчитаний з `vault/<path>` shape), видалити `<id>/`. **Collision-handling**: якщо `originalPath` зайнятий на момент recovery (юзер створив новий файл з тим іменем поки Obsidian був закритий) → НЕ клобберити; replacing path = `<originalPath>.recovered-<recoveredAt>.<ext>`, log Notice "recovered interrupted delete: <originalPath> → <newPath>" |
| `TrashStore.restore(id)` | (a) move з `.trash/<id>/vault/<path>` назад у vault зроблено, видалення `<id>/` ще не завершено | Або файл повернений + bundle цілий у trash, або обидва зникли. Half-applied (файл повернений + trash entry лишається) — допустиме intermediate state, кожен `restore` ідемпотентний | Recovery: якщо `originalPath` зайнятий у vault і в trash entry той самий SHA — `restore` уже відбувся; видалити `<id>/`. |
| `ConflictStore.create(...)` — між sibling write і `.conflicts/<id>/` create | (a) sibling-файл записаний у vault, `.conflicts/<id>/` ще не створено | Кожен sibling-файл у vault має відповідний `.conflicts/<id>/`; orphan sibling = невалідно | `ConflictStore.load()` (вже існує — CLAUDE.md "orphan cleanup" покриває зворотний випадок: `.conflicts/<id>/` без sibling). **Додати симетрію**: для кожного `*.conflict-from-*` sibling-файла у vault, перевірити чи є запис у store; якщо немає — видалити sibling (orphan, користь нульова) |
| `ConflictStore.create(...)` — між `.conflicts/<id>/` create і in-memory index update | (b) `.conflicts/<id>/meta.json` записано, in-memory index ще не оновлено | Index консистентний з диском | In-process, recovery NOT needed: `ConflictStore.load()` при наступному onload re-індексує з диску, закриваючи будь-яке in-memory desync |
| `R3.3 transactional rename` | між фазами `prepare → commit → done` (див. деталі вище у R3.3) | Manifest у `.tmp/rename-<txId>/manifest.json` фіксує phase; entries визначають що зроблено. **Manifest сам пишеться atomic-rename** (temp+rename) на кожному phase-update — torn JSON неможливий | `recoverPendingRenames()`: для кожного manifest у `phase=commit` довершити решту entries; видалити manifest у `phase=done`. Якщо `manifest.json` invalid JSON (parse fail) → trash директорію `.tmp/rename-<txId>/` цілком, log warning (не повинно статись через atomic-rename) |
| `R4 T3 bundle to trash` | (a) main file moved до `.trash/<id>/`, siblings ще у vault → (b) siblings moved, `.conflicts/<id>/` ще не moved → (c) все moved, in-memory ConflictStore ще не оновлений | `meta.json` (з `bundledConflicts: [...]`) є — bundle консистентний; його немає — операція ще не почалась | Recovery: бачимо main file у `.trash/<id>/vault/<path>` без `bundledConflicts`-meta АБО siblings/conflicts ще у плагін-config-dir → довершити cascade (або відкотити, якщо conflicts вже зруйновані — write meta.json з тим, що знайшли на диску) |
| `R7.7 autosave` | (a) `buffer.txt` записано, `history.json` ще не → (b) обидва записані, `meta.json` ще не → (c) `meta.json` записано, але це новий autosave старого вилучити не встиг | `meta.json` є → autosave валідний (його `lastWriteAt` свіжий); `meta.json` немає → autosave incomplete | `.diff2-autosave/<id>/` без `meta.json` → видалити цілком (recovery dialog → fallback на ours-on-disk) |
| `R6 spawn external tool` | (a) `.tmp/<id>/{ours,theirs}.ext` записано, процес запущено, exit не дочекалися (Obsidian killed) | `.tmp/<id>/` сам по собі — допустиме intermediate state; ніяких vault-сайдефектів до exit-handler-а немає | onload sweep: видалити всі `.tmp/<id>/` (вони stale, процес уже не існує) |

**R8.2. `onloadRecoverySweep()` — єдиний point of entry.**

У `main.ts::onload`, після `loadSettings()` і перед wire-up listener-ів:
```typescript
await onloadRecoverySweep({
  trashStore,         // recoverIncomplete()
  conflictStore,      // (вже існує: orphan cleanup) + новий: orphan sibling
  renameTxStore,      // .tmp/rename-*/ sweep (R3.3)
  bundleStore,        // T3 bundle half-done recovery (R4 T3)
  autosaveStore,      // .diff2-autosave/*/ sweep (R7.7)
  tmpStore,           // .tmp/*/ sweep (R6 external diff)
});
```

Кожен sweep — ідемпотентний (можна викликати багаторазово без шкоди),
лог-it-ить дії через існуючий `logger.ts`.

**R8.3. Тести kill-mid-op (Принцип #9).**

Для кожної операції з таблиці R8.1 — окремий unit/integration-тест:
- Симулювати crash через `throw new Error("simulated kill")` у точці-між-кроками
  (інжектована через test-only deps).
- Викликати `onloadRecoverySweep()`.
- Verify: state на диску + in-memory консистентний відповідно до інваріанта.

Іменування файлів: `tests/diff2/crash-resilience/<store>-kill-after-<step>.test.ts`.

**R8.4. Що НЕ покриваємо у v1:**
- Concurrent crashes (kill під час recovery sweep). Прийнятна модель —
  recovery sweep сам ідемпотентний; повторний crash під час нього просто
  залишає state, який повторний onload зачистить.
- Disk-corruption (зіпсовані байти у середині файлу). Об'єкти типу
  `meta.json` парсяться через `JSON.parse` з try/catch; invalid JSON →
  трактується як відсутній і wipe-ається.

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
  - зареєструвати нові commands БЕЗ ручного префіксу (Obsidian
    auto-prefix-ує `github-easy-sync:`), без `defaultHotkeys`.

### Видалене / спрощене

- ConflictModal.ts (~160 рядків)
- логіка `availableChoices`, `defer-all`, `resolve-now`, `merge-into-one`
  з прийняття рішення під час sync
- стейт-машина `suppressConflictModals` / `openConflictViewAfterSync`
  у main.ts (~50 рядків)
- `conflict-modal.test.ts`

---

## Фази реалізації (incremental, кожна фаза тестабельна)

> **Принцип NO LEGACY (#8) і Crash resilience (#9) — наскрізні для всіх фаз.**
> Кожна фаза, що замінює існуючий компонент, **у тому ж PR** видаляє
> старий код (без alias-redirect-ів, без "ifdef-флагів"). Кожна фаза,
> що додає багатокрокову disk-операцію, **у тому ж PR** додає recovery
> sweep + kill-mid-op test.

> **Перепорядкування 2026-05-18**: попередня чернетка ставила Phase 7
> (Unified DiffPane) у кінець, але Phase 4 (file history) і Phase 6
> (compare) використовують DiffPane на читанні/порівнянні. Через
> NO LEGACY не можна підпирати legacy DiffPane тимчасово. Тому
> DiffPane core (4a/4b/4c) тепер живе раніше, а history/deleted/compare
> сидять на готовому DiffPane.

### Phase 0 — Контракти і інфраструктура
- [ ] `src/diff2/events.ts` — `DiffEditEvents` (EventTarget wrapper) + unit-тести
- [ ] `src/diff2/types.ts` — `TrashRecord`, `HistoryEntry`,
  `DiffEditViewState`, `AutosaveSnapshot` (для R7.7)
- [ ] Заколочка `src/diff2/index.ts` для імпортів
- [ ] **Acceptance:** baseline `pnpm test` + `pnpm build` зелені без
  жодних змін у sync2/

### Phase 1 — Acceptance test skeletons (NEW)
- [ ] Створити `tests/diff2/acceptance/` директорію
- [ ] Для кожного A1–A22 (див. розділ "Тести (acceptance)" нижче) —
  окремий файл з `it.skip(...)`-скелетом, описом сценарію у коментарі,
  очікуваним post-condition у `expect.fail("not yet implemented")`
- [ ] Це живий чек-лист: кожна наступна фаза активує (`it.skip` →
  `it`) відповідні acceptance-тести у своєму PR

### Phase 2 — Зняти per-file модалку (R1)
- [ ] **R2.6-RESEARCH-NEEDED**: code-аналіз механіки виключення файлів
  з pending конфліктами (4 опції з R2.6) → mini-design → узгодження
  з автором → **тільки тоді** код
- [ ] Видалити `src/sync2/views/conflict-modal.ts` + `tests/sync2/conflict-modal.test.ts` (**NO LEGACY**)
- [ ] Переробити `handleSync2Conflict` під R1.1 — безумовний deferred
- [ ] Видалити state `suppressConflictModals` / `openConflictViewAfterSync` / `resolveNowPath` (**NO LEGACY**)
- [ ] `src/diff2/sync-summary-modal.ts` — нова модалка R1.2
- [ ] Викликати у `afterSync()`, якщо `newConflictsCount > 0`
- [ ] Активувати A1, A2 (зняти `.skip()`)

### Phase 3 — Auto-resolve T2 + кешування (R4 без T3)
- [ ] `ConflictStore.tryAutoResolve(vaultPath)` з кешем `gitBlobSha`
  по `(path, mtime, size)` (R4.4 кешування)
- [ ] `vault.on('modify')` + `vault.on('create')` listeners у main.ts
- [ ] Drain-start sweep у `sync2-manager.drain()` (R4.4) — використовує
  кеш
- [ ] Активувати A3, A4, A5

### Phase 4a — Unified DiffPane core (R7.1–R7.4)
**Critical path: усі наступні фази з DiffPane сидять на цьому.**
- [ ] **Spike** (1–2 дні): оцінити CM6 підхід:
  - варіант A: `@codemirror/merge::unifiedMergeView` + наші Decorations поверх
  - варіант B: власний шар Decorations поверх `ChangeSet` від diff-бібліотеки
  - вибір — за складністю marker block-widgets + word-level diff
- [ ] Видалити **повністю** `src/sync2/views/diff-pane.ts` (NO LEGACY) — разом з
  side-by-side MergeView branch і ResizeObserver
- [ ] `src/diff2/diff-pane.ts` — unified-only
- [ ] Virtual line-number gutter (R7.2)
- [ ] Diff-sign gutter (`−`/`+` тулиться до розділювача, R7.2)
- [ ] Red/green line decorations через Obsidian CSS-токени (R7.3)
- [ ] Block-widget marker decorations `<<<` / `===` / `>>>` (R7.2)
- [ ] Word-level diff highlight (R7.4); вибір `diff` vs `diff-match-patch`
- [ ] Read-only mode для DiffPane (для Reference-toggle у R2 пізніше)
- [ ] Free editing (R7.8) — marker widgets не блокують курсор
- [ ] Unit-тести: рендер з порожнім ours (delete-vs-modify), порожнім
  theirs, одинаковими сторонами, mixed CRLF/LF

### Phase 4b — DiffPane action buttons + auto-finalize + autosave (R7.5–R7.7)
- [ ] Action-кнопки на marker-widgets (`[apply]`/`[remove]` per chunk)
- [ ] Семантика семи кнопок (R7.5: top apply/remove, mid apply both/remove
  both, bot apply/remove) — як CM6 transactions у документі
- [ ] Auto-finalize при resolve всіх блоків (R7.7.c, T2 trigger emit)
- [ ] **Autosave** (R7.7.a) — throttle 1.5с, atomic-rename writes до
  `.diff2-autosave/<conflictId>/`
- [ ] CM6 history serialize/deserialize (R7.7.a)
- [ ] **Recovery dialog** (R7.7.b) при відкритті раніше-перерваного
  конфлікту; mismatch-варіант для зміненого vault-файлу між сесіями
- [ ] `[←]` back → write vault + drop autosave; `[x]` tab close → drop
  autosave без write (R7.7.c)
- [ ] **Crash resilience tests** (Принцип #9):
  - kill між autosave-write і meta.json update → recovery sweep видаляє
    incomplete autosave
  - kill між `[←]` vault-write і autosave-delete → наступний onload
    знаходить orphan autosave, propose `[Continue]` з усвідомленням
    стейту

### Phase 4c — DiffEditView shell + Conflicts mode (R2.0, R2.2, R2.7, R7.9a)
- [ ] `src/diff2/diff-edit-view.ts` — `ItemView` `DiffEditView`
- [ ] Видалити **повністю** `src/sync2/views/conflict-view.ts` (NO LEGACY)
- [ ] Single-pane state machine: list ↔ detail (R2.0)
- [ ] Conflicts list (R2.2) — згрупований за vaultPath; `note.md (N versions)`
  expandable рядки для авгієвих конюшень
- [ ] Conflicts mode top toolbar (R7.9a): `[Keep all local]`,
  `[Apply all remote]`, `[Join all]` (md-only), `⏩` auto-advance toggle
- [ ] Footer: `N unresolved · M resolved` + `[↑]`/`[↓]` chunk-навігація
- [ ] Sub-tabs header: **тільки `[Conflicts (N)]`** на Phase 4c
  (Deleted sub-tab і `🗑 M` лічильник додаються у Phase 5, коли
  TrashStore існує — інакше counter завжди 0 і клік веде у nonfunctional pane)
- [ ] Status bar: **тільки `🔀 N`** на Phase 4c
  (`🗑 M` додається у Phase 5 разом з Deleted sub-tab)
- [ ] (опційно) ribbon button (R2.7.4) — клік відкриває Conflicts
- [ ] View registration `diff2-edit-view` у main.ts
- [ ] **Видалити** реєстрацію `sync2-conflict-view` (NO LEGACY); жодного
  alias-redirect-у
- [ ] Прибрати з `main.ts` існуючі команди з дефолтними `Alt-N`/`Alt-1/2/3`
  hotkey-ами (R7.9: no default hotkeys)
- [ ] Підписки на DiffEditEvents для live-update списків
- [ ] Активувати A20 (авгієві конюшні)

### Phase 5 — TrashStore + Recently-deleted UX core (R3.1–R3.5)
- [ ] `src/diff2/trash-store.ts` — `create()`, `restore()`, `confirmDeleted()`, `list()`
- [ ] `vault.on('delete')` → trashStore.create + move (не copy)
- [ ] Rename-deduplication (R3.3): 500мс window, `pendingDeletes` map
- [ ] **Transactional rename** (R3.3) — через `.tmp/rename-<txId>/`
  + manifest, 3 фази (prepare/commit/done)
- [ ] `processBatch` post-commit → `confirmDeleted(batch.deletions)` (TTL=0)
- [ ] Pull-deletes skip trash (R3.4)
- [ ] **Crash recovery sweep** на onload: TrashStore.recoverIncomplete()
  + `.tmp/rename-*/` sweep (R3.3)
- [ ] **Kill-mid-op tests** для кожної з 3 rename-фаз
- [ ] **Розширити Conflicts UI** (Phase 4c shell-ом): додати Deleted
  sub-tab `[Conflicts (N)] [Deleted (M)]` (R2.7) — тепер TrashStore
  існує, counter валідний
- [ ] Розширити status bar: додати `🗑 M` counter — повний шаблон
  `🔀 N · 🗑 M` (R2.7.3)
- [ ] Активувати A6, A7, A8, A9

### Phase 6 — R4 T3 bundle (delete main file with N conflicts)
- [ ] `ConflictStore.cascadeBundleToTrash(vaultPath, trashStore)`
- [ ] `cascadeInProgress: Set<vaultPath>` guard (R4.2, двошаровий)
- [ ] `TrashStore.createBundle()` + `restoreBundle()`
- [ ] **Crash recovery**: bundle половинно створено → onload sweep
  reconstruction (Принцип #9):
  - main file у `.trash/` але siblings ще у vault → fixup (move siblings)
  - main file у vault, siblings у `.trash/` bundle → fixup (move main)
- [ ] Активувати A14, A15, A16

### Phase 7 — File history (R2.3) + History mode (R7.9b)
- [ ] `client.listCommitsForPath(path, branch, opts)` + unit-тести
- [ ] `src/diff2/history-list.ts` — GitHub + push-queue fallback
- [ ] History mode toolbar (R7.9b): `[←]`, `✏️/🔒` toggle (read-only ↔ edit),
  `[Restore this version]` з confirm-модалкою
- [ ] Налаштування `fileHistoryListSize` (default 10) у settings tab
- [ ] Command palette: `Show history of active file`
- [ ] Активувати A10

### Phase 8 — GitHub-частина для Recently deleted (R3.6) + Deleted mode (R7.9d)
- [ ] Витягти deletions з останніх commit-ів через `listCommitsForPath` + `compare`
- [ ] Об'єднати з trash list, відфільтрувати path-only-when-empty (R2.4)
- [ ] Restore з GitHub: `getContentsAtRef` → write → next sync push-ить resurrection
- [ ] Deleted mode toolbar (R7.9d): `[←]`, `[Restore]`, `[Refresh from GitHub]`
- [ ] Налаштування `recentlyDeletedListSize` (default 30) у settings tab

### Phase 9 — Compare any two files (R2.1) + Compare mode (R7.9c)
- [ ] `app.workspace.on('file-menu')` — `Compare with…`
- [ ] `src/diff2/compare-picker.ts` — `FuzzySuggestModal`
- [ ] **API research** (Desktop only filesystem picker, R2.1):
  - дослідити сучасні шляхи (Obsidian `app.fileManager`, modern Electron IPC, Capacitor-API)
  - **Якщо знайшли** → реалізувати `[Browse filesystem…]` за сучасним API
  - **Якщо не знайшли** → scope-cut: filesystem browse не входить у v1,
    переноситься у "Не входить у scope"
- [ ] Compare mode toolbar (R7.9c): `[←]`, `✏️/🔒` toggle, `[Swap]`
- [ ] Commands: `Compare two files…`, `Compare active file with…`
- [ ] Активувати A23 (mobile/desktop fuzzy picker); A24/A25 — тільки якщо filesystem picker реалізовано

### Phase 10 — External diff tool (R6, desktop-only)
- [ ] Settings UI секція "External diff tool" (платформ-gated)
- [ ] `src/diff2/external-diff.ts` — argv-splitter + `spawn` без shell
- [ ] Кнопка `[Open in external tool]` у toolbar (R7.9*)
- [ ] Default-route у Conflicts list клік (R6.3 A) — toggle
- [ ] Cleanup `.tmp/<id>/` після exit процесу (Crash resilience:
  onload sweep видаляє orphan `.tmp/<id>/`)
- [ ] Unit-тести argv-splitter (квоти, escape, едж кейси)
- [ ] Integration-тест з mock-командою
- [ ] Документація: 6 прикладів команд для Win/macOS/Linux у README
- [ ] Активувати A12, A13

### Phase 11 — Crash resilience pass (R8)
**Прохід по всьому алгоритму diff2 з питанням "що буде якщо тут впаде?"**
- [ ] Документація R8 (нова секція нижче) — recovery sweeps по сторам
- [ ] Об'єднати recovery sweeps з різних фаз у єдиний `onloadRecoverySweep()`
- [ ] Прогон під fault-injection (kill mid-op для кожного store) —
  переконатись, що жоден з 535 існуючих тестів і acceptance-тестів A1–A25
  не зламаний
- [ ] Документувати у CLAUDE.md "Diff-Edit widget" нову секцію
  "Crash resilience invariants"

### Phase 12 — Doc + cleanup
- [ ] Оновити CLAUDE.md: розділ "Diff-Edit widget (planned)" → "Diff-Edit widget"
  (без `planned`), повна заміна "Conflict resolution" section з урахуванням
  усіх нових механізмів
- [ ] Прибрати з CLAUDE.md згадку "the conflict-view UX is the one area
  still openly known to be primitive"
- [ ] Оновити README з новим UX (mobile + desktop)
- [ ] Прогон `pnpm test` + `pnpm test:integration` — переконатись, що
  E-серії і інші conflict-related тести зелені
- [ ] Видалити з MOBILE-TESTING.md (якщо є) посилання на legacy ConflictModal/View

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
21. **A21** (R3.3 — конфлікти слідують за файлом, rename event):
    `Folder1/note.md` має 2 pending конфлікти (два sibling-файли
    `Folder1/note.conflict-from-Phone-<ts1>.md`,
    `Folder1/note.conflict-from-Tablet-<ts2>.md` + два записи у
    ConflictStore + дві `.conflicts/<id>/` директорії на диску). Користувач
    переміщує `note.md` у `Folder2/` (Obsidian fire-ить `rename` event).
    Очікувано:
    - обидва sibling-файли також переміщуються у `Folder2/` за тим самим
      шаблоном `buildSiblingPath()` з новим vault-path-ом:
      `Folder2/note.conflict-from-Phone-<ts1>.md`,
      `Folder2/note.conflict-from-Tablet-<ts2>.md`
    - ConflictStore re-індексує обидва записи: `record.vaultPath` і
      `record.siblingPath` оновлені, `byVaultPath` re-keyed з `Folder1/note.md`
      на `Folder2/note.md`, `bySiblingPath` re-keyed
    - `.conflicts/<id>/meta.json` обох записів переписано зі свіжими полями
    - статусбар лічильник **не змінюється** (конфлікти не resolve-ляться,
      лише переїжджають разом з файлом)
    - відкриття Diff-Edit показує ті самі 2 записи з новими path-ами
22. **A22** (R3.3 — конфлікти слідують за файлом, drag-drop edge case):
    те саме що A21, але Obsidian fire-ить послідовність `delete` + `create`
    у 500мс-вікні (не `rename`). Очікувано: rename-deduplication path
    розпізнає це як move (SHA+size match), і замість того щоб просто
    drop-нути trash entry, виконує bundle-migration: `.conflicts/<id>/`
    записи повертаються з trash-bundle у плагін-config dir, sibling-файли
    пишуться у vault під новими шляхами з theirs-байтів, ConflictStore
    re-індексується. Trash-bundle видаляється.

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

- ~~**Перемикання між 4 режимами**~~ — **RESOLVED 2026-05-17**, див.
  R2.7. Асиметричні entry-points: Conflicts/Deleted як sub-tabs у
  глобальному header-і diff2 view; Compare/History — file-bound,
  через контекстне меню і command palette.
- ~~**Назви кнопок**~~ — **RESOLVED 2026-05-18**, див. R7.9 (finalized
  block). Три рівні UI: list-level `[Keep all local]`/`[Apply all remote]`/`[Join all]`,
  file-level те саме плюс device-імена в дужках, per-chunk `[apply]`/`[remove]`
  на верхньому і нижньому маркерах + `[apply both]`/`[remove both]` на середньому.
- ~~**Налаштування періоду GitHub history**~~ — **RESOLVED 2026-05-18**.
  Одна settings-опція `recentlyDeletedListSize: number` (default `30`)
  у Settings tab плагіна, секція "Diff-Edit" (або поряд з іншими
  diff2-налаштуваннями). Семантика — **максимальна кількість записів
  у Recently deleted list** (local trash + GitHub deletions
  після злиття і сортування за датою). Жодного "Load more" UX не
  реалізуємо — користувач, якому потрібно більше, відкриває Settings
  і змінює число (наприклад, з 30 на 300). Це радикально спрощує
  list-rendering і pagination-логіку.
- ~~**Performance: how many commits/page**~~ — **RESOLVED 2026-05-18**.
  Та сама логіка, що для Recently deleted (R2.7-аналог):
  - Settings-опція `fileHistoryListSize: number` (default `10`)
    у Settings tab плагіна.
  - Один (або кілька, якщо `listSize > 100`) eager-запит при відкритті
    History: `per_page = Math.min(listSize, 100)`, далі `Math.ceil(listSize / 100)`
    сторінок поспіль. Без `[Load more]`-UX.
  - Кому потрібно більше — відкриває Settings і ставить 100 / 500 / 1000.
  Це: один setting, передбачуваний eager-fetch, нуль pagination-UX.
- ~~**Deleted with renames**~~ — **RESOLVED 2026-05-18**. Жодної
  спеціальної логіки для renames. Семантика — **path-bound**, не
  file-identity-bound:
  - **Rename у інший каталог**: GitHub-commit виглядає як `old_path
    deleted` + `new_path added`. Старий path показується у Recently
    deleted як звичайне видалення. Користувач може Restore — це
    легітимна дія "повернути копію на старе місце" (захист від
    випадкового drag-drop). Сховати = приховати інформацію.
  - **Delete + re-create за тим самим path**: R2.4 path-only-when-empty
    filter прибирає запис з Recently deleted, щойно новий файл
    займає path. Історія path-а (R2.3) показує **повний ланцюжок
    коммітів** для цього path, включно з історією попереднього файлу
    — як `git log <path>`. Це не bug, а consistent path-bound model.

---

## Не входить у scope 

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