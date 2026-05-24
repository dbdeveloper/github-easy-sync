# Diff-Edit Widget — Implementation Plan

> Документ описує комплексне переосмислення Diff-Edit / Conflict-View UX
> для плагіна `github-easy-sync`. "the conflict-view
> UX is the one area still openly known to be primitive" — цей план
> закриває цю дірку.

## Назва підпроекту: `diff2`

Цей підпроект отримує канонічну назву **`diff2`** — по аналогії з
існуючим `sync2` (модуль sync-движка). Іменування:

- **Модуль:** `src/diff2/` (новий каталог поруч з `src/sync2/`).
- **View type ID:** `diff2-edit-view` 
- **Імена класів/файлів** усередині `diff2/` — без префіксу `diff2-`
  (бо namespace вже даний папкою): зразок: `events.ts`, `diff-pane.ts`, 
  `diff-edit-view.ts`, ...
- **Obsidian commands** — **БЕЗ ручного префіксу "Diff2:"**.
  Obsidian command palette **автоматично** префіксує усі команди
  display-ім'ям плагіна з `manifest.json` (`github-easy-sync`).
  Тому у коді задаємо тільки кoмандні імена, наприклад
  `Compare two files…`, `Open Diff-Edit`, `Next chunk`,
  `Show history of active file`. У палітрі вони відображаються як
  `github-easy-sync: Compare two files…`. Подвійний префікс
  ("github-easy-sync: Diff2: …") нечитабельний — уникаємо.

Поділ обов'язків між `sync2/` і `diff2/`:
- `sync2/` — sync engine, як зараз. Власник `ConflictStore`
  (генерує конфлікти під час sync). Лишається без структурних змін;
  точкові додатки на event-emit-и при мутаціях.
- `diff2/` — Diff-Edit widget. **Споживач** `ConflictStore`,
  **власник** `TrashStore` (history of deleted files 
  (from .push-queue + gitHub repo)) та `DiffPane` (CM6 редактор).

Архітектурний інваріант: `diff2/` залежить від `sync2/` (читає
конфлікти, моніторить дії користувача), але `sync2/` **не залежить**
від `diff2/`. Це дає змогу зібрати плагін без `diff2/` (як зараз - v.2.0.1-beta) - наприклад,
для регрес-перевірок) і випустити `diff2/` як майбутній окремий
плагін, якщо колись з'явиться сенс.

## ⚠️ Принципи реалізації (обов'язкові)

**Цей розділ — обов'язковий до прочитання перед будь-якою кодовою
зміною за цим планом.**

1. **Scope — суворо в межах цього плану.** Застосовувати **тільки**
   зміни, які стосуються Diff-Edit widget і пов'язаних з ним вимог
   (R1–R7). Не причісувати інший код "заодно", не рефакторити
   суміжні модулі, не "виправляти, що очі бачать".

2. **Не порушувати роботу основного плагіну.** `github-easy-sync` —
   це working production-плагін з 429 unit-тестами і ~106 integration-
   тестами (серії A–L, див. CLAUDE.md). Уся існуюча поведінка sync-
   рушія (bootstrap, adoption, normalize, incremental, atomic
   conflicts, multi-device, drift, settings, auth, manifest,
   accumulate) має лишитись **бітово ідентичною** після реалізації
   цього плану. Будь-який regression-сигнал у існуючих тестах =
   стоп-сигнал.

3. **Мінімізувати модифікації за межами Diff-Edit.** За замовчуванням
   нові файли під `src/diff2/` (новий каталог підпроєкт) +
   точкові правки у `src/main.ts` для wire-up. Якщо план вимагає
   зміни у `sync2-manager.ts`, `change-detector.ts`,
   `conflict-store.ts`, `client.ts` тощо — **виокремлювати у
   найдрібніші можливі діффи** і верифікувати кожен через тести, що існують
   (`pnpm test` + `pnpm test:integration`).

4. **Тести — додаємо, не заміняємо.** Нові acceptance/unit-тести — додаткові файли. **Не модифікувати** існуючі тести
   без явного дозволу автора. Якщо тест, що існує, починає падати — це означає, що зміна порушила фіксовану 
   поведінку, а не що тест "застарілий". Шукати корінь проблеми в новому коді.

5. **Якщо все ж потрібно змінити поточний файл/тест** — зупинитись,
   **запитати дозвіл в автора** з конкретним обґрунтуванням ("для
   реалізації R-X треба змінити Y, ось альтернативи, ось ризики"),
   і вносити зміну дуже ретельно з повним прогоном тестів "до і
   після".

6. **Phase-by-phase, не "великий вибух".** Реалізація йде фазами
   (Phase 0 → Phase 8). Кожна фаза — окремий PR, що сам по собі
   не ламає main. Розгортання інкрементально, з можливістю
   зупинитись на будь-якій фазі, і мати працездатний плагін.

7. **CLAUDE.md, docs/PSEUDO-MERGE-MODE.md, і цей документ - як джерело істини про поточну поведінку.** 
   Перед зміною будь-якого наявного механізму — перечитати відповідний розділ цих документів і відповідні 
   integration-тести. Якщо знайдена суперечність план-vs-CLAUDE.md — виносити обговорення, не "вирішувати на ходу".

## Мотивація

Поточний стан (2.0.1-beta):

- Після sync у дереві каталогів Vault можуть з'являтись `*.conflict-from*` файли, які і є джерелом інформації для diff2. 
  Зараз користувач може розв'язувати конфлікти методом маніпуляції цими файлами з допомогою операцій Obsidian: 
  file edit/delete/rename (на прикладі файлу a.md):

  | Тип конфлікту     | Розв'язок в сторону local file                               | Розв'язок в сторону remote file                            |  
  |-------------------|--------------------------------------------------------------|------------------------------------------------------------|
  | modify-vs-modify  | delete a.conflict-from-remote-{dt}.md                        | delete a.md; rename a.conflict-from-remote-{dt}.md to a.md |
  | modify-vs-modify  | diff a.md a.conflict-from-remote-{dt}.md and make them equal | --                                                         |
  | delete-vs-modify  | delete a.conflict-from-remote-{dt}.md                        | rename a.conflict-from-remote-{dt}.md to a.md              |
  | modify-vs-delete  | розв'язується автоматично в сторону local file               | --                                                         |

- Це дозволяє вирішувати конфлікти без використання спеціального інтерфейсу, однак, для більш точного розв'язання 
  конфліктів між двома текстовими файлами на рівні окремих текстових блоків чи рядків, оптимальніше використовувати 
  додатковий інструмент для розв'язання конфлікту (diff3, diff2, merge3, merge2).

## Цілі:

- Перетворити Diff-Edit на **уніфікований інструмент** для всіх
  пов'язаних задач: 
  - розв'язання конфліктів, 
  - історія змін (diff-порівняння попередніх версій будь-якого текстового файлу з Vault з його версіями з GitHub repo),
  - відновлення видалених файлів (за рахунок збережених копій в GitHub repo і, у режимі offline, тимчасово, – 
    з .push-queue/.
  - порівняння довільних (текстових) файлів,

Форма UI обговорюється окремо.

---

## Вимоги

**R1.** Після завершення `drain()`, якщо за час цього sync-у було створено хоча б один запис у ConflictStore 
(а отже, у дереві каталогів Obsidian Vault є хоча б один `*.conflict-from*` файл), тільки ConflictCounter (який слухає 
vault event listeners (update, rename, delete)) знає скільки точно файлів зараз перебуває у конфлікті.
Цього не знає навіть ConflictStore, який оновиться тільки з наступним drain, а до цього моменту він зберігає в собі всі
конфлікти на момент закінчення drain. Ці два джерела інформації ми й повинні використовувати, щоб при активації 
diff2 UI (conflict list), наприклад, через click по badge, показувався список актуальних, ще не вирішених конфліктів, 
вибравши будь-який з них, відкриває diff-editor, в який як параметри передаються два файли: базовий файл і 
один з його conflict-siblins. 

Задача diff-editor — допомагати користувачу вирішувати блоки конфліктів один за одним, і поступово розв'язувати конфлікти, 
залишаючи те рішення, яке потрібне (або комібінувати рішення, або через редагування додавати зовсім інше). 
На рівні вхідних в diff-editor файлів відбувається поступове злагодження цих двох файлів між собою, аж поки вони не 
стануть повністю тотожніми один одному, що і буде вважатись розв'язанням конфлікту. Бо саме умова: 
SHA(base-file) == SHA(conflict-sibling) сприймається підсистемою PSEUDO-MERGE-MODE як розв'язок конфлікту 
(docs/PSEUDO-MERGE-MODE.md, §8). При цьому, conflict-sibling-file буде видалено при наступному sync, так, як він повністю
тотожній базовому, а вже базовий файл буде використаний як остаточний результат вирішення цього конфлікту.

Далі буде вказано, що необхідно при цьому тримати undo/redo-історію, щоб можна було відміняти зміни, якщо виникне 
бажання змінити своє рішення.


### R2. Diff-Edit widget — функціональні режими і навігація

**Дві основні мети використання widget-у** (mental model для користувача):

1. **Conflicts mode** — список pending конфліктів (береться з ConflictStore minus вже вирішені конфлікти на файловій 
   системі (тобто береться список конфліктів з ConflictStore і з них віднімаються всі конфлікти, для яких на файловій
   системі на момент "тут-і-зараз" відсутні `*.conflict-from*` sibling-файли)). 

   Клік по вибраному конфлікту → відкриває diff-editor на весь tab з параметрами: локальним базовим файлом (ours) і 
   його conflict-sibling-версією (theirs). Користувач resolve-ить через кнопки `[apply]/[remove]` per chunk або 
   групові `[Keep all local]` / `[Apply all remote]` тощо.

2. **File history mode** — список попередніх версій конкретного файлу (з GitHub або push-queue). Клік по версії → 
   відкриває diff-edit на весь tab між поточним файлом (ours) і обраною історичною версією (theirs).

   Цей режим має **дві суб-поведінки** з перемиканням через **toggle-іконку у top toolbar** (напр., `🔒` коли read-only,
   `✏️` коли editable; точна іконка обирається при імплементації):

   - **Edit mode** (default, іконка `✏️`): працює як conflict resolution — chunk-action кнопки `[apply]/[remove]` доступні,
     edits у поточному файлі зберігаються. Користувач може вибірково "повернути" частину старого тексту (наприклад, відновити
     випадково видалений абзац з версії файлу, закоміченої в GitHub repo 3 коммітів тому), не повертаючи весь файл.
   
   - **Reference mode** (toggle: `🔒`): **read-only** перегляд. Обидві сторони (current та historical) заблоковані від
     модифікації. Chunk-action кнопки та `[apply]/[remove]` приховані. 
     Залишаються:
     - Виділення тексту і **копіювання** (Cmd/Ctrl+C працює).
     - Навігація між chunk-ами (`[↑]`/`[↓]` у footer).
     - Кнопки `[Restore entire version]` (rewrite current file байтами обраної версії) та `[←]` back залишаються — це
       не "редагування", а атомарна операція над файлом цілком. 
     - Візуальний індикатор: невеликий "Read-only" badge біля заголовка path, плюс трохи дімований фон pane-у.

   Default — Reference, бо це частіший сценарій. Edit mode для випадків "справді хочу внести зміни в поточний файл"

   *Та сама toggle-іконка доступна у Compare mode* (R2.1) — для тих самих причин (хочу порівняти, але не редагувати). 
   У Conflicts mode (R2.2) tоggle не доступний — там сенс саме у resolve, який потребує edit-у. У Deleted mode (R2.4) 
   widget вже фактично read-only за замовчуванням (нема "ours" як такого).

**Інші два режими** (Compare any two, Deleted files) — корисні доповнення (R2.1, R2.4), але **Conflicts** і 
**History** — це дві основні стежки, заради яких widget існує.

Отже, підсумоуємо:

Diff-Edit widget підтримує чотири функціональні режими (Conflicts / Compare / History / Deleted) та **single-pane 
навігацію** між ними.

**R2.0. Single-pane shell.** На відміну від попереднього (V.2.0.0-beta) two-pane layout-у (`ConflictView` з лівою 
колонкою списку + правою з DiffPane), новий widget — це **один tab без побічних колонок**. У будь-який момент tab 
показує або:
- **list view** (список конфліктів / список історії / список видалених), на ширину всього tab-у, або
- **detail view** (один обраний файл — DiffPane з top-toolbar-ом для повернення назад до list view)

Перехід між list і detail — стрілкою `[←]` у toolbar детального viewer-а (повернення в list); кліком по елементу списку 
(відкриття detail для нього).

Причини відмови від двопанельного layout-у:
1. На мобільному екрані ліва панель забирає 30–50% ширини, що робить detail view нечитабельним.
2. Якщо користувач працює через зовнішній diff (R6), detail-частина взагалі не потрібна — він хоче бачити повноширокий 
   список.
3. Узгоджена single-pane модель спрощує state-машину і відповідає Obsidian mobile-native поведінці (back-stack навігація).


**R2.1. Compare any two files.**

*Що порівнюємо*:

- два звичайні файли з vault (`a.md` vs `b.md`)
- файл vs sibling (`note.md` vs `note.conflict-from-...md`)
- файл vs trash entry (`note.md` vs видалений `note.md`)
- (desktop only) файл з vault vs файл з filesystem (вибраний через OS-нативний picker (тільки desktop!)) — наприклад, 
  файл з іншого vault, або взагалі будь-який текст на диску).
- 

*Точки входу*:

1. **Контекстне меню файлу** у file-explorer-і Obsidian: 
   натиснути right-click (або long-tap на mobile) на файлі → пункт "Compare with…". Реєструється через 
   `app.workspace.on('file-menu', cb)` стандартним API.

2. **Command palette**: 
   команди `Compare two files…` (просить вибрати обидва), і `Compare active file with…` (active file = top, picker для 
   bottom). Префікс `github-easy-sync:` додається Obsidian автоматично.

3. **Зсередини Diff2**: режим Compare у мode-перемикачі (TBD-розділ про навігацію між режимами).


*File picker*:

- **Same-vault** (default, кросплатформово): `FuzzySuggestModal` зі списком `app.vault.getFiles()`. Так само як 
  стандартний "Quick switcher" Obsidian. Працює на desktop і mobile однаково.

- **Filesystem browse** (desktop only, **API TBR — to be researched**): Під списком fuzzy-suggest опційна кнопка 
  `[Browse filesystem…]`. **Однак, `@electron/remote` deprecated з Electron 12** і не доступний у свіжих 
  Obsidian-збірках. Тому на Phase 11 (Compare any two files):
  - **Спочатку дослідити сучасні API**: чи Obsidian експортує `app.fileManager`-API для filesystem picker; чи доступний
    `electron.ipcRenderer` + main-process bridge; чи Capacitor-API (`@capacitor/filesystem`) працює на Obsidian Desktop 
    під капотом.
  - **Якщо знайшли сучасний шлях** — реалізуємо filesystem picker за ним; gated на `Platform.isDesktopApp`; обраний файл 
    отримує "віртуальний path" `fs://${absolute-path}` у заголовку DiffPane, не імпортується у vault.
  - **Якщо не знайшли** — **scope-cut**: filesystem browse видаляється з R2.1; перелік супутніх можливостей (compare з 
    файлом поза vault) переноситься у "Не входить у scope". Користувач, якому потрібно порівняти з зовнішнім файлом, 
    копіює його у vault (тимчасово), або використовує external diff tool R6 з manual path-аргументами.
  - Жодного `@electron/remote` у production-бандлі — навіть як lazy `require()`. Це deprecated API; ризик ENOENT на 
    свіжих Obsidian збірках + майбутні мажорки Electron повністю його приберуть.

- **Cross-vault** як окремий концепт не виділяємо — фактично це довільний filesystem-файл, який desktop-picker 
  (якщо реалізовано) покриває.

*Mobile-обмеження*: на iOS/Android доступ до файлів поза vault-каталогом неможливий через sandboxing ОС 
(принаймні для iOS, для Android є можливість встановлення Obsidian Vault за межами Application Sandbox). Mobile 
користувач може порівнювати тільки два файли зі свого vault. Це обмеження платформи, не плагіну; fix не передбачається.
TODO: дослідити чи розгашування Vault за межами Sandbox дозволяє отримати з Obsidian доступ до файлів за межами Vault.

*Режим відображення*: unified DiffPane (R7) у Compare-toolbar-варіанті (R7.9c). Default — **Reference (read-only)** 
(✏️ toggle перемикає у Edit). Per-chunk `[apply]/[remove]` доступні в Edit mode (для тих хто хоче синхронізувати один 
файл з іншим). Marker block-widgets (`<<</===/>>>`) тут **не рендеряться** — нема "conflict context", просто кольорове 
підсвічення diff-chunks + word-level highlight.

**R2.2. Conflicts list (повноширокий, list view).** Список усіх sibling-файлів `*.conflict-from-*` (тільки тих, які 
зареєстровані в ConflictStore!) з групуванням за оригінальним vault path. Список займає **усю ширину tab-у**.

NOTE (R2.2): може, ті sibling-файли, які не зареєстровані в ConflictStore також показувати тут, але в іншому кольорі - 
дозволяти їх видаляти прямо тут або й diff з ними (це не впливатиме на розв'язання конфліктів, просто може допомогти 
внести певні зміни в base-файл і, навіть(!), дозволить самим diff2 ВИДАЛИТИ цей файл-сироту з системи, коли її вміст 
збіжиться з основним в результаті diff). (???)

Зверху над списком — **toolbar з груповими операціями над усіма конфліктами**:

- `[Keep all local changes]` — для всіх записів зберегти ours, видалити всі sibling-и (масовий take-ours).
- `[Apply all remote changes]` — для всіх записів перезаписати ours = theirs, видалити всі sibling-и (масовий take-theirs).
- `[Join all changes]` *(markdown only)* — для всіх md-записів викликати `conflict-merge-all.ts::mergeIntoOne()` каскадом
  (theirs додається як `> blockquote` callout під ours). Кнопка прихована або disabled, якщо у списку немає markdown-конфліктів,
  щоб не наводити користувача на помилку.

Кожен елемент списку клікабельний → перехід у **detail view** з DiffPane (R7), де є додатковий top-toolbar з тими ж 
операціями, але для одного файлу (R7.9-onepan).

**R2.3. File history** — для довільного файлу з vault показати історію його змін. Джерела:
1. **Push queue fallback** — якщо немає мережі або клієнт у
   `bare` стані, показати локальні pending-батчі (читання
   `.push-queue/<id>/vault/<path>` + meta).
   ОСОБЛИВІСТЬ ЦЬОГО РЕЖИМУ: якщо в .push-queue/ є ХОЧА Б ОДИН(!) COMMIT-BRANCH (не merge!) - показуємо в File history 
   ТІЛЬКИ вміст .push-queue, і внизу кнопку `<Show GitHub history...>`. Objection: якщо в .push-queue/ є записи, то 
   (з великою ймовірністю) нема зв'язку з GitHub repo, перевіряти це - це гаяти час, і 90% у користувача буде виникати 
   потреба глянути попередню версію файли, ніж переглядати далекі історії, однак, якщо в .push-queue/ 0 записів (порожньо!) - 
   це можна пояснювати тим, що зв'язок з інтернетом є, і також це вказує на те, що порожній список історії, швидше за все
   не задовільнить користувача, тому в цьому випадку потрібно негайно спробувати скачати історію з GitHub! Див,п2:
2. **GitHub** — список commit-ів, що змінили цей шлях. Потребує нової обгортки `GithubClient.listCommitsForPath(path, branch,
   {since?, perPage?, page?})` навколо `GET /repos/{owner}/{repo}/commits?path={path}&sha={branch}`.

Кожен елемент історії клікабельний → відкриває DiffPane (current vs selected-version). У DiffPane при перегляді 
історії `theirsReadOnly: true` (вже передбачено у DiffPane API). Кнопка "Restore this version" у footer DiffPane — 
перезаписує current vault file байтами обраної версії.

**R2.4. Deleted files (Recently deleted)** — той самий single-pane shell (R2.0), що й Conflicts mode, але **спрощений 
detail view**.

Для реалізації цього режиму необхідно додати до github-easy-diff .trash/ директорію, де будуть зберігатись видаліні 
(В ЦІЙ SYNC-СЕСІЇ ТІЛЬКИ!!!) файли. Що це означає? Це означає, що в plugins/github-easy-diff/.trash/ будуть зберігатись
видалені файли тільки до наступного Sync, після чого ми вважаємо, що цей файл більше користувачу не потрібний, і 
відновити цей файл можна буде тільки з GitHub repo. Якщо ж файл було створено і видалено в одному циклі Sync
(між двома sync) - файл втрачається незворотньо.

*List view*: повноширокий список trash-entries + GitHub-recent-deletions (уніфіковано, як описано в R3.6). Кожен 
елемент показує: vault path, коли видалено, джерело (`local trash` / `GitHub history`), розмір.
Top toolbar:
- `[Refresh from GitHub]` — примусово витягнути свіжий `listCommitsForPath` для оновлення віддалених видалень.

Жодної кнопки масової очистки trash немає — local-trash записи й так очищуються автоматично після того, як sync 
підтвердив відповідне видалення на GitHub (TTL=0, R3.5). Залишати "Empty trash" кнопку означало б давати ризиковану дію, 
яка нічого корисного не покриває.

*Detail view* (кліком по елементу): **read-only прев'ю**, що використовує ту саму CM6-інфраструктуру, що й Diff-Edit 
(R7), але у спрощеному режимі:
- **Без `<<</===/>>>` marker block-widgets** (нема двох сторін — файл просто видалений, є тільки одна версія: 
  deleted content).
- **Без per-chunk action кнопок** (нема конфлікту).
- **Без word-level diff** (нема пари для порівняння).
- Документ показується як **plain markdown / text** з line numbers у gutter — як одностороння версія DiffPane.
- Заголовок: `<vaultPath> · deleted <ts> from <local trash> | <GitHub history>`.

Top toolbar (detail):
- `[←]` — back to list view.
- `[Restore]` — повернути файл за оригінальним path-ом. Колізії немає
  за визначенням (див. нижче "Path-only-when-empty filter").

**Path-only-when-empty filter.** Recently deleted list (як local-trash, так і GitHub-history entries) рендериться через 
фільтр: запис показується **лише якщо path зараз порожній у vault**
(`app.vault.getAbstractFileByPath(path) === null`). Якщо користувач створив новий файл з тим самим іменем — запис 
автоматично зникає зі списку:
- TrashStore підписаний на `vault.on('create', file)`: при матчі `originalPath` запис прибирається з in-memory index 
  (фізично `.trash/<id>/` ще лежить на диску до наступного [Sync with GitHub] — для можливого manual recovery через 
  filesystem, але у UI його нема).
- GitHub-history entries фільтруються лінивим API на момент рендеру списку.

Логіка: система **не розрізняє** "файл був видалений і відновлений" vs "файл був видалений і створено новий за тим 
самим іменем" — для неї це просто історія path-а. Минулі версії того, що було за цим path-ом до повторного створення, 
доступні через File history mode (R2.3) — там видно ланцюжок "...commits, deletion commit, ...commits, 
re-creation commit, ...current commits", як у звичайному `git log <path>`.

Кнопка `[Restore as…]` (відновлення під іншим іменем) **не потрібна** — у списку немає колізій за визначенням, тому 
єдина дія "restore" завжди безпечна.

Diff-Edit widget (R7) **переюзовується**, але з прапорцем `mode: "preview"` (на додачу до існуючого `mode: "merge"`, 
який буде введений у Phase 7). Не окреме нове вікно, не окремий редактор. Кодова база лишається єдиною.

**R2.5. Delete-vs-modify conflict — конфлікт без основного файлу.**

Сценарій: користувач локально видалив `note.md`. Одночасно на іншому пристрої цей файл був модифікований. sync2-manager 
це бачить як delete-vs-modify і викликає `onConflict` з `ours = ""` (порожньо = видалення), `theirs = <remote content>`. 
ConflictStore створює запис і sibling-файл `note.conflict-from-<remoteDevice>-<ts>.md` з theirs байтами.

Унікальна особливість: **`vaultPath` файл відсутній у vault** (його видалив користувач), але `siblingPath` присутній. 
Це єдиний випадок, коли запис у ConflictStore вказує на vault path, що не існує (p.s. іншим випадком є проміжний 
результат, коли користувач, в рамках вирішення конфлікту сам видалив base-file, щоб наступним кроком перейменувати 
`base.conflict-from-<remoteDevice>-<ts>.md` на нього ж).

*Візуалізація в list view (R2.2)*: цей запис показується з **badge `[deleted locally]`** одразу після path-у, в italic
кольорі. Поведінка кліку та сама — переход у detail view.

*Візуалізація в detail view (R7)*: DiffPane рендериться нормально, але ours-сторона порожня (0 рядків). 
Конфліктний блок виглядає так:

```
    | <<< Obsidian (Mac): [apply][remove]
    | === [apply both][remove both]
 1 +| <theirs line 1>
 2 +| <theirs line 2>
 3 +| <theirs line 3>
    | >>> GitHub (Phone): [apply][remove]
```

Тобто верхній (red/ours) блок порожній — між `<<<` маркером і `===` маркером немає жодного рядка. Це **природна** 
ситуація для нашої розмітки і не потребує спеціальних винятків у CM6 коді.

*Семантика top-toolbar кнопок для delete-vs-modify*:
- `[Keep all local changes]` = "залишити видалення" → final = empty → vault file НЕ створюється; sibling + ConflictStore запис
  видаляються; намір користувача видалити файл - підтверджується і при наступному [sync] конфлікт розв'язується в сторону [delete]
- `[Apply all remote changes]` = "відновити з GitHub" → final = theirs → vault file створюється з theirs контентом;
  після цього з'являється base-file з вмістом віддаленного (sibling) і при наступному [sync] конфлікт розв'язується в 
  сторону [remote modified] (який вже зкопійовано в base-file, sibling-файл буде вилучено).
- `[Join all]` *(md only)* — **сховано** для delete-vs-modify (нема ours щоб об'єднувати з; результат був би просто theirs).

*Auto-resolve T2 (R4)*: якщо користувач створює файл `note.md` у vault вручну і він стає байт-рівним sibling-у — конфлікт resolve-иться
"resurrection"-шляхом (файл створено, видалення забрано з queue). Edge case, але узгоджено з R4.

*sync2-manager уже підтримує* цей сценарій (CLAUDE.md: "Local-deleted vs remote-modified"). Все що нам треба — коректно відрендерити у
DiffPane коли `ours === ""` і додати `[deleted locally]` badge у list view.

**R2.6. Sync файлів з pending конфліктами — поведінка зафіксована у pseudo-merge mode, нічого додаткового не вводимо.**

У 2.0.1-beta (canonical: [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md) §8 "Editing While in Conflict") 
користувач **може вільно редагувати** файл, який знаходиться у конфлікті, і всі такі редагування **накопичуються як 
комміти на per-device conflict branch** — не йдуть на `main`, але і не відкидаються. Це load-bearing feature, а не 
недолік: §4.4 preserve-all-commits гарантує, що кожна ітерація буде доступна назавжди через GitHub history після 
фінального merge-commit-а.

Diff2 widget **повторює** цю поведінку:

- `Sync all` / `Sync this file` на файлі з pending конфліктами **проходять нормально**. Поточні `Sync2Manager.registerConflictAndDropPath`
  + `processBatch` partitioning розв'язують це так: path-and з pending конфліктом ідуть на conflict branch, інші — на `main`.
- Перед `[Sync]` спрацьовує **уже існуюча** `PreSyncConflictModal` (`src/sync2/views/pre-sync-conflict-modal.ts`): показує список
  pending конфліктів, дозволяє `[Resolve]` (відкриває перший sibling в editor-і) / `[Sync anyway]` (продовжити, edit-while-in-conflict
  path) / `[Cancel]`. Diff2 не дублює цю модалку; кнопка `[Resolve]` у v2 може бути перерофумована на "Open in Diff-Edit"
  (опційно, дрібний поліш).
- Жодного "refuse-to-sync" guard-у не додаємо. Це б суперечило §8 і ламало Scenario B (six branch commits during long
  resolution session — кожен з них окремий [Sync] click).
- Sibling-файли вже у `.gitignore` через `gitignore-invariants.ts`, отже на GitHub вони ніколи не потрапляють незалежно від
  sync-commands.

**N siblings per path (множинні remote версії)** — нормальна і свідома ситуація, зафіксована як §10 Scenario C ("Multi-Sibling
From Multiple Devices"). Diff2 list view (R2.2) **групує** записи за `vaultPath` як expandable rows (`note.md (3 versions)`), щоб
не виглядало хаотично. Решта механіки (`ConflictStore` dedup за `(vaultPath, theirsBlobSha)`, file-level `[Apply all remote
changes]` як швидке масове закриття) залишаються без змін.

### R2.7. Перемикання між 4 режимами (entry-points)

Resolved 2026-05-17 (раніше TBD). Принцип — **асиметричні entry-points за природою режимів**:

- **Conflicts і Deleted — глобальні списки** (не прив'язані до конкретного файлу). Усередині diff2 view вони живуть як дві
  **sub-tabs у header-і view-tab-а**: `[Conflicts (N)] [Deleted (M)]`, з лічильниками. Кожна sub-tab має власний single-pane shell
  (list ↔ detail, R2.0).

- **Compare і History — file-bound** (прив'язані до конкретного path). У глобальному shell-і їм нема де "жити" без 
  вибраного файлу (empty state "виберіть файл" — поганий UX). Тому вони **відкриваються у тому ж diff2 view як одноразові
  detail-сесії з готовим контекстом**, без sub-tab перемикача. Header у цьому випадку показує тільки заголовок поточної 
  сесії і `[←]` назад (для History `[←]` веде у list of versions, для Compare — закриває detail у picker або у
  попередню sub-tab).

**Shared 4-segment header (Conflicts | Compare | History | Deleted) відкинуто**: Compare/History без файлу дають empty 
state, що ламає симетрію tabs.

#### R2.7.1. Entry-points для Conflicts


- **Summary modal після sync** — кнопка `[Go to Diff-Edit]` відкриває diff2 view із sub-tab `Conflicts`. 

  Модалка показується **тільки коли ДО drain не було взагалі конфліктів (0), а в результаті даного drain вони з'явились.
  Тоді з'являється модкалка, яка звертає увагу користувача на нову проблему, що виникла (конфлікти), після чого пропонує
  два рішення: `[Continue]` `[Go to Diff-Edit]`. Постійне нагадування про борг вже і так існує при кожному натисненні
  [Sync] (PSEUDO-MERGE-MODE), тому після drain це роботи вже не потрібно, крім вищезгаданого випадку - коли перед цим 
  конфліктів взагалі не було.
- **Status bar icon** (див. R2.7.3) — клік відкриває diff2 view із default sub-tab за пріоритетом.
- **Ribbon button** (див. R2.7.4) — те саме.

#### R2.7.2. Entry-points для Compare / History

- **Контекстне меню файлу** у file-explorer-і Obsidian (через `app.workspace.on('file-menu', cb)`):
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

Одна групова іконка лічильником: `🔀 N`  (де `N` — кількість unresolved конфліктів).
Клік відкриває diff2 view з default sub-tab за пріоритетом:
1. `Conflicts`, якщо `N > 0`.

Якщо `N === 0` — іконка прихована

#### R2.7.4. Ribbon button (опційно)

Одна кнопка `[diff-edit]` у ribbon-і. Клік відкриває diff2 view
за тим же правилом дефолтного sub-tab-у, що й status bar (R2.7.3).
Ribbon button може бути відключений у settings — для користувачів,
які працюють лише через status bar / контекстне меню.

#### R2.7.5. Default sub-tab при відкритті diff2 view

Якщо diff2 view відкривається без явного режиму (ribbon, status bar,
summary modal) — завжди відкривається режим Conflicts (навіть якщо зараз 0 конфліктів), щов перейти на `Deleted` 
потрібно явно вибрати відповідний sub-tab в diff2-tab. Objection: уніфікованість - користувач повинен завжди отримувати 
той самий результат кожний раз як виконує певну дію. Тому перемикання табів Conflicts/Deleted за умовою не вітається.  

Якщо diff2 view відкривається з явним контекстом (Compare picker, History command, "Show history" з контекстного меню) — 
sub-tabs header **приховується** для цієї сесії, видно тільки `[←]` назад і заголовок поточного режиму. Це уникає 
змішування "глобальних боргів" з "одноразовою detail-сесією".

### R3. Recently deleted / Local trash

**R3.1.** Створити локальний "smart-trash":
`<configDir>/plugins/github-easy-sync/.trash/<id>/`
де `<id>` — 17-цифровий timestamp (та сама схема, що у `.conflicts/` та `.push-queue/`).

Кожен запис trash містить:
```
.trash/<id>/
  meta.json              ← TrashRecord {id, originalPath, deletedAt, deviceLabel, sha, size, mtime}
  vault/                 ← дзеркало vault-структури — як у .push-queue/<id>/vault/
    <originalPath>       ← фактичний файл (move, не copy)
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
  яка вже використовується sync2-рушієм для байт-снапшоту батча.

**R3.2. Move, не copy.** При локальному видаленні файлу через UI
плагін перехоплює подію `vault.on('delete', file)` і **переміщує**
файл (`adapter.rename`) у `.trash/<id>/vault/<originalPath>`,
створюючи проміжні підкаталоги за потреби (повторюючи структуру
оригінального шляху). Дисковий простір не дублюється; ліміти на
розмір не вводяться у v1.

**conflict-sibling НЕ ВИНЯТОК**: якщо `file.path` — це
sibling-файл (`*.conflict-from-*`), він **ТАКОЖ** йде у `.trash`, бо змога повернути видалений conflict файл до sync
дає змогу "передумати" і вибрати інше рішення ніж те що було прийняте через видалення.
заборона видалятись в .trash стосується тільки самої директорії .trash: `.trash/<id>/` директорій, які видаляються 
cascade-cleanup-ом (R4.1 T3) — вони видаляються atomically, без рекурсивного `.trash`.

**R3.3. Move/rename — слідкують тільки за path, а не слідують за файлом.**

**Базова rename-detection** (для файлів **без** pending конфліктів):

Obsidian для перейменування зазвичай видає `rename` event, але для
деяких drag-drop сценаріїв може бути послідовність `delete` + `create`.
Якщо виникла подія `delete` - спрацьовує збереження в .trash/ безвідносно,
чи прийде слідом `create` для файлу з тим самим (SHA+size), чи ні. 
Вважаємо що це був delete. Файл потрапляє в видалені і буде видалений при наступному sync

**Для файлів з pending конфліктами — конфлікти не переміщуються при перейменуванні**:

Якщо файл `Folder1/note.md` має N pending конфліктів (siblings
`Folder1/note.conflict-from-*.md` і відповідні `.conflicts/<id>/`
записи), і користувач переміщує його у `Folder2/note.md`, то **всі
N конфліктів ЗАЛИЩАЮТЬС В СТАРОМУ КАТАЛОЗІ** і конфлікт залишається НЕ РОЗВ'ЯЗАНИМ, поки ці siblings-файли не буде
вилучено (розв'язок через delete), або перенесені в новий каталог - в цьому випадку розв'язок всеодно буде через delete,
а самі sibling-файли відв'яжуться від файлу в конфлікті (за старою адресою) і можуть бути розв'язані в ручному режимі
(не як частина conflict-процесу) на новому місці (NOTE (R2.2)).

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
   видалити tmp директорію. (друге рішення: очищення директорії від тимчасових файлів, але не видалення)

**Manifest itself must be atomic.** Сам `manifest.json` — recovery-pointer,
тож його запис теж через temp-file + atomic rename:
```
adapter.write(`<tmpDir>/manifest.json.tmp`, JSON.stringify(state));
adapter.rename(`<tmpDir>/manifest.json.tmp`, `<tmpDir>/manifest.json`);
```
Інакше power-loss мiж байтами manifest-у залишить torn JSON, який
recovery sweep не зможе розпарсити і не визначить, у якій фазі ми
зупинились. Те ж саме застосовується до кожного оновлення фази інших необхідних конфігураційних файлів, наприклад в фазах:
prepare → commit, commit → done.

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

Семантика: **конфлікти — це анотації над path-ом, які логічно
прив'язані до конкретного path-у.
І хоча Користувач очікує, що переміщення файлу веде до переміщення усіх
пов'язаних з ним метаданих, для простоти це не робиться. 
І по моєму це - справедливо

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
Diff-Edit-у користувач розрізняє джерела (вище це вже відмічалось - це зроблено для того, щоб
показувати спочатку для швидкості тільки файли з `.trash/<id>/`, підвантажувати файли з GitHub history тільки за 
вимогою (якщо є локальні видалення), з кешу (якщо вже вантажились з GitHub history), чи автоматично (якщо локальних 
видалень нема взагалі)). Список будується так:
1. Усі поточні `.trash/<id>/` записи (свіжі, до sync).
2. Видалення з GitHub history (з локального кешу чи з GitHub history після кліку користувача по 
   `<get history from GitHub repo>`) (тільки якщо trash порожній по цьому path, щоб уникнути дублів) — 
   за останні N днів (default 30, налаштовується). Витягуються через `client.listCommitsForPath`
   + `compare()` для виявлення `status: "removed"`.

Кнопка `[Restore]` на елементі:
- Якщо trash entry → `adapter.rename` назад до `originalPath` +
  delete `.trash/<id>/`.
- Якщо GitHub-only → файл тут же намагається завантажитись з GitHub repo і відновитись.

### R4. Авто-resolve конфліктів

Вже розв'язані в PSEUDO-MERGE-MODE


### R5. Видалення артефактів каскадно

Вже реалізовано в PSEUDO-MERGE-MODE: при видеаленні чи перейменуванні siblings-файлів автоматично іде оновлення 
залишкового списку файлів (кількості конфліктів) в усіх UI вікнах, включаючи "conflict list" diff2 Widget. Пояснення:
тобто не має значення, через який механізм було завершено конфлікт - через diff2 UI, через Obsidian filesystem actions,
чи ззовні, через вилучення/перейменування файлів засобами самої операційної системи, як тільки ці зміни буде помічено,
вони оновлять стан усіх вікон та лічильників, які стосуються конфліктів.

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
    | <<<<< [↓apply][↓remove] (<local deviceName>)
 2 −| рядок з локального файлу
    | ===== [↓↑apply both][↓↑remove both]
 2 +| рядок з github repo
    | >>>>> [↑apply][↑remove] (<remote deviceName>) 
 3  | спільний рядок після зони конфлікту
```

Деталі:
- Зліва — **зона нумерації** (virtual line numbers). Спільні рядки
  нумеруються послідовно (1, 3, ...). Локальний та remote-рядки
  конфлікту мають **однаковий номер** (2 у прикладі) — це позиція,
  яку зайняв би переможець після resolve. Marker-рядки (`<<<<<`, `=====`,
  `>>>>>`) не нумеруються.
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
- Маркер-рядки (`<<<<`, `=====`, `>>>>>`) рендеряться як CodeMirror
  block-widget decorations (вбудовані DOM-елементи), не як справжні
  рядки в документі — щоб не плутати парсер markdown /
  md-frontmatter / тощо. При write-back у vault marker-рядки
  відсутні: документ містить тільки результат resolve.

**R7.3. Кольорове кодування** (через CodeMirror line decorations).
Логіка git-diff: local — те що "знімається/замінюється", remote —
"альтернатива, яка приходить":
- "ours"-рядки + `<<<<<` marker → **червоний фон**
  (`var(--background-modifier-error)` або подібний Obsidian-token).
  У gutter — `−`.
- `=====` middle marker → нейтральний фон
  (`var(--background-secondary-alt)`).
- "theirs"-рядки + `>>>>>` marker → **зелений фон**
  (`var(--background-modifier-success)` або подібний).
  У gutter — `+`.
- Темна тема: token-ова палітра автоматично адаптується.

> **Примітка про конвенцію**: свідомо обрано red(ours)/green(theirs)
> — це git-diff візуалізація (видалюване = червоне, додаване = зелене), а
> не "успіх vs помилка". Тобто ours тут не "погана сторона" — це просто
> візуальна звичка з git.

**R7.4. Word-level diff highlighting** всередині рядків ours/theirs.
Для кожної пари (ours-chunk, theirs-chunk) обчислюється character/word
diff (наприклад через `diff` або `diff-match-patch` npm-пакет —
вибір при імплементації) і змінені слова отримують додаткову мітку: накладену на колір секції жовтий колір фону, який 
на темно-червоному фоні стає оранжевим (червоний + жовтий), а на темно-зеленому фоні стає салатовим 
(темно-зелений + жовтий). На прикладі рядка
"`рядок з локального файлу`" vs "`рядок з github repo`" — слова
"`локального файлу`" будуть мати оранжевий фон і "`github repo`" маютимуть салалтовий фон, "`рядок з`"
лишається на основному фоні блоку.

**R7.5. Action-кнопки** (Widget decorations).

**Layout маркер-рядка**: device-name як **label-prefix**, далі дві
кнопки. Тобто верхній і нижній маркери виглядають як
`[apply] [remove] (<deviceName>)`, середній — `[apply both] [remove both]`.

Семантика (для кожної кнопки результат для цього chunk-у):
- `[apply]` на верхньому маркері (`<<<<<`) — "застосувати ours-сторону" → результат: ours-рядки (theirs відкидається).
- `[remove]` на верхньому маркері — "видалити ours-сторону" → результат: theirs-рядки (ours відкидається).
- `[apply]` на нижньому маркері (`>>>>>`) — "застосувати theirs-сторону" → результат: theirs-рядки.
- `[remove]` на нижньому маркері — "видалити theirs-сторону" → результат: ours-рядки.
- `[apply both]` на середньому маркері (`=====`) — конкатенація обох сторін (ours, потім theirs; порожня лінія між ними, 
  якщо обидва закінчуються на текст). Корисно для markdown-нотаток, де обидва варіанти інформативні.
- `[remove both]` на середньому маркері (`=====`) — chunk стає порожнім, навколишні спільні рядки злипаються.

Математичні відповідності: `[apply]` top ≡ `[remove]` bottom (обидва дають ours); `[apply]` bottom ≡ `[remove]` top 
(обидва дають theirs). Дублювання навмисне — одні користувачі думають "що залишити", інші — "що видалити".
Натиснути на одній стороні = автоматично визначити іншу. Це знижує когнітивне навантаження і кількість помилок.

**R7.6. Візуальні стрілки в кнопках.** Кожна кнопка містить unicode arrow або SVG, що позначає позицію блока:
- Верхній блок (`<<<<<` маркер): обидві кнопки мають **стрілку ↓** (вказують на нижній блок — те, з чим вони "взаємодіють").
- Нижній блок (`>>>>>` маркер): обидві кнопки мають **стрілку ↑**.
- Середній блок (`=====`): кнопки `[apply both]` і `[remove both]` мають парні стрілки `↓↑` поруч (бо діють на обидва блоки).

Точна семантика arrow напрямку (вказує на "що буде видалено" vs "позиція блока") уточниться на mock-up етапі. 
Принципово: стрілки — це візуальна підказка, яка зменшує плутанину які кнопки відносяться до якого блока.

**R7.7. Undo/commit model — Obsidian-style з persistent autosave.**

Поки користувач у DiffPane:
- **Усі дії — звичайні CM6-транзакції** у документному буфері:
  `[apply]`/`[remove]` per-chunk, групові `[Keep all local]` / `[Apply all remote]` / `[Join all]`, ручне редагування тексту.
- **`Ctrl+Z` / `Cmd+Z`** працює стандартно — відкочує одну дію за раз, можна йти назад до самого початку сесії. `Ctrl+Y` / `Cmd+Shift+Z` — redo.
- **Vault-файл `ours` НЕ переписується на кожну transaction** — це свідомий вибір на користь "експериментуй вільно, поки не вийдеш"
  моделі. Інакше кожен Ctrl+Z триггерив би `vault.on('modify')` → T2 check → потенційно resolve/un-resolve мерехтіння.

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
device через sync) модифікував файл між сесіями. В цьому випадку приймає "реалії на землі" - видаляємо наш Autosave і 
починаєм працювати з новим документом.

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
- "Хочу зберегти і продовжити пізніше" → `[←]` → tab можна закривати, на disk-у вже vault-state.
- "Все, я наплутав, скасуйте усе" → close tab `[x]` → autosave видалений → re-open → той самий конфлікт чекає з ours-on-disk.
- "Зробив пів-роботи, хочу відкласти, не закриваючи Obsidian" → `[←]` зараз (save partial → R4 T2 виявить, що file still divergent,
  конфлікт лишається з прогресом).
- "Робив 20 хв, Obsidian Mobile killed по low memory" → перезапуск → re-open → recovery dialog → `[Continue editing]` → курсор там же,
  Ctrl+Z працює.

**Crash resilience для autosave** (Принцип #9):
- `buffer.txt` пишеться через temp-file + atomic rename (`adapter.write(tmp); adapter.rename(tmp, buffer.txt)`) — щоб
  partial-write не пошкодив попередній валідний autosave.
- `history.json` пишеться так само атомарно. - `meta.json` (з `lastWriteAt`) пишеться **ОСТАННІМ** у кожному
  throttled-update — це pointer, який підтверджує, що `buffer.txt` + `history.json` уже на диску. На recovery-sweep, 
  якщо `meta.json` відсутній, але `buffer.txt` існує → autosave вважається пошкодженим, видаляється цілком 
  (наступний `[Continue]` неможливий, fall through до `[Start over]`-equivalent).

**Жодної окремої `[Discard changes]` кнопки** у toolbar немає. Користувач, який хоче відмінити багато дій під час сесії, 
тримає `Ctrl+Z`. Для "discard all and exit" — `[x]` tab-close. Для "save partial and keep working on it later" — `[←]`.

**R7.8. Free editing of everything.** Користувач має право **вільно редагувати усе** у файлі — будь-який рядок без обмежень:
- спільні (common) рядки — як у звичайному markdown-редакторі
- ours-рядки конфлікту (червоний фон) — можна правити typo, додавати слова, видаляти частини
- theirs-рядки конфлікту (зелений фон) — так само
- частково resolve-нуті результати — можна доповнити вручну те, що не вирішується самими select/remove кнопками

Marker-рядки (`<<<<<`, `=====`, `>>>>>`) — це візуальні decorations, не текст документа: вони не блокують курсор і не 
"редагуються" у звичайному сенсі, бо їх немає у документі взагалі. Натискання `Enter` на маркер-decoration переводить 
курсор у наступний справжній рядок без вставки нового рядка маркера.

Word-level highlight (R7.4) і кольорове підсвічення (R7.3) автоматично перераховуються при кожному edit. Якщо 
користувач довів ours і theirs до байт-рівності — auto-finalize спрацьовує (R7.7).

**R7.9. Detail view toolbar (top) + footer — per-mode.**

Toolbar над DiffPane відрізняється залежно від режиму (Conflicts / History / Compare / Deleted). Спільне: `[←]` back 
завжди перший елемент ліворуч; `[Open in external tool]` (desktop only) завжди останній правий, якщо R6 enabled.

**R7.9a. Conflicts mode (R2.2) detail toolbar:**
- `[←]` back to conflicts list.
- `[Keep all local (<localDeviceName>) changes]` — масовий take-ours.
- `[Apply all remote (<remoteDeviceName>) changes]` — масовий take-theirs.
- `[Join all changes]` *(markdown only)* — викликати `conflict-merge-all.ts::mergeIntoOne()`; theirs додається як
  `> blockquote` callout під ours з header-ом "`> changes from <remoteDeviceName> at <date> <time>`".
- Toggle `⏩` **Auto-advance** — коли увімкнено, після resolve будь-якого одного chunk-у (через `[apply]/[remove]` 
  per-chunk кнопки) автоматично переходимо до наступного нерозв'язаного chunk-у: курсор + scroll позиціонуються на ньому. 
  Default — **OFF**. Стан toggle-у зберігається у settings (`autoAdvanceConflicts: boolean`) і живе між сесіями. 
  Корисно для досвідчених користувачів з купою однотипних конфліктів; OFF за замовчуванням, бо стрибок viewport-у може 
  дезорієнтувати тих, хто переглядає результат resolve перед переходом.
- `[Open in external tool]` (desktop).
- **Без read-only toggle** — конфлікти існують щоб бути resolve-нутими, read-only тут не має сенсу.

**R7.9b. History mode (R2.3) detail toolbar:**
- `[←]` back to history list.
- Toggle `✏️` (Edit) / `🔒` (Reference) — перемикає DiffPane між редагованим та read-only станом (за замовчуванням 
  Reference). У Reference обидві сторони заблоковані від модифікації; навігація і копіювання тексту працюють.
- `[Restore this version]` — атомарно перезаписати поточний файл байтами обраної історичної версії. Confirm-модалка 
   перед write ("Перезаписати `<path>` версією з `<commit-or-ts>`?").
- `[Open in external tool]` (desktop).
- **Без `[Keep all local]` / `[Apply all remote]`** — у history-контексті ці назви не мають сенсу (немає
  "remote contributor", є тільки past version of same file). Селективне "повернення" частин старої версії
  робиться через per-chunk `[apply]/[remove]` всередині DiffPane (Edit mode), масове — через `[Restore this version]`.

**R7.9c. Compare any two (R2.1) detail toolbar:**
- `[←]` back to compare picker.
- Toggle `✏️` (Edit) / `🔒` (Reference) — default **Reference** (порівняння рідко передбачає правки; коли треба правити, 
  юзер явно перемикає).
- `[Swap]` — поміняти місцями який файл згори, який знизу.
- `[Open in external tool]` (desktop).
- **Без group resolve buttons** — це не конфлікт, нема концепту "ours" vs "theirs". Per-chunk `[apply]/[remove]` 
  доступні у Edit mode (для тих хто хоче синхронізувати один файл з іншим).

**R7.9d. Deleted mode (R2.4) detail toolbar:**
- `[←]` back to deleted list.
- `[Restore]` — повернути файл за оригінальним path-ом. Колізій немає за визначенням — список R2.4 фільтрує entries за 
  умовою "path зараз порожній" (path-only-when-empty filter, R2.4).
- `[Open in external tool]` (desktop).
- **Завжди read-only** — нема активної версії для edit-у.

**Md-only safety** (R7.9a): `[Join all]` рендериться **тільки** для файлів з markdown-розширенням
(`isMarkdown(path) === true`). Для JSON/YAML/CSS/CSV blockquote вставка корумпує синтаксис, тому операція там недоступна.

**Footer** (внизу DiffPane, у всіх режимах однаковий):
- Лічильник "`N` unresolved chunks" (live update при кліках/edit-ах). У History/Compare режимах "unresolved" просто
  означає "diverging" (відмінні), без resolve-семантики.
- **Навігаційні кнопки** `[↑ prev chunk]` / `[↓ next chunk]` — клік переходить курсор до попереднього/наступного 
  diverging-блоку у документі. Працюють у всіх режимах, включно з Reference (бо це навігація, не редагування).

**Жодних дефолтних hotkey-ів** плагін не задає. Причини:
- `Alt`-based комбінації (як `Alt-N`) на macOS зайняті системою для спецсимволів (`Alt-N` → `ñ`), користувач не може ними скористатись.
- Mobile (iOS/Android) hotkeys взагалі не релевантні — Obsidian mobile не має зовнішньої клавіатури типово.

Замість дефолтних hotkey-ів усі операції (next chunk / prev chunk / take ours / take theirs / take both / resolve all / open external)
експортуються як **Obsidian commands** у command palette. Користувач, який хоче hotkey-и, прив'язує їх через стандартну Obsidian
"Hotkeys" сторінку — там він сам обере зручну комбінацію, що не конфліктує з його ОС.

**Назви кнопок — RESOLVED 2026-05-18**. Узгоджені на трьох рівнях UI:

1. **Conflicts list (R2.2) — над усіма конфліктами**:
   `[Keep all local]` `[Apply all remote]` `[Join all]` *(md only)*.
2. **Detail view (R7.9a) — над одним файлом**:
   `[Keep all local (<localDeviceName>)]` `[Apply all remote (<remoteDeviceName>)]`
   `[Join all]` *(md only)*. Те саме що список, плюс імена девайсів.
3. **Per-chunk (R7.5) — над одним chunk-ом**:
   `<localDeviceName>: [apply] [remove]` / `[apply both] [remove both]` / `<remoteDeviceName>: [apply] [remove]`.

Принцип: на **list/file-level** залишається довша, явна форма ("Keep all local", "Apply all remote") — бо це масові, 
потенційно руйнівні дії, де користувач має чітко зчитати, що саме станеться.
На **per-chunk level** — коротка форма (`apply`/`remove`), бо контекст chunk-у і device-label поряд вже усе пояснюють, 
а економія місця важлива (chunk може бути в один рядок).

**R7.10. Compare & history mode** використовує ту ж форму, але без `<<<<</=====/>>>>>` маркерів і без action-кнопок:
- chunks теж кольорові (зелений = тільки у першому файлі, червоний = тільки у другому/старій версії, жовтий = змінено) + word-level
  diff.
- Документ read-only (для history) або editable (для compare two — але без auto-finalize, бо це не конфлікт).
- Для history mode footer містить `[Restore this version]`.

### R8. Crash resilience — наскрізний контракт

**Принцип**: для кожної багатокрокової disk-операції у diff2 повинно бути визначено:
1. **Точки можливого crash-у** — між якими двома кроками stale state може потрапити на диск.
2. **Інваріант стану на диску** — що "консистентний" означає для цього store-у.
3. **Recovery sweep** — функція, яка запускається при `onload` плагіна і відновлює half-applied state у консистентний (або повністю
   відкочений, або повністю завершений — never half-applied).
4. **Kill-mid-op тест** — окремий integration-тест (з fault-injection), який підтверджує recovery.

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
- Concurrent crashes (kill під час recovery sweep). Прийнятна модель — recovery sweep сам ідемпотентний; повторний crash під час нього просто
  залишає state, який повторний onload зачистить.
- Disk-corruption (зіпсовані байти у середині файлу). Об'єкти типу `meta.json` парсяться через `JSON.parse` з try/catch; invalid JSON →
  трактується як відсутній і wipe-ається.
