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

6. **Phase-by-phase, не "великий вибух".** Реалізація йде фазами; канонічна
   енумерація — у §R9 (Implementation roadmap). Кожна фаза — окремий PR, що сам по собі
   не ламає main. Розгортання інкрементально, з можливістю зупинитись на будь-якій
   фазі, починаючи з Phase 3 (перший shippable user-feature; Phases 0–2 — infrastructure,
   див. R9 MVP-cliff пояснення).

7. **../CLAUDE.md, PSEUDO-MERGE-MODE.md, і цей документ - як джерело істини про поточну поведінку.**
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
    - історія змін (diff-порівняння попередніх версій будь-якого текстового файлу з Vault з його версіями з .push-queue
      (в режимі offline) і GitHub repo),
    - відновлення видалених файлів (за рахунок збережених копій в GitHub repo і, у режимі offline, тимчасово, –
      з .trash/.
    - порівняння довільних (текстових) файлів.

Форма UI та UX взаємодія обговорюються далі.

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

Задача diff-editor — допомагати користувачу вирішувати блоки конфліктів один за одним, і поступово розв'язувати
конфлікти,
залишаючи те рішення, яке потрібне (або комібінувати рішення, або через редагування додавати зовсім інше).
На рівні вхідних в diff-editor файлів відбувається поступове злагодження цих двох файлів між собою, аж поки вони не
стануть повністю тотожніми один одному, що і буде вважатись розв'язанням конфлікту. Бо саме умова:
SHA(base-file) == SHA(conflict-sibling) сприймається підсистемою PSEUDO-MERGE-MODE як розв'язок конфлікту
(PSEUDO-MERGE-MODE.md, §8). При цьому, conflict-sibling-file буде видалено при наступному sync, так, як він повністю
тотожній базовому, а вже базовий файл буде використаний як остаточний результат вирішення цього конфлікту.

Далі буде вказано, що необхідно при цьому тримати undo/redo-історію, щоб можна було відміняти зміни, якщо виникне
бажання змінити своє рішення.

### R2. Diff-Edit widget — функціональні режими і навігація

**Дві основні мети використання widget-у** (mental model для користувача):

1. **Conflicts mode** — список pending конфліктів (береться з ConflictStore minus вже вирішені конфлікти на файловій
   системі (тобто береться список конфліктів з ConflictStore і з них віднімаються всі конфлікти, для яких на файловій
   системі на момент "тут-і-зараз" відсутні `*.conflict-from*` sibling-файли (так звані, "Synthetic conflicts"))).

   Клік по вибраному конфлікту → відкриває diff-editor на весь tab з параметрами: локальним базовим файлом (ours) і
   його conflict-sibling-версією (theirs). Користувач resolve-ить через кнопки `[apply]/[remove]` per chunk або
   групові `[Keep all local]` / `[Apply all remote]` тощо.

2. **File history mode** — список попередніх версій конкретного файлу (з GitHub або push-queue). Клік по версії →
   відкриває diff-edit на весь tab між поточним файлом (ours) і обраною історичною версією (theirs).

   Цей режим має **дві суб-поведінки** з перемиканням через **toggle-іконку у top toolbar** (напр., `🔒` коли read-only,
   `✏️` коли editable; точна іконка обирається при імплементації):

    - **Edit mode** (default, іконка `✏️`): працює як conflict resolution — chunk-action кнопки `[apply]/[remove]`
      доступні,
      edits у поточному файлі зберігаються. Користувач може вибірково "повернути" частину старого тексту (наприклад,
      відновити
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
колонкою списку + правою з DiffPane), новий widget — це **один tab, без побічних колонок**. У будь-який
момент tab показує або:

- **list view** (список конфліктів / список історії / список видалених), на ширину всього tab-у, або
- **detail view** (один обраний файл — DiffPane з top-toolbar-ом для повернення назад до list view)

Перехід між list і detail — стрілкою `[←]` у toolbar детального viewer-а (повернення в list); кліком по елементу списку
(відкриття detail для нього).

Причини відмови від двопанельного layout-у:

1. На мобільному екрані ліва панель забирає 30–50% ширини, що робить detail view нечитабельним.
2. Якщо користувач працює через зовнішній diff (R6), detail-частина взагалі не потрібна — він хоче бачити повноширокий
   список.
3. Узгоджена single-pane модель спрощує state-машину і відповідає Obsidian mobile-native поведінці (back-stack
   навігація).

**R2.1. Compare any two files.**

*Що порівнюємо*:

- два звичайні файли з vault (`a.md` vs `b.md`)
- файл vs sibling (`note.md` vs `note.conflict-from-...md`) - ЗАУВАЖЕННЯ! sibling може бути "справжнім", зареєстрованим
  в ConflictStore і orphaned ("Synthetic conflicts") — просто файл зі схожою назвою. Перший sibling використовується
  для вирішення конфліктів і остаточного вирішення (merge), другий — файктично сприймається як звичайний інший файл з
  vault - може допомогти модифікувати base-file або ж ні.
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
    - **Спочатку дослідити сучасні API**: чи Obsidian експортує `app.fileManager`-API для filesystem picker; чи
      доступний
      `electron.ipcRenderer` + main-process bridge; чи Capacitor-API (`@capacitor/filesystem`) працює на Obsidian
      Desktop
      під капотом.
    - **Якщо знайшли сучасний шлях** — реалізуємо filesystem picker за ним; gated на `Platform.isDesktopApp`; обраний
      файл
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
файл з іншим). Marker block-widgets (`<<<<</=====/>>>>>`) тут **не рендеряться** — нема "conflict context", просто
кольорове
підсвічення diff-chunks + word-level highlight.

**R2.2. Conflicts list (повноширокий, list view).** Список `*.conflict-from-*` siblings, **наявних у vault**, і містить
**дві категорії**:

- **Tracked conflicts** — siblings із відповідним записом у `ConflictStore` (пара `(record + sibling)` створена
  через `applyRemoteAddOrModify` / `applyRemoteDeletion` / reconcile під час drain). Закриваються через
  Phase A/B (див. canonical PSEUDO-MERGE-MODE §5 drain-pseudocode та §10 Scenario E).

- **Synthetic conflicts** — siblings у vault, для яких **немає запису в `ConflictStore`**. Показуються з
  візуальним badge-em `synthetic` (інший колір), щоб користувач бачив відмінність від tracked-конфлікту.

Цей список згрупований за оригінальним path, а конфлікти розташовані за зростанням timestamp.
Список займає **усю ширину tab-у** і, так, як кожному base-file в конфлікті може відповідати більше одного
conflict-sibling (tracked чи synthetic) файлів, то кожний конфлікт виглядає як група (base-file) конфліктів:
1. folder1/folder2/base-file1.md
- timestamp1 (<conflict-file Device1Label>)
- timestamp2 (<conflict-file Device2Label>)
...
2. folder3/folder4/folder5/base-file2.md
- timestamp3 (<conflict-file Device1Label>)
...

Synthetic-конфлікти найчастіше виникають як побічний ефект ручного перенесення `(base, sibling)`-пари в інший
каталог. Сценарій (детально див. R3.3 правило 3):

1. У `Folder1/` є base + sibling, обидва — частина зареєстрованого конфлікту.
2. Користувач переносить `Folder1/note.md` → `Folder2/note.md`. ConflictStore запис лишається прив'язаним
   до `Folder1/note.md`, sibling — теж у `Folder1/`.
3. Користувач переносить sibling: `Folder1/note.conflict-from-*.md` → `Folder2/note.conflict-from-*.md`.
4. На наступному drain Phase A дропає запис (його sibling зник зі старого path), Phase B синтезує
   side-batch і пушить delete `Folder1/note.md` на main (PSEUDO-MERGE-MODE §5 + §10 Scenario A pattern).
5. У `Folder2/` пара тепер живе без жодного запису в Store — це synthetic-конфлікт.

Detection (vault-scan, виконується при відкритті diff2 view і при кожному vault-event):

```
для кожного <siblingPath> = *.conflict-from-<device>-<ts>.<ext> у vault:
  <basePath> = strip-conflict-from-suffix(<siblingPath>)
  if exists(<basePath>) and conflictStore.getBySibling(<siblingPath>) === null:
    → synthetic conflict (показати у list view зміненим кольором, що означає `synthetic conflict`)
```

Resolve synthetic-конфлікту — **чисто vault-операція**, без ConflictStore- і branch-механіки:

- DiffPane рендериться для пари `(base, sibling)` так само, як для tracked-конфлікту.
- Resolve-операції (per-chunk `[apply]/[remove]`, group buttons, manual edits) працюють однаково.
- При `[←]` (R7.11): якщо `SHA(base) == SHA(sibling)` — diff2 **проактивно видаляє sibling** з vault.
- `ConflictStore` НЕ зачіпається (нема запису, нема чого мутувати).
- Conflict-branch НЕ задіюється — це не справжній конфлікт у sense PSEUDO-MERGE-MODE; на наступному drain
  Phase A нічого не побачить (запису нема, sibling вже видалено).

Семантично це той же rule, що Phase A застосовує до tracked-конфліктів — `siblingSha == baseSha → remove
sibling` (PSEUDO-MERGE-MODE §5) — лиш виконаний у момент editor-exit замість на наступному drain. Це
експліцитно дозволено архітектурою PSEUDO-MERGE-MODE §9.7 ("filesystem state authoritative"): vault — джерело
істини, видалення sibling-у з vault — легальна користувацька операція незалежно від запису у Store.

Зверху над списком — **toolbar з груповими операціями над усіма конфліктами**:

- `[Keep all local changes]` — для всіх записів зберегти ours, видалити всі sibling-и (масовий take-ours).
- `[Apply all remote changes]` — для всіх записів перезаписати ours = theirs, видалити всі sibling-и (масовий
  take-theirs).
- `[Join all changes]` *(markdown only)* — для всіх md-записів викликати
  `conflict-merge-all.ts::mergeIntoOne()` каскадом (theirs додається як `> blockquote` callout
  під ours) у вигляді:
  > Changes from `<remote deviceLabel>` at `<timestamp>`:
  >
  > theirs text...

- Кнопка прихована або disabled, якщо у списку немає markdown-конфліктів, щоб не
  наводити користувача на помилку. Після кліку по кнопці [Join all changes] всі markdown-файли будуть вилучені зі списка
  конфліктів, залишаться тільки (якщо є) файли інших типів і кнопка [Join all changes] стане disabled, aбо буде
  прихована.
  *(`conflict-merge-all.ts` — новий модуль, додається у `src/diff2/` як частина цього плану; не існує у 2.0.1-beta.)*

Кожен елемент списку клікабельний → перехід у **detail view** з DiffPane (R7), де є додатковий top-toolbar з тими ж
операціями, але для одного файлу (R7.9-onepan).

**R2.3. File history** — для довільного файлу з vault показати історію його змін. Джерела:

1. **Push queue fallback** — якщо немає мережі або клієнт у `bare` стані, показати локальні pending-батчі (читання
   `.push-queue/<id>/vault/<path>` + meta).
   ОСОБЛИВІСТЬ ЦЬОГО РЕЖИМУ: якщо в `.push-queue/` є ХОЧА Б ОДИН(!) COMMIT-BRANCH (не merge!) і в кеші немає
   попередньо-завантажених записів з GitHub, показуємо в File history ТІЛЬКИ вміст .push-queue, і внизу кнопку
   `<Show GitHub history...>`. Objection: якщо в `.push-queue/` є записи, то (з великою ймовірністю) 90% у користувача
   буде виникати потреба глянути попередню версію файла, ніж переглядати далекі історії, тому завантажувати автоматично
   дані з GitHub repo НЕ ПОТРІБНО! A от якщо вже користувач сам натиснув `<Show GitHub history...>`... тоді, звертаємось
   до GitHub repo, завантажуємо зміни в cache і показуємо користувачу.
2. ОДНАК, якщо в .push-queue 0 записів, і cache записів з GitHub ще не завантажено, тоді (щоб не залишати цей список
   взагалі порожнім), варто автоматично розпочати завантаження (ніби користувач сам на порожньому списку натиснув
   `<Show GitHub history>`.

Потребує нової обгортки `GithubClient.listCommitsForPath(path, branch, {since?, perPage?, page?})` навколо
`GET /repos/{owner}/{repo}/commits?path={path}&sha={branch}`.

Кожен елемент історії клікабельний → відкриває DiffPane (current vs selected-version). У DiffPane при перегляді
історії `theirsReadOnly: true` (вже передбачено у DiffPane API). Кнопка "Restore this version" у footer DiffPane —
перезаписує current vault file байтами обраної версії.

**R2.4. Deleted files (Recently deleted)** — той самий single-pane shell (R2.0), що й Conflicts mode, але **спрощений
detail view**.

Для реалізації цього режиму необхідно додати до `plugins/github-easy-sync/.trash/` директорію (ВЖЕ ДОДАНО!!!), де будуть
зберігатись видаліні (В ЦІЙ SYNC-СЕСІЇ ТІЛЬКИ!!!) файли. Що це означає? Це означає, що в
`plugins/github-easy-sync/.trash/<id>` будуть зберігатись видалені файли тільки до наступного Sync, після чого ми
вважаємо, що цей файл більше користувачу не потрібний, і відновити цей файл можна буде тільки з GitHub repo.
Якщо ж файл було створено і видалено в одному циклі Sync (між двома sync) - файл втрачається незворотньо.

*List view*: повноширокий список trash-entries + GitHub-recent-deletions (уніфіковано, як описано в R3.6). Кожен
елемент показує: vault path, коли видалено, джерело (`local trash` / `GitHub history`), розмір.
Top toolbar:

- `[Refresh from GitHub]` — примусово витягнути свіжий `listCommitsForPath` для оновлення віддалених видалень.

Жодної кнопки масової очистки trash немає — local-trash записи й так очищуються автоматично після того, як sync
підтвердив відповідне видалення на GitHub (TTL=0, R3.5). Залишати "Empty trash" кнопку означало б давати ризиковану дію,
яка нічого корисного не покриває.

*Detail view* (кліком по елементу): **дві варіації** залежно від live-стану path-у у vault:

- **Variant A — path FREE у vault** (немає live-файлу за `originalPath`):
  read-only single-side прев'ю, що використовує ту саму CM6-інфраструктуру,
  що й Diff-Edit (R7), але у спрощеному режимі:
    * **Без `<<</===/>>>` marker block-widgets** (нема двох сторін — файл
      просто видалений, є тільки одна версія: deleted content).
    * **Без per-chunk action кнопок** (нема конфлікту).
    * **Без word-level diff** (нема пари для порівняння).
    * Документ показується як **plain markdown / text** з line numbers у
      gutter — як одностороння версія DiffPane.
    * Заголовок: `<vaultPath> · deleted <ts> from <local trash> | <GitHub history>`.

- **Variant B — path OCCUPIED у vault** (live-файл існує за тим самим
  path-ом, нова інстанція після delete → recreate): natural follow-on з
  R2.4 multi-entry-per-path semantics. Detail view відкривається у
  **Compare mode** (R2.1 / R7.10), де:
    * **Ours** = live vault file за `meta.originalPath`.
    * **Theirs** = bytes з `.trash/<id>/vault/<originalPath>`.
    * **Read-only за замовчуванням** (Reference toggle ✏️/🔒 default `🔒`)
      — user-flow тут "що було тоді vs що є зараз", не "merge into current".
      Edit mode опційно перемикається toggle-ом якщо користувач хоче
      selectively pull lines з deleted-версії у поточну (resurrection-flow).
    * Заголовок: `<vaultPath> (current) ↔ deleted <ts> (from trash)`.
    * `[Restore]` усе одно доступний — спрацьовує collision-rename
      (current залишається, trash-bytes landed-уються як
      `<stem>.restored-<iso-ts><ext>`).
    * `[Swap]` доступний (R7.9c) якщо користувач хоче переглянути зворотним
      boku.

UI implementation note: вибір варіанту робиться у момент відкриття detail
view через `app.vault.getAbstractFileByPath(meta.originalPath)`. Жодного
state-у не треба зберігати; rendering вирішується щоразу.

Top toolbar (detail):

- `[←]` — back to list view.
- `[Restore]` — повернути файл за оригінальним path-ом. Якщо path зараз
  зайнятий у vault (користувач створив новий файл, або вже відновив іншу
  версію цього path-у з trash) — автоматично rename до
  `<stem>.restored-<iso-ts><ext>`, mirror trash-recovery `.recovered-<ts>`
  з R8.1 collision-handling. Без user input — кнопка завжди безпечна, але
  результат може landed-итися під derived name. Показати у Notice
  "restored as <new path>" якщо rename застосовано.

**Multi-entry-per-path semantics.** Recently deleted list (як local-trash,
так і GitHub-history entries) **не фільтрує** записи за path-occupancy у
vault. Усі trash entries — видимі завжди. Causal motivation: кожен запис у
`.trash/<id>/` ключується унікальним 17-цифровим timestamp-ом, тому у
списку легко можуть жити кілька записів з одним `originalPath` але різними
датами видалення (delete → recreate → delete з тим самим іменем — два
окремих entries у trash). Користувач бачить повну історію delete-actions.

UI implication: відсутній vault-presence pre-render filter; UI лише
запитує `trashStore.list()` (відсортований newest-first) і рендерить
кожний запис з його `originalDeletedAt` poznachen-ням. Багатоверсійність
самого path-у наочна через timestamp у subtitle кожного row-у.

Кнопка `[Restore as…]` (manual rename з user-typed name) — **не
потрібна у v1**. Автоматичний `.restored-<ts>` rename покриває collision
без user input. Якщо колись з'явиться запит на manual name (rare), вона
повертається як окрема UI-feature.

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
    | <<<<< [apply ↓][remove ↓] (<local deviceLabel>)
    | ===== [apply both ↓↑][remove both ↓↑][join <remote deviceLabel>]
 1 +| <theirs line 1>
 2 +| <theirs line 2>
 3 +| <theirs line 3>
    | >>>>> [apply ↑][remove ↑] (<remote deviceLabel>) 
```

Тобто верхній (red/ours) блок порожній — між `<<<<<` маркером і `=====` маркером немає жодного рядка. Це **природна**
ситуація для нашої розмітки і не потребує спеціальних винятків у CM6 коді.

*Семантика top-toolbar кнопок для delete-vs-modify*:

- `[Keep all local changes]` = "залишити видалення" → final = empty → vault file НЕ створюється; sibling + ConflictStore
  запис
  видаляються; намір користувача видалити файл - підтверджується і при наступному [sync] конфлікт розв'язується в
  сторону [delete]
- `[Apply all remote changes]` = "відновити з GitHub" → final = theirs → vault file створюється з theirs контентом;
  після цього з'являється base-file з вмістом віддаленного (sibling) і при наступному [sync] конфлікт розв'язується в
  сторону [remote modified] (який вже зкопійовано в base-file, sibling-файл буде вилучено).
- `[Join all]` *(md only)* — **сховано** для delete-vs-modify (нема ours щоб об'єднувати з; результат був би просто
  theirs).

*Auto-resolve T2 (R4)*: якщо користувач створює файл `note.md` у vault вручну і він стає байт-рівним sibling-у —
конфлікт
resolve-иться "resurrection"-шляхом (файл створено, видалення забрано з queue). Edge case, але узгоджено з R4.

*sync2-manager уже підтримує* цей сценарій (CLAUDE.md: "Local-deleted vs remote-modified"). Все що нам треба — коректно
відрендерити у DiffPane коли `ours === ""` і додати `[deleted locally]` badge у list view.

**R2.6. Sync файлів з pending конфліктами — поведінка зафіксована у pseudo-merge mode, нічого додаткового не вводимо.**

У 2.0.1-beta (canonical: [`PSEUDO-MERGE-MODE.md`](./PSEUDO-MERGE-MODE.md) §8 "Editing While in Conflict")
користувач **може вільно редагувати** файл, який знаходиться у конфлікті, і всі такі редагування **накопичуються як
комміти на per-device conflict branch** — не йдуть на `main`, але і не відкидаються. Це load-bearing feature, а не
недолік: §4.4 preserve-all-commits гарантує, що кожна ітерація буде доступна назавжди через GitHub history після
фінального merge-commit-а.

Diff2 widget **повторює** цю поведінку:

- `Sync all` / `Sync this file` на файлі з pending конфліктами **проходять нормально**. Поточні
  `Sync2Manager.registerConflictAndDropPath`
    + `processBatch` partitioning розв'язують це так: path-and з pending конфліктом ідуть на conflict branch, інші — на
      `main`.
- Перед `[Sync]` спрацьовує **уже існуюча** `PreSyncConflictModal` (`src/sync2/views/pre-sync-conflict-modal.ts`):
  показує список
  pending конфліктів, дозволяє `[Resolve]` (відкриває перший sibling в editor-і) / `[Sync anyway]` (продовжити,
  edit-while-in-conflict
  path) / `[Cancel]`. Diff2 не дублює цю модалку; кнопка `[Resolve]` у v2 може бути перерофумована на "Open in
  Diff-Edit"
  (опційно, дрібний поліш).
- Жодного "refuse-to-sync" guard-у не додаємо. Це б суперечило §8 і ламало Scenario B (six branch commits during long
  resolution session — кожен з них окремий [Sync] click).
- Sibling-файли вже у `.gitignore` через `gitignore-invariants.ts`, отже на GitHub вони ніколи не потрапляють незалежно
  від
  sync-commands.

**N siblings per path (множинні remote версії)** — нормальна і свідома ситуація, зафіксована як §10 Scenario C ("
Multi-Sibling
From Multiple Devices"). Diff2 list view (R2.2) **групує** записи за `vaultPath` як expandable rows (
`note.md (3 versions)`), щоб
не виглядало хаотично. Решта механіки (`ConflictStore` dedup за `(vaultPath, theirsBlobSha)`, file-level `[Apply all remote
changes]` як швидке масове закриття) залишаються без змін.

### R2.7. Перемикання між 4 режимами (entry-points)

Resolved 2026-05-17 (раніше TBD). Принцип — **асиметричні entry-points за природою режимів**:

- **Conflicts і Deleted — глобальні списки** (не прив'язані до конкретного файлу). Усередині diff2 view вони живуть як
  дві
  **sub-tabs у header-і view-tab-а**: `[Conflicts (N)] [Deleted (M)]`, з лічильниками. Кожна sub-tab має власний
  single-pane shell
  (list ↔ detail, R2.0).

- **Compare і History — file-bound** (прив'язані до конкретного path). У глобальному shell-і їм нема де "жити" без
  вибраного файлу (empty state "виберіть файл" — поганий UX). Тому вони **відкриваються у тому ж diff2 view як
  одноразові
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
- **File-menu "Resolve conflict"** — context menu item, що додається динамічно
  тільки на `*.conflict-from-*` sibling-файлах у file-explorer-і Obsidian (через
  `app.workspace.on('file-menu', cb)`). Клік відкриває diff2 detail view одразу
  для пари `(basePath, siblingPath)`. Особливості:
    * Парсинг `basePath` робиться через `stripConflictSuffix(file.path)` (R3.10) —
      та сама функція, що використовується у layer 1b cleanup. Жодного
      `ConflictStore.getBySibling` lookup не треба → entry-point працює однаково
      для **tracked-конфліктів** (з record у store) і для **synthetic-конфліктів**
      (R3.3 правило 3 — без record).
    * Якщо `basePath` не існує у vault (delete-vs-modify, R2.5) — DiffPane
      рендериться з ours-стороною empty за існуючими правилами R2.5; жодного
      спецкоду в entry-point не потрібно.
    * Найприродніший discoverability шлях: користувач **бачить** sibling-файл у
      file-explorer-і → right-click → resolve. Не вимагає знання про
      badge/ribbon/sub-tab. Особливо цінно на mobile, де доступ до status-bar
      badge-у дещо неочевидний.
    * Не показується для non-sibling файлів — `stripConflictSuffix` повертає
      null → handler ранній return-ить, menu item не додається.

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

Якщо `N === 0` — іконка прихована.

*Це один з двох (необов'язково обидва увімкнено одночасно)
surfaces, що показують лічильник конфліктів. Другий — ribbon
іконка `diff` (R2.7.4). Кожен з них незалежно opt-in через
settings. Sync-ribbon-іконка `[Sync with GitHub]` лічильник
конфліктів **НЕ показує** — там тепер push-queue depth, див.
`PUSH-REORGANIZATION.md` §3.6.*

#### R2.7.4. Ribbon button — окрема іконка для diff2 (не плутати з sync-icon!)

**Окрема ribbon-іконка, не та сама, що `[Sync with GitHub]`.** Це
вирішує дві проблеми за раз:

1. **Доступ до diff2 без конфліктів.** Зараз єдиний "природний"
   спосіб потрапити в diff2 — це коли є хоч один pending конфлікт
   (через status-bar 🔀-індикатор). Але список **видалених файлів
   (Deleted mode, R2.4)** і **компаре двох файлів (Compare mode,
   R2.1)** ортогональні до наявності конфліктів — користувач має
   мати швидкий вхід туди завжди.
2. **Розвантаження sync-іконки.** Sync-ribbon-іконка
   `[Sync with GitHub]` тепер показує **кількість push-batches у
   черзі** (push-queue depth), а не лічильник unresolved-конфліктів
   — див. `PUSH-REORGANIZATION.md` §3.6. Лічильник конфліктів
   переноситься на цю окрему diff2-іконку.

**Конкретика:**

- Іконка: `diff` (чи `git-merge`, чи інший Obsidian-built-in;
  вибір при імплементації — головне щоб візуально відрізнялась від
  sync-іконки `refresh-cw`).
- Badge на іконці: **кількість unresolved конфліктів** (та сама
  величина, що `🔀 N` у status-bar — два надлишкові surfaces для
  одного сигналу, обидва opt-in через settings; redundancy
  навмисна, бо різні користувачі віддають перевагу різним
  surfaces).
- Клік: відкриває diff2 view за default-sub-tab-правилом (R2.7.5).
- Чи показується bage коли N=0: badge зникає, **сама іконка
  лишається видимою** (бо її цінність — швидкий доступ до Deleted /
  Compare, не лише до conflicts).

**Settings toggle (Interface section):**

- Перейменувати поточний (чи додати поряд) toggle `Show sync ribbon
  button` (для іконки sync) → залишається як є.
- **Додати** новий toggle `Show diff ribbon button` поряд (default
  ON для нових інсталяцій; existing-installs мігруються через
  `loadSettings` зі значенням, що відповідає попередній semantics
  — якщо у попередній версії conflict-counter показувався на
  sync-іконці, то новий toggle ON, тобто переносимо UX поведінку
  на нову іконку).
- Pattern імен toggle-ів навмисно матчить original
  `github-gitless-sync` plugin (який мав `Show sync ribbon
  button`), щоб міграція з того плагіну читалась природньо.

**Code-level implementation** (для подальшої R9-фази Implementation roadmap):

- `src/main.ts` — `addRibbonIcon("diff", "Open diff editor",
  callback)` поруч з існуючим sync-ribbon виклику; gated на
  `settings.showDiffRibbonButton ?? true`.
- `src/settings/settings.ts` — нове поле
  `showDiffRibbonButton: boolean` у `GitHubSyncSettings` +
  default `true` у `DEFAULT_SETTINGS`.
- `src/settings/tab.ts` — новий toggle UI, поруч з існуючим
  `Show sync ribbon button`. Identical pattern.
- Subscribe на `ConflictCounter` для оновлення badge — той самий
  hook, який зараз живить status-bar.

#### R2.7.5. Default sub-tab при відкритті diff2 view

Якщо diff2 view відкривається без явного режиму (ribbon, status bar,
summary modal) — завжди відкривається режим Conflicts (навіть якщо зараз 0 конфліктів), щов перейти на `Deleted`
потрібно явно вибрати відповідний sub-tab в diff2-tab. Objection: уніфікованість - користувач повинен завжди отримувати
той самий результат кожний раз як виконує певну дію. Тому перемикання табів Conflicts/Deleted за умовою не вітається.

Якщо diff2 view відкривається з явним контекстом (Compare picker, History command, "Show history" з контекстного меню) —
sub-tabs header **приховується** для цієї сесії, видно тільки `[←]` назад і заголовок поточного режиму. Це уникає
змішування "глобальних боргів" з "одноразовою detail-сесією".

### R3. Recently deleted / Local trash

> **Implementation status.** ✅ Data layer + sync2 wire-up complete on
> `diff2` branch, commits `28fd725` … `4941592` (8 PRs). Restore + Deleted
> UI = Phase 9b (R3.13 below). Test coverage: 746 unit + 6 integration
> (~66s against real GitHub). Implementation reference is consolidated in
> R3.8–R3.13.

**R3.1.** Створити локальний "smart-trash":
`<configDir>/plugins/github-easy-sync/.trash/<id>/`
де `<id>` — 17-цифровий timestamp (та сама схема, що у `.conflicts/` та `.push-queue/`).

Кожен запис trash містить:

```
.trash/<id>/
  meta.json              ← TrashRecord {id, originalPath, originalDeletedAt, sha, size, mtime, liftedAsSessionId?}
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
заборона потрапляти в `.trash` стосується тільки самих `.trash/<id>/` директорій — вони видаляються atomic-cleanup-ом
TTL=0 (R3.5) без рекурсивного загортання у новий trash-bundle.

**R3.3. Rename/delete base-file: три канонічні правила.**

Конфлікти прив'язані до **path-а**, а не до файлу. Це дає три прості передбачувані правила,
що працюють однаково для всіх vault-операцій (drag-drop, context-menu rename, зовнішній `mv`):

**Правило 1 — Move/delete base-file НЕ ЗАЧІПАЄ siblings.** Якщо `Folder1/note.md` має N pending
конфліктів і користувач переміщує або видаляє цей base-file, всі N sibling-файлів
(`Folder1/note.conflict-from-*.md`) **залишаються в старому каталозі**, ConflictStore-записи
лишаються прив'язаними до `Folder1/note.md`. Конфлікт за старим path-ом вважається
**НЕ розв'язаним**, поки siblings там лежать.

**Правило 2 — Конфлікт АВТО-РОЗВ'ЯЗУЄТЬСЯ, коли ВСІ siblings зникають зі старого path-а.**
Не важливо, як саме siblings зникли — користувач видалив усі, або переніс усі в інший
каталог. Один раз як `Folder1/note.conflict-from-*.md` у `Folder1/` не стало:

- Phase A на наступному drain дропає всі записи (їх siblings зникли — PSEUDO-MERGE-MODE §5
  drain-pseudocode: `or drop record if sibling was deleted by user`).
- Phase B "propagate live vault state to main" (§5):
    - якщо `Folder1/note.md` теж зник з vault (наприклад, перенесено разом із siblings) —
      side-batch містить `delete Folder1/note.md` (§10 Scenario A pattern);
    - якщо `Folder1/note.md` лишився у vault (siblings перенесли окремо, base — на місці) —
      side-batch пушить *поточний вміст* `Folder1/note.md` на main як resolve-commit
      (§10 Scenario E pattern). Та сама механіка, інший payload — за рахунок того, що
      Phase B не "видаляє" і не "пише" хардкодом, а транслює живий стан vault-а.

**Правило 3 — Синтетичні конфлікти у новому каталозі.** Якщо siblings перенесено в новий
каталог разом з base-file (або поряд з'явився інший base), пара `(base, sibling)` у новому
каталозі живе **без запису в `ConflictStore`** (старий запис був прив'язаний до старого
path-а і дропнувся Phase A — Правило 2). Diff2 розпізнає таку пару vault-сканом і показує її
у list view як **synthetic conflict** (R2.2). Resolve — чисто vault-операція через DiffPane;
при `[←]` якщо `SHA(base) == SHA(sibling)`, diff2 проактивно видаляє sibling (R7.11).
`ConflictStore` та conflict-branch не задіюються — це не tracked-конфлікт.

**Семантика — чому path, а не файл.** Користувач інтуїтивно очікує, що переміщення base-file
"переносить за собою всі його метадані". Diff2 свідомо цього **не** робить, тому що:

1. *Простіше і безпечніше.* Нема transactional rename з prepare/commit/done фазами, нема
   ризику kill mid-rename з half-applied state, нема recovery sweep для часткових rename-ів.
2. *Прозоро для PSEUDO-MERGE-MODE.* Phase A's правило "drop record if sibling was deleted"
   працює без модифікації — для нього "sibling moved away" і "sibling deleted" семантично
   ідентичні, обидва означають "sibling зник з registered path".
3. *Гнучкіше.* Через synthetic conflicts (Правило 3) користувач може зробити будь-яку
   reshuffle-операцію (move base + siblings разом, копія в інше місце для backup-у,
   etc.) і завжди матиме UI для resolve.

**Rename-event detection.** Obsidian зазвичай емітить один `rename` event, але для деяких
drag-drop сценаріїв видає `delete` + `create`. Diff2 інтерпретує кожен `delete` буквально:
файл йде в TrashStore (R3.2) безвідносно того, чи прийде слідом `create` з тим самим SHA.
Це безпечно — TrashStore не блокує vault, а на наступному `[Sync]` TTL=0 cleanup (R3.5)
прибере trash entry, як тільки delete потрапить на main. Спекулятивна логіка
"це могло бути rename, не delete" не вводиться — додасть складність без вигоди.

**Edge cases.**

- *Move цілої папки.* Obsidian fire-ить rename для кожного файлу всередині. Кожен base-file
  з конфліктами обробляється індивідуально за Правилами 1–3.
- *Колізія імен sibling-у на новому path-і.* Малоймовірно: ім'я sibling-у містить
  timestamp (`-<YYYY-MM-DDTHH-MM-SS>Z`), що робить collision практично неможливим.
- *Orphan sibling без base.* Якщо у vault є `*.conflict-from-*` файл без відповідного
  base-file у тому ж каталозі — це не synthetic conflict (нема з чим diff-ити). Diff2 не
  показує його в list view, але ConflictStore існуючий orphan-cleanup на `load()` (для
  записів `.conflicts/<id>/` без sibling) — це інший випадок, тут diff2 нічого не робить.

**R3.4. Pull-deletes ТАКОЖ ідуть у trash — short recovery window.** Коли видалення
приходить з GitHub через `applyRemoteDeletion`, sync2-manager викликає
`trashHooks.captureForDelete(path)` ПЕРЕД `adapter.remove(path)`. TrashStore читає
байти і створює `.trash/<id>/` запис так само, як і для user-driven delete-у.

Логіка: користувач, який після `[Sync]` бачить, що файл зник, має короткий природний
window щоб сказати "Куда! Поверни назад!" і відновити файл з local trash — без потреби
лізти у GitHub history mode. Recovery window — точно один drain-цикл:

- pull-delete entry створюється з `id ≈ T_pull > drain.startedAt` → layer 2 поточного
  drain-у НЕ свайпне (`id > threshold`).
- Наступний `[Sync]` стартує з `drain_2.startedAt > T_pull` → layer 2 drain_2 свайпає
  entry → файл остаточно зникає.

**Recovery flow:** користувач [Restore]-ить → файл назад у vault, snapshot все ще каже
"removed" (з попереднього pull). Наступний drain findChanges: vault has + snapshot no
→ emit ADD → push на GitHub як новий файл. Інший пристрій pull-ить — отримує його
назад. Це нормальна семантика "останнє осмислене user-action перемагає", не
rollback war.

**Explicit-контракт > implicit-bypass.** Sync2 explicit-кличе `captureForDelete`, замість
покладатися на crystal "`adapter.remove` не fire-ить vault events". Майбутні sync2-зміни
не зможуть випадково обійти trash без compile-error на missing-call.

**Cleanup-семантика інших шарів.** Pull-delete entries:

- Layer 1a не triggered: pull-delete path не потрапляє у `deleted-paths.txt` поточного
  чи майбутнього batch-у (snapshot уже відображає видалення).
- Layer 1b не triggered: не conflict resolution.
- Layer 2 triggered на наступному успішному drain — backstop.

Якщо drain між тим abort-ається (network failure mid-push), entries виживають
до наступного успішного drain — TTL у днях максимум для realistic usage.

**Design boundary (свідомий контракт, не v1-gap).** TrashStore реагує **тільки** на
видалення, ініційовані безпосередньо користувачем — два expected-канали:

- (a) user-driven через `vault.delete` / `vault.trash` (monkey-patch перехоплює UI flow);
- (b) sync-driven через `sync2.applyRemoteDeletion` (explicit hook).

Видалення через `vault.adapter.remove(path)`, ініційовані **сторонніми плагінами** чи
скриптами, **не потрапляють у trash** — і це коректно за визначенням, а не gap для
закриття. Аргументація:

1. *Не наша sphere of responsibility.* Користувач не клікав "Delete" у нашому UI flow.
   "Рятувати" будь-яке зникнення файлу з vault — гіперактивна поведінка, що засмічує
   trash чужих-плагінів temp-файлами, cache-evict-ами, lock-файлами.
2. *Адаптерний рівень — не event surface.* Patch-ити `adapter.remove` ламає
   архітектуру: адаптер shared між vault, settings, всіма плагінами; blast radius
   кратно більший за `vault.delete`.
3. *Сторонні плагіни мають свої механізми undo.* Якщо інший плагін видаляє через
   адаптер, він бере відповідальність за свою рестов-механіку.

Документується у README user-facing розділі для прозорості.

**R3.5. Three-layer TTL.** Очищення `.trash/` відбувається у трьох прошарках, кожен зі своїм
тригером. Прошарки незалежні і ідемпотентні; будь-який з них може спрацювати раніше за інший
без ризику конфлікту.

| #      | Тригер                                                                                                                   | Що чистить                                                                                                                                                                                                        |
|--------|--------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **1a** | `processBatch(B)` success → `push-queue.delete(B.id)`. Для кожного path `P ∈ B.deleted-paths.txt`.                       | `.trash/<id>/` де `meta.originalPath == P`. Це базові видалення (`note.md` → push delete → cleanup).                                                                                                              |
| **1b** | Той самий `processBatch(B)` success, але **тільки якщо** `B.meta.resolvesConflictForBasePath == X` (Phase B side-batch). | Усі `.trash/<id>/` де `stripConflictSuffix(meta.originalPath) == X`. Чистить ВСІ siblings базового path-у `X`, які користувач кинув у trash у процесі resolve.                                                    |
| **2**  | Drain **повністю** успішний (queue порожня, не abort через помилку). Один раз у кінці.                                   | Усі `.trash/<id>/` де `<id> < drain.startedAt` (string compare 17-цифрових timestamps). Backstop для orphan siblings, gitignored файлів (`*.log`), synthetic siblings — усього, що не покрилося прошарками 1a/1b. |

Розкладка по типах файлів — куди кожен потрапляє:

| Що видалено у trash                                                           | Покрито | Чому                                                                                                                                                |
|-------------------------------------------------------------------------------|---------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| base-file (`Folder/note.md`)                                                  | 1a      | Delete потрапляє у `deleted-paths.txt` через звичайний findChanges.                                                                                 |
| tracked sibling (`Folder/note.conflict-from-…md`, є record у `ConflictStore`) | 1b      | Phase A дропає record → Phase B side-batch з `resolvesConflictForBasePath=Folder/note.md` → 1b чистить sibling-trash коли side-batch підтверджений. |
| synthetic sibling (та сама форма імені, але **немає** record у Store)         | 2       | Нема Phase A → нема Phase B → нема side-batch → 1b не має на що чіплятися. Той самий клас, що й `.log`.                                             |
| gitignored файл (`*.log`, `*.bak` користувача)                                | 2       | changeDetector ігнорує → не потрапляє у `deleted-paths.txt` → 1a/1b пасують.                                                                        |
| orphan sibling (sibling без base-file у vault)                                | 2       | Те саме, що synthetic — нема record → нема side-batch.                                                                                              |

**Реалізаційні точки:**

1. `EnqueueMeta` (`src/sync2/push-queue.ts`) розширюється опційним полем
   `resolvesConflictForBasePath?: string`. Phase B (`synthesizeResolutionSideBatches` у
   `sync2-manager.ts`) встановлює його при синтезі side-batch-у.
2. `Sync2Manager` фіксує `drain.startedAt` всередині re-entrant guard, після
   `running=true` (один 17-цифровий timestamp на drain). Передає його у TrashStore
   при final sweep.
3. `applyRemoteDeletion` (R3.4) викликає `trashHooks.captureForDelete(path)` ПЕРЕД
   `adapter.remove(path)`. Pull-deletes потрапляють у `.trash/` для one-drain-cycle
   recovery window.
4. `processBatch` після успішного `push-queue.delete(B.id)` повідомляє:
    - `TrashStore.confirmDeleted(B.deletedPaths)` (прошарок 1a)
    - якщо `B.meta.resolvesConflictForBasePath` set — `TrashStore.confirmResolved(X)` (прошарок 1b)
5. Sync2Manager наприкінці drain-у (**тільки якщо** queue порожня + не було abort)
   викликає `TrashStore.sweepOlderThan(drain.startedAt)` (прошарок 2).

Усі чотири callback-и — однонапрямлені (sync2 → diff2 через constructor-injected
callbacks); `sync2` ніколи не імпортує з `diff2`. Це продовження карв-аута R9 Phase 9a.

**Race із concurrent compare** — див. R3.7 (lift-and-return mechanism).

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

**R3.7. Compare-lift mechanism — metadata-only marker.** Коли користувач відкриває compare
для trashed-файлу (Deleted detail view R2.4 чи Compare-with-trashed варіант R2.1), файл
**фізично не переміщується**. Захист від concurrent drain забезпечує виключно поле
`liftedAsSessionId` у `.trash/<id>/meta.json`. UI читає байти напряму з
`.trash/<id>/vault/<originalPath>` під час compare.

*Marker як shield.* Усі три cleanup-прошарки R3.5 пропускають records з виставленим полем:

```
if (record.liftedAsSessionId) continue;   // у §6.2 (1a), §6.3 (1b), §6.4 (2)
```

Це **load-bearing** guard, не косметичне поле для UI. Доки marker set, ніхто не
видалить `.trash/<id>/` ні зsередини drain-у, ні зовні.

*Lift операція*:

1. `record = await readMetaJson(.trash/<id>/meta.json)`. Якщо
   `record.liftedAsSessionId` set → fail "already lifted".
2. `sessionId = generateTimestampId()`
3. Mutate `record.liftedAsSessionId = sessionId`.
4. `await atomicWriteJson(.trash/<id>/meta.json, record)` через temp + safeRename.

*Return операція*:

1. Scan `.trash/*/meta.json`, find record where `liftedAsSessionId === sessionId`.
2. Mutate `record.liftedAsSessionId = undefined`.
3. `await atomicWriteJson(.trash/<record.id>/meta.json, record)`.

Жодних `safeRename` файлу. Жодного staging-каталога. Жодного in-memory index —
диск (`.trash/<id>/meta.json`) є authoritative; query-операції просто scan-ять
`.trash/` на льоту (realistic N ≈ 3–5 entries, scan <5 ms). Тільки rewrite
meta.json — одна атомарна disk-операція на step 4 lift-у (і step 3 return-у).

*Чому id зберігається — і чому це дає природний flow.* Lift/return — це **виключно
метадані**: snapshot, ConflictStore, push-queue, push-queue.meta, вміст
`.trash/<id>/vault/<originalPath>` — все залишається у тому стані, у якому було до lift-у.

Це дає сильну природну властивість: **якщо користувач закриває compare (return) ДО старту
наступного drain-у — файл утилізується нормальним flow, ніби ніколи не lift-вився.** Усі
три прошарки R3.5 спрацьовують для нього як зазвичай:

- Базовий файл (`Folder/note.md`): `findChanges` наступного drain-у бачить ту саму
  snapshot↔vault diff → emit-ить delete → той самий batch → **прошарок 1a**
  (`confirmDeleted(['Folder/note.md'])`) чистить `.trash/<id>/`.
- Tracked sibling: Phase A drop record → Phase B side-batch з
  `resolvesConflictForBasePath` → **прошарок 1b** (`confirmResolved(basePath)`) чистить.
- Orphan / synthetic / gitignored: **прошарок 2** (`sweepOlderThan(drain.startedAt)`) —
  `id < drain.startedAt` за визначенням, бо `id` — це момент delete-у, який передував
  будь-якому майбутньому drain-у.

Якщо compare охоплює межу drain-у (lift під час drain-N, return під час drain-N+1):
прошарки 1a/1b/2 drain-N **пропускають** lifted-record. Після return-у файл стає eligible
на drain-N+1 за тими самими правилами.

*Race-аналіз із concurrent drain.* Завдяки `serialize()` (§6.8 task-spec), lift і
cleanup-прошарки ніколи не interleave у межах процесу. Усе, що cleanup бачить — це поточний
disk-стан `.trash/<id>/meta.json` (re-read на старті кожної операції). Гілки:

- Cleanup читає meta.json ДО lift-у: marker undefined → cleanup проводить deletion. Lift
  пізніше fail-ить через `readMetaJson` повертає null (record уже видалений).
  Compare UI показує Notice "Trash entry was reclaimed by sync — try again with another
  entry". ✓ Acceptable — це rare edge case, файл і так був eligible до видалення.
- Cleanup читає meta.json ПІСЛЯ lift-у: marker set → cleanup пропускає. Файл залишається у
  `.trash/<id>/` до return-у.

Жодних file-level race-ів типу "ENOENT при rename" не існує, бо ніяких rename взагалі.

*Crash mid-lift або під час compare-сесії.* Marker залишається на диску у
`.trash/<id>/meta.json` (atomic-write або був завершений до краху і marker set, або не
почався — інтермедіатно поле "лежить наполовину" неможливо при temp+rename pattern). На
наступному `main.ts::onload`, recovery sweep робить **один-єдиний крок** для всіх
lifted-records:

```
for record in scan(.trash/*/meta.json) where record.liftedAsSessionId is set:
  record.liftedAsSessionId = undefined
  atomicWriteJson(.trash/<id>/meta.json, record)
```

Логіка: при крашу всі активні compare-сесії втрачені (UI state у пам'яті зник). Marker
без живої сесії — це stale state. Файл уже у `.trash/<id>/vault/<originalPath>`, ніяких
rename не потрібно. Після clear-у файл повертається у нормальний three-layer flow і буде
утилізований на найближчому drain-і.

Чисте Obsidian shutdown (Cmd+Q, OS restart) — той самий код-шлях: marker on disk, recovery
clear на наступному onload.

*Store state-shape — disk-authoritative.* TrashStore **не тримає in-memory index** —
realistic N ≈ 3–5 записів між sync-кліками (rare 10–20) при vault-і ~300 файлів, отож
disk-scan (`readdir(.trash/)` + N×meta.json read) виконується <5 ms навіть на mobile.
Query-методи (`list`, `get`, cleanup-hooks iteration) скан-ять диск on the fly; mutating-
методи (intercept, lift, return) пишуть meta.json і викликають bare-signal `subscribe`
listeners. UI робить власний `await list()` у відповідь на signal і рендерить, включно з
"currently being compared" індикатором для records з `liftedAsSessionId` set.

*Чому не окремий marker-файл (`.lock`).* `meta.json` уже пишеться через temp+safeRename
(PSEUDO-MERGE-MODE §9.4 Path B pattern). Окремий marker-файл вимагав би другої атомарної
операції з новим класом partial-states ("marker is, поле в meta нема", чи навпаки). Marker
all-in-meta.json — це **єдина** atomic write per state-transition, **єдина** durable
артефактна форма marker-у, **єдиний** recovery scan на onload. SOLID.

**R3.8. Implementation status + module layout.**

**Статус:** ✅ Реалізовано на гілці `diff2`, коміти `28fd725` … `4941592`
(8 PR-ів). Тестове покриття: 746 unit + 6 integration (~66s проти real
GitHub). Restore (R3.6) + Deleted UI (R2.4) — Phase 9b, ще не landed.

**Module layout** (нові файли у `src/diff2/`):

```
src/diff2/
├── types.ts                  ← TrashRecord re-export of TrashHooks
├── trash-store.ts            ← public API + serialize promise-chain + listeners
├── trash-watcher.ts          ← monkey-patch app.vault.delete/trash
├── trash-recovery.ts         ← onload recovery sweep
├── strip-conflict-suffix.ts  ← pure regex helper, reverse of conflict-from-*
└── trash-disk-helpers.ts     ← tryReadMetaJson, atomicWriteJson, rmrf, ensureParentDirs
```

`TrashHooks` живе у `src/sync2/trash-hooks.ts` (sync2-owned), щоб sync2
будувався standalone без `src/diff2/`. `src/diff2/types.ts` re-експортує
для diff2-consumers.

**Reused helpers (вже існували, refactor-ed для shared use):**

- `safeRename` — `src/sync2/cross-platform.ts`
- `computeBlobSha` — `src/utils.ts`
- `newBatchId` / `parseTimestampId` — `src/sync2/timestamp-id.ts` (винесено з
  module-private push-queue.ts у shared util; pure refactor)

**Sync2 carve-out edits:**

- `EnqueueMeta.resolvesConflictForBasePath?: string` (`push-queue.ts`) +
  persist у meta.json (back-compat: undefined у legacy batches).
- `Sync2ManagerDeps.trashHooks?: TrashHooks` — last optional param.
- Hook call sites: `applyRemoteDeletion` (capture перед adapter.remove),
  `processBatch` success (confirmDeleted/confirmResolved), `drain()` end
  (sweepOlderThan if drainSucceeded). Phase B
  `synthesizeResolutionSideBatches` set `resolvesConflictForBasePath`.

**R3.9. Data layer API surface.**

```ts
// src/diff2/types.ts
export interface TrashRecord {
    id: string;                    // 17-digit timestamp; directory name; immutable
    originalPath: string;          // vault-relative path before delete
    originalDeletedAt: string;     // ISO; preserved across lift→return
    sha: string;
    size: number;
    mtime: number;
    liftedAsSessionId?: string;    // R3.7 shield — set during compare-lift
}

// src/sync2/trash-hooks.ts (sync2-owned to preserve dep direction)
export interface TrashHooks {
    captureForDelete(path: string): Promise<void>;     // R3.4 pull-delete capture
    confirmDeleted(paths: string[]): Promise<void>;    // R3.5 layer 1a
    confirmResolved(basePath: string): Promise<void>;  // R3.5 layer 1b
    sweepOlderThan(threshold: string): Promise<void>;  // R3.5 layer 2
}

// src/diff2/trash-store.ts
export class TrashStore {
    constructor(deps: { vault: Vault; configDir: string; selfPluginId: string; now?: () => Date });

    // Lifecycle
    async init(): Promise<void>;                                  // mkdir .trash/
    async clearAll(): Promise<void>;                              // Reset panic button

    // Intercept (called by trash-watcher + asHooks().captureForDelete)
    async intercept(path: string): Promise<TrashRecord>;

    // Queries — async, disk-authoritative, no in-memory cache
    async list(): Promise<TrashRecord[]>;                         // sorted desc by originalDeletedAt
    async get(id: string): Promise<TrashRecord | undefined>;

    // Subscribe — bare signal, UI re-fetches via list()
    subscribe(listener: () => void): () => void;

    notify(): void;                                               // public for trash-recovery

    // R3.7 compare-lift
    async liftForCompare(id: string): Promise<{ trashPath: string; sessionId: string; record: TrashRecord }>;

    async returnFromCompare(sessionId: string): Promise<void>;

    async resetLifts(): Promise<void>;                            // Phase 9b "last detail-tab close"

    // R3.5 cleanup hooks (also exposed via asHooks() for sync2 wire-up)
    async confirmDeleted(paths: string[]): Promise<void>;

    async confirmResolved(basePath: string): Promise<void>;

    async sweepOlderThan(threshold: string): Promise<void>;

    // Sync2 cross-edge — returns the bag wired into Sync2ManagerDeps.trashHooks
    asHooks(): TrashHooks;
}
```

**State, який TrashStore тримає у пам'яті** — мінімум: `Set<() => void>`
listeners + `Promise<unknown> currentOp` для serialize. **Жодного in-memory
record cache.** Диск (`.trash/<id>/meta.json`) — single source of truth для
records; кожен query — readdir + N×readMetaJson, де N ≈ 3–20.

**R3.10. Algorithm summaries.** Канонічні алгоритми (high-level):

*intercept(path)* — bytes copy into trash:

```
id = await allocateUniqueId()
fileContent = await adapter.readBinary(path)
sha = computeBlobSha(fileContent)
stat = await adapter.stat(path)
dstFile = .trash/<id>/vault/<path>
await ensureParentDirs(adapter, dstFile)
await adapter.writeBinary(dstFile, fileContent)
meta = { id, originalPath: path, originalDeletedAt: nowIso(), sha, size, mtime }
await atomicWriteJson(adapter, .trash/<id>/meta.json, meta)
notify(); return meta
```

*Cleanup hook pattern* — three layers share `sweepBy(predicate)`:

```
sweepBy(predicate):
  records = await readAllRecords()        // disk-scan, no cache
  changed = false
  for rec in records:
    if rec.liftedAsSessionId: continue    // R3.7 shield — load-bearing
    if !predicate(rec): continue
    try: await rmrf(.trash/<rec.id>/); changed = true
    catch: // best-effort, next sweep retries
  if changed: notify()

confirmDeleted(paths)    → predicate: rec.originalPath in paths
confirmResolved(basePath) → predicate: stripConflictSuffix(rec.originalPath) === basePath
sweepOlderThan(threshold) → predicate: rec.id < threshold  // string compare on 17-digit ts
```

*Compare-lift pair* — metadata-only marker:

```
liftForCompare(id):
  meta = await tryReadMetaJson(.trash/<id>/meta.json)
  if !meta || meta.id !== id: throw "not found"
  if meta.liftedAsSessionId: throw "already lifted as <sessionId>"
  sessionId = newBatchId(now())
  meta.liftedAsSessionId = sessionId
  await atomicWriteJson(.trash/<id>/meta.json, meta)
  return { trashPath: .trash/<id>/vault/<meta.originalPath>, sessionId, record: meta }

returnFromCompare(sessionId):
  records = await readAllRecords()
  meta = records.find(r => r.liftedAsSessionId === sessionId)
  if !meta: throw "session not found"
  meta.liftedAsSessionId = undefined
  await atomicWriteJson(.trash/<meta.id>/meta.json, meta)
```

*resetLifts* — defensive Phase 9b normalizer:

```
resetLifts():
  for rec in await readAllRecords():
    if !rec.liftedAsSessionId: continue
    rec.liftedAsSessionId = undefined
    await atomicWriteJson(.trash/<rec.id>/meta.json, rec)
```

*serialize* — promise-chain pattern; all mutating methods (`intercept`,
`confirmDeleted/Resolved`, `sweepOlderThan`, `liftForCompare`,
`returnFromCompare`, `resetLifts`, `clearAll`) await the previous op's
promise. Single-process serialization without external mutex.

**R3.11. Recovery sweep (onload).** Single-pass over `.trash/<id>/` dirs.
Called from `main.ts::onload` BEFORE Sync2Manager instantiation.

```
sweepOnload(deps):
  await trashStore.init()                  // ensure .trash/ exists
  for dirName in await adapter.list(.trash/) where /^\d{17}$/.test(dirName):
    metaPath = .trash/<dirName>/meta.json
    meta = await tryReadMetaJson(metaPath)

    if !meta || meta.id !== dirName:
      // Case A — orphan dir (intercept kill before atomicWriteJson)
      vaultDir = .trash/<dirName>/vault/
      if exists(vaultDir):
        for rel in walkFiles(vaultDir):
          dst = rel; if exists(dst): dst = <stem>.recovered-<iso>.<ext>
          safeRename(vaultDir/<rel>, dst)
      rmrf(.trash/<dirName>/)
      continue

    if meta.liftedAsSessionId:
      // Case B — stale lift marker (UI vanished with Obsidian)
      meta.liftedAsSessionId = undefined
      atomicWriteJson(metaPath, meta)
      continue

    if !exists(.trash/<dirName>/vault/<meta.originalPath>):
      // Case C — meta valid but vault file gone (rare write failure)
      rmrf(.trash/<dirName>/)
      continue

    // else: record valid, leave alone

  // Cleanup orphan .tmp leftovers from interrupted atomicWriteJson
  for dir in .trash/*: if exists(<dir>/meta.json.tmp): remove

  if anyChange: trashStore.notify()
```

Idempotent on repeat invocation; best-effort per-rmrf failure handling.
Non-id directories (regex `\d{17}` mismatch) are skipped — recovery is
none of their business.

**R3.12. Resolved design decisions.**

1. **`vault.delete` interception → monkey-patch.** На `plugin.onload`
   patch-уються `app.vault.delete` і `app.vault.trash`; кожен patched-
   метод читає байти, write-ить у `.trash/<id>/`, потім викликає
   оригінал. На `plugin.unload` патчі відновлюються (зберігаємо
   оригінали у closure). LIFO order поведінка коректна якщо інші
   плагіни теж patch-ять (кожен plugin unwrap-ить рівно свій layer).
2. **`deviceLabel` у TrashRecord → НЕ зберігаємо.** Прибрано — додасть
   value тільки якщо deleted-mode UI стане cross-device aware; форвард-
   сумісне розширення.
3. **`subscribe` granularity → bare signal + disk-authoritative store.**
   API: `subscribe(listener: () => void)`. UI робить власний
   `await trashStore.list()` на notify. `TrashStore` **взагалі не тримає
   in-memory index** trash-records: диск — single source of truth.
   Обґрунтування: realistic N ≈ 3–5 entries між sync-кліками (rare 10–20)
   при vault-і ~300 файлів → readdir + parse 5×meta.json < 5 ms навіть
   на mobile.
4. **Design boundary (R3.4 wider).** TrashStore реагує **тільки** на
   два канали: (a) monkey-patched `vault.delete/trash`, (b) sync2's
   explicit `captureForDelete` hook. Прямі `adapter.remove(path)` від
   сторонніх плагінів — не protected, це permanent contract (не v1
   обмеження). Аргументація — R3.4 "Design boundary".
5. **Lift never throws on the marker race** (R3.7-аналіз). throw на
   already-lifted є strict failure detection на fault site; defensive
   `resetLifts()` від Phase 9b UI catches escapees на known-safe-point
   (last detail-view tab close). Together: self-healing system.

**R3.13. Out-of-scope for Phase 9a — consumer-side work у пізніших фазах.**

Phase 9a (R3.1–R3.12) ship-ить тільки data layer + cleanup hooks +
recovery sweep + sync2 wire-up. Consumer-side (UI + restore) — у пізніших
phases. Розділяємо по тому, у якій phase кожен item landed-иться.

**Phase 8 consumer use** (Compare any two — R2.1):

0. **Compare-with-trashed flow.** Picker (R2.1) дозволяє обрати trash
   entry як одну зі сторін Compare. UI викликає `liftForCompare(id)`
   перед відкриттям DiffPane, `returnFromCompare(sessionId)` при close.
   API вже є з Phase 9a (PR-6). Phase 8 додає лише UI hook.

**Phase 9b items** (Deleted-mode UI + restore — R2.4, R3.6, R7.9d):

1. **`TrashStore.restore(id)` operation.** Move file back from
   `.trash/<id>/vault/<originalPath>` to vault root. **Collision-rename
   when path is occupied** (per R8.1 collision-handling pattern): target
   becomes `<stem>.restored-<iso-ts><ext>`, mirror of
   `.recovered-<ts>` used by trash-recovery on intercept-kill orphans.
   No user input required — always safe to invoke. Show Notice
   "restored as <derived path>" when rename was applied.
   Drops the trash entry; fires notify(). Серіалізується через ту ж
   `serialize()` chain. Recovery sweep acquires a new row у R8.1
   (TrashStore.restore — partial state =
   "file moved back, trash dir not yet wiped"; recovery completes the
   rmrf).

2. **Deleted-mode UI** (R2.4 single-pane shell).
    * `src/diff2/deleted-list.ts` — list view рендериться через
      path-only-when-empty filter (запис показується якщо
      `app.vault.getAbstractFileByPath(path) === null`). UI subscribe-иться
      до `trashStore.subscribe(() => void)` + `vault.on('create')` для
      live-reactive filter.
    * Detail view (single-side preview) — reuse CM6 infrastructure of
      DiffPane у `mode: "preview"` (no `<<</===/>>>` markers; no
      per-chunk actions; just read-only render of deleted bytes).
    * `src/diff2/toolbar-deleted.ts` — R7.9d toolbar з кнопками
      `[←] back`, `[Restore]`, `[Open in external tool]` (desktop).

3. **`[Restore from GitHub]` (R3.6 GitHub-history side).** Залежить від
   **Phase 7** (`listCommitsForPath` API wrapper у `src/github/client.ts`).
   Recently-deleted список зливає `.trash/` entries + GitHub-history
   removals у єдиний UX. Якщо 9b треба ship-нути до 7 — scope-cut на
   local-trash-only; restore з GitHub додається у post-7 patch.

4. **`[Restore as…]` colision-rename.** Вже **не потрібно** як окрема
   кнопка через path-only-when-empty filter (R2.4) — у списку немає
   колізій за визначенням. Якщо filter колись зніметься (R2.4 design
   review), `[Restore as…]` повертається.

5. **Last-detail-tab-close hook** (R3.7 invariant enforcement). Phase
   9b UI підраховує active detail-view tabs у пам'яті; на close
   останнього викликає `trashStore.resetLifts()` (метод вже є з PR-6).

**Phase 9b залежить від Phase 7** (History mode) для GitHub-history
restore. Без 7 — scope-cut на local-trash-only варіант (deferred-GitHub
patch).

### R4. Авто-resolve конфліктів

**Уже повністю розв'язані в PSEUDO-MERGE-MODE — diff2 нічого нового не вводить.** Канонічні
тригери авто-резолву:

- **`siblingSha == baseSha`** (engine-deletable) — Phase A знаходить байт-рівність і видаляє
  sibling, дропає record (PSEUDO-MERGE-MODE §5 drain-pseudocode `remove sibling if
  siblingSha == baseSha`). Diff2 експлуатує це правило **проактивно** через R7.11 при
  editor-exit — резерв через Phase A на наступному drain.
- **`!siblingExists`** (user-deleted) — Phase A дропає record, бо користувач прибрав sibling
  у file explorer (§5: `or drop record if sibling was deleted by user`). Diff2 R7.11
  proactive cleanup йде саме цим шляхом.
- **Modify-vs-delete (asymmetric)** — auto-merge gate повертає `modify-wins` ще до реєстрації
  будь-якого record-а (PSEUDO-MERGE-MODE §6.3, §7 dispatch table). Diff2 ніколи не бачить таких
  "конфліктів" — вони не існують з точки зору ConflictStore.
- **Plugin bundle semver pick** — auto-merge для `<configDir>/plugins/<id>/main.js`+`manifest.json`
  вирішує через semver-comparison (§7 dispatch table, `isAtomicPluginFile`). Знову — record не
  створюється, у diff2 list не з'являється.

### R5. Видалення артефактів каскадно

**Уже реалізовано в PSEUDO-MERGE-MODE.** При видаленні чи перейменуванні sibling-файлів —
будь-яким механізмом (через diff2 UI, через Obsidian filesystem actions, через зовнішній
файловий менеджер ОС) — оновлення лічильника конфліктів у status bar / ribbon відбувається
автоматично через event-driven `ConflictWatcher` + `ConflictCounter` (PSEUDO-MERGE-MODE §5:
listener-and-counter split, **read-only** — listener тільки `markDirty()`, реальна мутація
ConflictStore відбувається на drain-start через `evaluateConflictState`). Diff2 list view (R2.2)
підписується на той самий `ConflictCounter.subscribe()`, тож реагує на зовнішні vault-зміни
без власної event-логіки.

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
4. Очікувати на `exit`. Якщо `Read result back === true` — перечитати tmp `ours`, обчислити
   SHA, якщо змінився — записати назад у vault через `writeResolved` (Path A
   `atomicWriteFile`, PSEUDO-MERGE-MODE §9.3). Потім — **той самий exit-protocol з proactive
   sibling cleanup, що й для internal editor `[←]`** (R7.11): якщо
   `SHA(base) == SHA(siblingN)`, diff2 видаляє siblingN одразу. Phase A на наступному drain
   спрацює резервно через "sibling was deleted by user" гілку.
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
    | <<<<< [apply ↓][remove ↓] (<local deviceLabel>)
 2 −| рядок з локального файлу
    | ===== [apply both ↓↑][remove both ↓↑][join <remote deviceLabel>]
 2 +| рядок з github repo
    | >>>>> [apply ↑][remove ↑] (<remote deviceLabel>) 
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
`[apply] [remove] (<deviceLabel>)`, середній — `[apply both] [remove both] [join <deviceLabel>]`.

Семантика (для кожної кнопки результат для цього chunk-у):

- `[apply]` на верхньому маркері (`<<<<<`) — "застосувати ours-сторону" → результат: ours-рядки (theirs відкидається).
- `[remove]` на верхньому маркері — "видалити ours-сторону" → результат: theirs-рядки (ours відкидається).
- `[apply]` на нижньому маркері (`>>>>>`) — "застосувати theirs-сторону" → результат: theirs-рядки.
- `[remove]` на нижньому маркері — "видалити theirs-сторону" → результат: ours-рядки.
- `[apply both]` на середньому маркері (`=====`) — конкатенація обох сторін (ours, потім theirs; порожня лінія між ними,
  якщо обидва закінчуються на текст). Корисно для markdown-нотаток, де обидва варіанти інформативні.
- `[remove both]` на середньому маркері (`=====`) — chunk стає порожнім, навколишні спільні рядки злипаються.
- `[join (<remote deviceLabel>)]` - (ТІЛЬКИ ДЛЯ MARKDOWN ФАЙЛІВ!!! Для інших типів файлів цієї кнопки не видно!) -
  розв'язати конфлікт через додавання remote (theirs)-рядки в `> blockquote` як:
  > Changes from `<remote deviceLabel>` at `<timestamp>`:
  >
  > theirs text...

Математичні відповідності: `[apply]` top ≡ `[remove]` bottom (обидва дають ours); `[apply]` bottom ≡ `[remove]` top
(обидва дають theirs). Дублювання навмисне — одні користувачі думають "що залишити", інші — "що видалити".
Натиснути на одній стороні = автоматично визначити іншу. Це знижує когнітивне навантаження і кількість помилок.

**R7.6. Візуальні стрілки в кнопках.** Кожна кнопка містить unicode arrow або SVG, що позначає позицію блока:

- Верхній блок (`<<<<<` маркер): обидві кнопки мають **стрілку ↓** (вказують на нижній блок — те, з чим вони
  "взаємодіють").
- Нижній блок (`>>>>>` маркер): обидві кнопки мають **стрілку ↑**.
- Середній блок (`=====`): кнопки `[apply both]` і `[remove both]` мають парні стрілки `↓↑` поруч (бо діють на обидва
  блоки).

Точна семантика arrow напрямку (вказує на "що буде видалено" vs "позиція блока") уточниться на mock-up етапі.
Принципово: стрілки — це візуальна підказка, яка зменшує плутанину які кнопки відносяться до якого блока.

**R7.7. Resolve-step undo для пари `(base, sibling)` з crash-survival.**

**Що це і чому це можна зробити просто**. DiffPane оперує одним файлом, який, фактично складається з 
об'єднаних по рядкам (full join) двох файлів:

**file 1:**

| ## | row      |
|----|----------|
| 1  | line 0\n |
| 2  | line 1\n |
| 3  | line 2\n |
| 4  | line 3\n |
| 5  | line 4\n |
| 6  | \n\n     |
| 7  | line 5\n |

**file 2:**

| # | row               |
|---|-------------------|
| 1 | line 0\n          |
| 2 | \n\n              |
| 3 | line 1\n          |
| 4 | other line\n      |
| 5 | yet anoher line\n |
| 6 | line 3\n          |
| 7 | line 5\n          |
| 8 | line 6\n          |
| 9 | \n                |

| # | diff-lines                                 |
|---|--------------------------------------------|
| 1 | line 0\n\0                                 |
| 2 | \1\n\n\0                                   |
| 3 | line 1\n\0                                 |
| 4 | line 2\n\1other line\nyet another line\n\0 |
| 5 | line 3\n\0                                 |
| 6 | line 4\n\n\1\0                             |
| 7 | line 5\n\0                                 |
| 8 | \1line 6\n\n\0                             |

`\1` - роздільник між версіями. Це може бути символ 0x01 (чи може краще 0xff - заборонений код для utf8)?
`\0` - кінець рядка

Причому diff-файл вміщує в собі два типуи рядків: "звичайний" і "diff-рядок".

Кожний рядок закінчується `\0`. КОЖНИЙ рядок повинен містити ХОЧА Б ОДИН UTF-8 символ! (наприклад, `\n`). 
Кожному diff-рядок (який, як ми знаємо, закінчується символом `\0`) з реальних файлів, які порівнюються, 
має дві версії рядка(рядків) (вони носять назву "ver-block") з різних файлів, і ці версії (ver-блоки) розділені 
символом `\1`:

Правила:
1. від початку рядка ДО `\1` значення ver-блока з `file 1` (ver — означає versioned).
2. від `\1` і до `\0` - значення ver-блока з `file 2`.
3. від початку рядка до `\0` (символ `\1` відсутній!) - значення цього рядка СПІЛЬНЕ для `file ` і `file 2`. 
   Такий рядок назвемо — "звичайний" — він реально зберігає один рядок тексту (останній символ рядка — `\n`) перед `\0`.

Під "ver-блоком" мається на увазі нуль, один або кілька звичайних текстових рядків, які "корелюють" з ver-блоком на 
цьому ж місці файлу, але з іншого вхідного файлу, тобто це такі блоки рядків, які можна з одного файлу перенести в 
інший, не зачіпаючи інші рядки.

Рядки, які збігаються ("звичайні") (правило 3) (у них значення рядка з `file 1` збігається зі значенням рядка `file 2`) 
є спільними, і для них НЕ ПОТРІБНО дві версії, тоді в такому рядку відсутній роздільник \1 і весь рядок від початку і до 
символу `\0` присутній в обидвох файлах.

Рядки, що відрізняються (мають у собі роздільник `\1`) (правила 1,2) є, по суті, diff-patches, які ми й мусимо 
розв'язати (фактично перетворити їх на п.3).

Існує декілька розв'язків такого patches (віртуального рядка, який складається з двох рядків, розділених символом `\1`):
1. Вибираємо віртуальний рядок з `file 1`:  видаляємо символ `\1` і всі символи після нього аж до символу `\0`.
2. Вибираємо віртуальний рядок з `file 2`:  видаляємо всі символи від початку рядка аж до символу `\1` включно.
3. Об'єднуємо обидва варіанти — видаляємо тільки символ `\1`.
4. Видаляємо обидва варіанти (весь diff-patch) — видаляємо цілий diff-рядок.

Наступною операцією після п.1-3 є перетворення отриманого віртуального рядка у звичайні — тобто розбиваємо віртуальний
рядок виду "line1\nline2\nline3\n" на три звичайні рядки типу: "line1\n\0", "line2\n\0", "line3\n\0" і 
вставляємо їх послідовно один за одним замість розв'язаного diff-рядка.

Таким чином ми, фактично, маємо "текстовий редактор вбудований в текстовий редактор":
Звичайні `\0`-рядки які не мають усередині символу `\1`, можуть уміщувати ТІЛЬКИ ОДИН СИМВОЛЬНИЙ РЯДОК 
(останній символ перед `\0` - символ `\n`) створюють цей основний рядактор, в якому деякі рядки (з символом `\1`) 
можуть зберігати багаторядкові рядки (з 0-N символів `\n` всередині) і які зручно редагувати незалежно від 
основного тексту.

Проблема виникає тільки при спробі взаємодії між обидвами цими "редакторами" одночасно:
І справді, дадавати/видаляти/копіювати/вставляти/виділяти тексти в межах одного з них - це тривіальна задача.
Але що робити, якщо користувач почне виділення наприклад на звичайному рядку, а закінчить на diff-рядку?
наприклад:

```
звичайний рядок 1\n\0
звичайний рядок 2\n\0
ver-блок 1\n(multiline)\1ver-блок 2\n(multiline)\n\0
звичайний рядок 3\n\0
звичайний рядок 4\n\0
```

Тривіальні виділення (початок/кінець виділення показані символами `[]`):

Варіант 1. Виділяти послідовно звичайні рядки:
```
зви[чайний рядок 1\n\0
звичайний рядок] 2\n\0
ver-блок 1\n(multiline)\n\1ver-блок 2\n(multiline)\n\0
```

Варіант 2. Виділяти рядки в межах одного ver-блоку:
```
звичайний рядок 2\n\0
ve[r-блок 1\n(multil]ine)\1ver-блок 2\n(multiline)\n\0
звичайний рядок 3\n\0
```

Варіант 3. Виділяти звичайні рядки, між якими є diff-рядки (diff-patch повністю видаляється і замінюється звичайним(и) 
рядком(рядками):
```
звичай[ний рядок 2\n\0
ver-блок 1\n(multiline)\1ver-блок 2\n(multiline)\n\0
звичайний ря]док 3\n\0
```

Нетривіальні:
Варіант 4. Виділення починається на звичайному рядку, закінчується на першому ver-блоці diff-рядка:
```
зви[чайний рядок 2\n\0
ver-бл]ок 1\n(multiline)\1ver-блок 2\n(multiline)\n\0
звичайний рядок 3\n\0
```

Варіант 5. Виділення починається на першому ver-блоці, а закінчується на другому:
```
звичайний рядок 2\n\0
ver-бло[к 1\n(multiline)\1ver-бл]ок 2\n(multiline)\n\0
звичайний рядок 3\n\0
```

Варіант 6. Виділення починається на ver-блоці diff-рядка, а закінчується на звичайному рядку:
```
звичайний рядок 2\n\0
ver-блок 1\n(multiline)\1ver-блок 2\n(mul[tiline)\n\0
звичайний ря]док 3\n\0
```

Для уніфікації досвіду роботи з текстом необхідно продумати, як реагувати на такі операції, чи дозволяти їх, чи 
забороняти? Ось які правила були прийняті:

1. Обидва ці текстові редактори (звичайних текстів і ver-блоків) НЕ ЗМІШУВАТИ! Це значить, що виділення ПОВИННО 
   починатись і закінчуватись:
   1. на звичайному рядку. Між ними може бути diff-рядок (варіанти 1 і 3);
   2. на одному ver-блоці (варіант 2)
2. ЗМІШУВАННЯ ЗАБОРОНЕНІ: варіанти 4,5,6 недопустимі!

Як цього добитись?
1. при виділенні з допомогою клавіатури при початку виділення на звичайному рядку і, за спроби продовжити виділення на
   diff-рядку, — (вибираємо наступний рядок з допомогою `[up]`/`[down]`/`[pg up]`/`[pg down]`) i виділення автоматично
   перескакує на наступний після diff-рядка звичайний рядок.
2. при виділенні мишкою (наприклад, клікнули по звичайному рядку й тягнемо мишку вниз), при початку виділення на 
   звичайному рядку й потраплянню мишки на зону diff-рядка виділення зупиняється на останньому символі останнього перед
   diff-рядком звичайного рядка й знову продовжує виділення тільки на першому ПІСЛЯ diff-рядка звичайному рядку. Усе це
   відбувається так, ніби diff-рядок — це справді окреме "вікно" з власним редактором і кнопками управління, а виділення
   іде "під ним" (за ним), і тому їх не видно.
3. при виділенні всередині одного ver-блока виділення не може вийти за межі цього блока! Навіть Ctrl+A (Cmd+A) не виділяє
   увесь файл, а виділяє УВЕСЬ ТЕКСТ в ОДНОМУ ver-блоці! Це ще раз підкреслює цей особливий режим редагування ver-блоку:
   ver-blок - це окремий текст, який редагується НЕЗАЛЕЖНО від основного тексту документу чи тексту в іншому ver-bлоці!

Над diff-рядком знаходиться рядок кнопок `<<<<< [apply ↓][remove ↓] ({local deviceLabel})`
Між обидвами div-блоками (по суті - окремими текстовими редакторами) знаходиться рядок:
`===== [apply both ↓↑][remove both ↓↑][join ({remote deviceLabel})]`
І під diff-рядком знаходиться рядок кнопок `>>>>> [apply ↑][remove ↑] ({remote deviceLabel})`

При русі по diff-editor з допомогою клавіатури (клавіші `[up]`/`[down]`) ці рядки кнопок ПРОПУСКАЮТЬСЯ (ПЕРЕСКАКУЮТЬСЯ)
як в одну сторону, так і в іншу. Ці рядки з кнопками ДОСЯЧНІ ТІЛЬКИ ДЛЯ кліків мишки!

А на рівні клавіатурних hotkeys діють такі правила (ДІЮТЬ ТІЛЬКИ ТОДІ, КОЛИ КУРСОР ЗНАХОДИТЬСЯ В ОДНОМУ З ver-блоків!):
1. `[apply]` даного блоку запускається комбінацією клавіш `<CTRL+Enter>`
2. `[remove]` даного блоку запускається комбінацією клавіш `<CTRL+Backspace>` (це важливо для Mac! і зручно навіть для 
   інших OS) 
3. `[apply both]` запускається комбінацією клавіш `<Ctrl+Shift+Enter>`
4. `[remove both]` запускається комбінацією клавіш `<Ctrl+Shift+Backspace>`
5. `[join (remote)]` запускається комбінацією клавіш `<Ctrl+Shift+.`

Значення цих hotkeys у вигляді підказок з'являються як Alt-текст при наведенні мишки на певну кнопку 
(apply, remove, join).

**R7.7.a. Undo-stack і Persistent autosave (захист від crash / battery die).**

**Чому vanilla CM6 history недостатня.** Standard CM6 `historyField` тримає список undo-кроків
**у пам'яті**. Після Obsidian kill (low-memory на iOS, battery die, OS-restart, force quit) RAM
зникає. Користувач, що повернувся через 2 години і відкрив той самий конфлікт, у vanilla-сценарії
отримає чистий буфер з ours-on-disk, і `Ctrl+Z` для повернення до chunk-3 не існуватиме. Це
несумісно з UX-обіцянкою "експериментуй вільно, можеш повернутись назад".

**Чому §4.4 (preserve-all-commits) цього не покриває.** PSEUDO-MERGE-MODE §4.4 і §8 фіксують
**міжsync-ну** історію — кожне натиснення `[Sync]` під час відкритого конфлікту створює окремий
commit на conflict-branch, який лишається reachable назавжди через final merge-commit. Це
durable archive **між** sync-кліками. R7.7 покриває принципово інший рівень: **intra-session,
intra-chunk** undo-кроки **всередині** одного відкриття DiffPane, які жодного `[Sync]` ще не
бачили. Між цими двома рівнями немає overlap-у — §4.4 не може врятувати chunk-3 під час
resolve-сесії, R7.7 не претендує на роль durable-archive.

1. файли, які передані в в diff-editor фізично НЕ РЕДАГУЮТЬСЯ і НЕ ПЕРЕЗАПИСУЮТЬСЯ при розв'язанні конфліктів, 
   а перезаписуються один раз тільки коли користувач натиснув `[<- back]` в diff-editor.
2. При кожному внесенні змін в diff-editor - створюється UNDO-блок, накладання якого на текст повертає текст до стану,
   перед внесенням цих змін. Список UNDO-блоків зберігається ТІЛЬКИ в оперативній пам'яті!
3. При кожному внесенні змін в diff-editor - зміни, які зробив користувач, і які стали тригером додавання UNDO-блоку до 
   списку UNDO, генерує відповідний REDO-блок, накладання якого на попередній стан редактора додає змінені дані 
   користувача в текст.
4. REDO-блок одразу ж пишеться на диск в recovery-file у форматі APPEND, нехай у форматі json. ЦЕ ВСЕ ЩО ПИШЕТЬСЯ НА ДИСК!
5. при збої живлення чи інших збоях, коли користувач знову запускає diff цих самих файлів, а для них існує такий 
   recovery-file (в ньому також має бути записано SHA вхідних файлів, щоб раптом не накласти зміни на інші, 
   ззовні змінені файли!) - питаємо користувача "відновити редагування чи почати з початку?" Якщо користувач відповідає
   "з початку" - видаляємо recovery file і редагування починається з оригінальних вхідних файлів. Якщо користувач вибирає
   "відновлення" - тоді "накатуємо" увесь recovery-file на diff-файл, створений з оригінальних вхідних файлів і отримуємо
   стан файлу буквально за 1 секунду до збою!

**R7.7.c. Дві дії "виходу" з detail view.**

- **`[←]` back arrow** (у toolbar) — **точка коміту**:
    1. Записати поточний document buffer у vault (заміщає ours-байти base-file).
    2. **Proactive sibling cleanup** (R7.11): обчислити `SHA(base)` після write і порівняти з
       `SHA(siblingN)` для кожного sibling-у цього base-path-а. Для кожного match — diff2
       одразу видаляє той sibling з vault через `vault.adapter.remove(siblingPath)`. Чому
       adapter-level, а не `vault.delete`: vault.delete не працює для path-ів у `.obsidian/`
       (config-folder dotfiles, які теж можуть мати conflict siblings, якщо
       `syncConfigDir=true`). Adapter API — єдиний шлях, що покриває обидва випадки. Sibling
       при цьому НЕ потрапляє у `.trash/` (TrashWatcher patches лише `vault.delete` —
       user-initiated path; programmatic `adapter.remove` навмисно not patched, бо sync2
       теж використовує його у `applyRemoteDeletion`). Втрати інформації немає — байти
       sibling-а ідентичні base-байтам, які вже збережено у кроці 1.
    3. Видалити `.diff2-autosave/<conflictId>/` повністю (чорновик спожитий).
    4. CM6-історія анулюється.
    5. Закрити detail view, повернутись у list view (R2.2).
    6. На наступному drain Phase A знайде або відсутній sibling (drop record через
       `sibling was deleted by user` гілку), або (для tracked-конфлікту, де sibling ще на місці
       після часткового resolve) `siblingSha == baseSha` (drop record через engine-deletable
       гілку — резервний шлях, якщо proactive cleanup кроку 2 з якоїсь причини не спрацював).
       Phase B синтезує side-batch і пушить consolidated base-bytes на main
       (PSEUDO-MERGE-MODE §5 + §10 Scenario E).

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

  Tab-close **експліцитно знищує чорновик**, а не залишає його як "повернись пізніше" —
  щоб користувач мав чіткий вибір: `[←]` зберегти, `[x]` викинути. Без двозначності типу
  `[Continue editing] / [Start over]` при наступному відкритті.

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
- "Все, я наплутав, скасуйте усе" → close tab `[x]` → autosave видалений → re-open → той самий конфлікт чекає з
  ours-on-disk.
- "Зробив пів-роботи, хочу відкласти, не закриваючи Obsidian" → `[←]` зараз (save partial → R4 T2 виявить, що file still
  divergent,
  конфлікт лишається з прогресом).
- "Робив 20 хв, Obsidian Mobile killed по low memory" → перезапуск → re-open → recovery dialog → `[Continue editing]` →
  курсор там же,
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

**R7.8. Free editing of everything.** Користувач має право **вільно редагувати усе** у файлі — будь-який рядок без
обмежень:

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
  per-chunk кнопки) автоматично переходимо до наступного нерозв'язаного chunk-у: курсор + scroll позиціонуються на
  ньому.
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
(`isMarkdown(path) === true`). Для JSON/YAML/CSS/CSV blockquote вставка корумпує синтаксис, тому операція там
недоступна.

**Footer** (внизу DiffPane, у всіх режимах однаковий):

- Лічильник "`N` unresolved chunks" (live update при кліках/edit-ах). У History/Compare режимах "unresolved" просто
  означає "diverging" (відмінні), без resolve-семантики.
- **Навігаційні кнопки** `[↑ prev chunk]` / `[↓ next chunk]` — клік переходить курсор до попереднього/наступного
  diverging-блоку у документі. Працюють у всіх режимах, включно з Reference (бо це навігація, не редагування).

**Жодних дефолтних hotkey-ів** плагін не задає. Причини:

- `Alt`-based комбінації (як `Alt-N`) на macOS зайняті системою для спецсимволів (`Alt-N` → `ñ`), користувач не може
  ними скористатись.
- Mobile (iOS/Android) hotkeys взагалі не релевантні — Obsidian mobile не має зовнішньої клавіатури типово.

Замість дефолтних hotkey-ів усі операції (next chunk / prev chunk / take ours / take theirs / take both / resolve all /
open external)
експортуються як **Obsidian commands** у command palette. Користувач, який хоче hotkey-и, прив'язує їх через стандартну
Obsidian
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

- chunks теж кольорові (зелений = тільки у першому файлі, червоний = тільки у другому/старій версії, жовтий = змінено) +
  word-level
  diff.
- Документ read-only (для history) або editable (для compare two — але без auto-finalize, бо це не конфлікт).
- Для history mode footer містить `[Restore this version]`.

### R7.11. Exit protocol — proactive sibling cleanup

**Канонічна специфікація для всіх шляхів виходу з resolve-сесії** (internal `[←]` у DiffPane,
external diff tool process-exit з Read result back). Виноситься як окрема підсекція, бо на неї
посилаються R7.7.c step 5 і R6.4 step 4 — щоб обидва шляхи мали єдине джерело істини.

**Критерій успіху** (єдиний для tracked- і synthetic-конфліктів): пара `(base, sibling)`
розв'язана, коли `SHA(base) == SHA(sibling)`. Це той самий критерій, що PSEUDO-MERGE-MODE §5
використовує у Phase A drain-pseudocode (`remove sibling if siblingSha == baseSha`) і що §8
формулює user-facing-ом ("matches `idea.md` byte-for-byte"). Diff2 не вводить нового
contract-у — він **проактивно виконує існуюче правило** в момент editor-exit, а не чекає
наступного drain.

**Алгоритм при exit** (виконується після write base-buffer у vault):

```
1. baseBytes ← read(basePath)
2. baseSha ← computeBlobSha(baseBytes)
3. for each siblingPath, що належить цьому base-path-у (включаючи tracked- і synthetic-):
     siblingBytes ← read(siblingPath)
     siblingSha   ← computeBlobSha(siblingBytes)
     if siblingSha == baseSha:
       vault.adapter.remove(siblingPath)   ← proactive cleanup via adapter API
                                              (covers `.obsidian/*` config-dir
                                              siblings too; vault.delete не
                                              підтримує dotfile paths.
                                              NOT captured into `.trash/` —
                                              TrashWatcher patches лише
                                              user-initiated `vault.delete`)
       (для tracked-конфлікту: ConflictStore запис НЕ чіпаємо — Phase A на
        наступному drain дропне його через "sibling was deleted by user"
        гілку §5; це резервний invariant-restoring шлях)
4. close DiffPane
```

**N-sibling випадок (PSEUDO-MERGE-MODE §10 Scenario C).** Якщо у base-file-а N siblings, кожна
пара `(base, siblingK)` resolve-иться **незалежно**: користувач відкриває DiffPane для пари
`(base, sibling1)`, resolve-ить, виходить — diff2 видаляє sibling1 якщо matched. Потім
відкриває DiffPane для `(base, sibling2)`, тощо. Список конфліктів у R2.2 на кожному кроці
оновлюється event-driven через ConflictCounter (PSEUDO-MERGE-MODE §5: vault listener
`markDirty()`). Коли останній sibling зник — на наступному drain Phase A очищує всі записи,
Phase B пушить consolidated base на main, і якщо store стає порожнім — finalise block
закриває conflict-branch merge-commit-ом (§5 + §10 Scenario E).

**Що diff2 НЕ робить.** Не мутує `ConflictStore` (нема прямого `store.delete(record)`-виклику —
єдиний легальний мутатор Store-у це `evaluateConflictState` на drain-start, PSEUDO-MERGE-MODE
§5). Не торкається conflict-branch (не push-ить commit-и, не deleteRef-ить branch — це робота
finalise-блоку в `sync2-manager`). Не синтезує side-batch-и (це робота Phase B). Усе, що
diff2 робить — **vault-level operations**: write base, optionally remove sibling. Решта —
існуюча PSEUDO-MERGE-MODE машинерія, яка відреагує природно на vault-state-change.

**Чому це безпечно** (formal argument): PSEUDO-MERGE-MODE §9.7 встановлює "filesystem state
authoritative" — Store ніколи не "відновлює" sibling, якого у vault нема. Видалення sibling
diff2-ом — легальна vault-операція, ідемпотентна з `evaluateConflictState`'s view of the
world (Phase A на наступному drain побачить sibling-missing і дропне record). Це той самий
семантичний шлях, що бере PSEUDO-MERGE-MODE Scenario A коли користувач видаляє sibling через
file explorer — diff2 просто автоматизує цей крок коли SHA-критерій тривіально виконаний.

### R8. Crash resilience — наскрізний контракт

**Принцип**: для кожної багатокрокової disk-операції у diff2 повинно бути визначено:

1. **Точки можливого crash-у** — між якими двома кроками stale state може потрапити на диск.
2. **Інваріант стану на диску** — що "консистентний" означає для цього store-у.
3. **Recovery sweep** — функція, яка запускається при `onload` плагіна і відновлює half-applied state у консистентний (
   або повністю
   відкочений, або повністю завершений — never half-applied).
4. **Kill-mid-op тест** — окремий integration-тест (з fault-injection), який підтверджує recovery.

**R8.1. Walkthrough — основні операції і їх recovery contracts:**

| Операція                                                                             | Точки crash                                                                                                                                                                                                                                                                                           | Інваріант                                                                                                                                                                                                                                                                                                                                                                     | Recovery sweep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|--------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `TrashStore.create(file)` (R3.2)                                                     | (a) move-у `.trash/<id>/vault/<path>` зроблено, `meta.json` ще не записано → (b) `meta.json` записано, `vault.on('delete')` ще не emit-нув подію                                                                                                                                                      | Кожен `.trash/<id>/` має валідний `meta.json` АБО директорія вилучається при recovery (orphan move без meta = відкочуємо move назад у vault). **`meta.json` пишеться atomic-rename** (temp+rename) — щоб torn JSON не виглядав як "валідний meta-stub"                                                                                                                        | `TrashStore.recoverIncomplete()`: сканувати `.trash/`, для кожного `<id>/` перевірити `meta.json`. Відсутній/невалідний → відновити файл назад у `originalPath` (зчитаний з `vault/<path>` shape), видалити `<id>/`. **Collision-handling**: якщо `originalPath` зайнятий на момент recovery (юзер створив новий файл з тим іменем поки Obsidian був закритий) → НЕ клобберити; replacing path = `<originalPath>.recovered-<recoveredAt>.<ext>`, log Notice "recovered interrupted delete: <originalPath> → <newPath>" |
| `TrashStore.confirmDeleted(paths)` (R3.5 1a)                                         | Single-step disk operation: знайти `.trash/<id>/` з `meta.originalPath ∈ paths`, видалити directory recursively                                                                                                                                                                                       | Idempotent: повторний виклик з тими ж paths — no-op, бо вже видалено                                                                                                                                                                                                                                                                                                          | NOT needed: операція атомарна на рівні disk-API; failure посеред (один з recursive-removes впав) → solid state на наступному `confirmDeleted` чи `sweepOlderThan`. Логуємо warning при ENOENT для діагностики, не fail.                                                                                                                                                                                                                                                                                                |
| `TrashStore.confirmResolved(basePath)` (R3.5 1b)                                     | Single-step disk operation: знайти `.trash/<id>/` з `stripConflictSuffix(meta.originalPath) == basePath`, видалити directory recursively                                                                                                                                                              | Idempotent                                                                                                                                                                                                                                                                                                                                                                    | Same as above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TrashStore.sweepOlderThan(threshold)` (R3.5 layer 2)                                | Iteration над `.trash/`, для кожного `<id>` де `<id> < threshold` — recursive remove. Crash може залишити частково видалену `<id>/` (часть файлів видалена, директорія ще лежить)                                                                                                                     | Половинно-видалені `<id>/` не порушують інваріант: `meta.json` могла зникнути → це той самий випадок, що `TrashStore.create` partial → recovery sweep знайде `<id>/` без меti і вирішить долю                                                                                                                                                                                 | Same `recoverIncomplete()` що для `TrashStore.create`: невалідний meta + порожній/частковий `vault/` → видалити `<id>/` цілком (вже не recovery-able to vault, файл втрачено — допустимо, ми ж його все одно sweep-нути збиралися).                                                                                                                                                                                                                                                                                    |
| `TrashStore.liftForCompare(id)` / `returnFromCompare(sessionId)` (R3.7)              | Single-step `atomicWriteJson(.trash/<id>/meta.json, ...)` (temp + safeRename). Atomic на disk level — або marker записаний, або ні. Файл у `.trash/<id>/vault/<originalPath>` не зачіпається (немає rename взагалі).                                                                                  | `.trash/<id>/meta.json` завжди валідний; поле `liftedAsSessionId` set/clear відповідає реальному наміру UI. Intermediate states типу "marker частково записаний" виключені temp+rename pattern-ом.                                                                                                                                                                            | onload: scan `.trash/<id>/meta.json`. Для кожного record з `liftedAsSessionId` set — clear field, rewrite meta.json. Логіка: при крашу UI вмирає, активних compare-сесій немає, marker без сесії = stale state. Файл у vault/ не зачіпається. Після clear-у record повертається у нормальний three-layer flow.                                                                                                                                                                                                         |
| `ConflictStore.create(...)` — між sibling write і `.conflicts/<id>/` create          | Покривається існуючим Path B 3-step протоколом (PSEUDO-MERGE-MODE §9.4) і єдиним `AtomicWriteRecovery.sweep` (§9.5). Crash між Step 1 і Step 2 → `.sync-tmp` без record → видаляється Path A fallback-ом. Crash між Step 2 і Step 3 → record + `.sync-tmp` → sweep довершує Step 3 (SHA-verify match) | Інваріант уже сформульовано в §9.5 ownership-dispatch таблиці. Diff2 додає **тільки одне**: якщо у vault знайдено `*.conflict-from-*` файл з final-name без запису в Store — це **НЕ orphan для видалення**, а кандидат на **synthetic conflict** (R2.2 + R3.3 Правило 3). Diff2 vault-scan детектить такі пари і показує в list view; `AtomicWriteRecovery` їх не торкається |
| `ConflictStore.create(...)` — між `.conflicts/<id>/` create і in-memory index update | (b) `.conflicts/<id>/meta.json` записано, in-memory index ще не оновлено                                                                                                                                                                                                                              | Index консистентний з диском                                                                                                                                                                                                                                                                                                                                                  | In-process, recovery NOT needed: `ConflictStore.load()` при наступному onload re-індексує з диску, закриваючи будь-яке in-memory desync                                                                                                                                                                                                                                                                                                                                                                                |
| `R7.7 autosave`                                                                      | (a) `buffer.txt` записано, `history.json` ще не → (b) обидва записані, `meta.json` ще не → (c) `meta.json` записано, але це новий autosave старого вилучити не встиг                                                                                                                                  | `meta.json` є → autosave валідний (його `lastWriteAt` свіжий); `meta.json` немає → autosave incomplete                                                                                                                                                                                                                                                                        | `.diff2-autosave/<id>/` без `meta.json` → видалити цілком (recovery dialog → fallback на ours-on-disk)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `R6 spawn external tool`                                                             | (a) `.tmp/<id>/{ours,theirs}.ext` записано, процес запущено, exit не дочекалися (Obsidian killed)                                                                                                                                                                                                     | `.tmp/<id>/` сам по собі — допустиме intermediate state; ніяких vault-сайдефектів до exit-handler-а немає                                                                                                                                                                                                                                                                     | onload sweep: видалити всі `.tmp/<id>/` (вони stale, процес уже не існує)                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**R8.2. `onloadRecoverySweep()` — єдиний point of entry.**

У `main.ts::onload`, після `loadSettings()` і перед wire-up listener-ів:

```typescript
await onloadRecoverySweep({
    trashStore,         // recoverIncomplete()
    conflictStore,      // вже існує: orphan cleanup для `.conflicts/<id>/` без sibling
                        // (orphan-sibling-без-record тепер показується як synthetic
                        //  conflict, не видаляється — див. R2.2 + R3.3 Правило 3)
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

- Concurrent crashes (kill під час recovery sweep). Прийнятна модель — recovery sweep сам ідемпотентний; повторний crash
  під час нього просто
  залишає state, який повторний onload зачистить.
- Disk-corruption (зіпсовані байти у середині файлу). Об'єкти типу `meta.json` парсяться через `JSON.parse` з try/catch;
  invalid JSON →
  трактується як відсутній і wipe-ається.

### R9. Implementation roadmap (phased)

Дванадцять фаз, кожна — окремий PR розміру 200–800 рядків коду + тести. Канонічна
енумерація для цього плану (Принципи #6 говорять про "phased delivery"; деталі — тут).

**MVP-cliff.** Phases 0–2 — це **infrastructure** (нема user-facing value: список і
порожня панель). Перший shippable user-feature з'являється на **Phase 3** — там end-to-end
resolve-flow вже працює (відкрити конфлікт → натиснути `[apply]` → `[←]` → file пишеться у
vault → Phase A на наступному drain auto-cleans). Усе після Phase 3 ortogонально додає
історію, deleted, compare, external tool — у будь-якому порядку, якщо потрібно зупинитись
на якійсь фазі і паралельно випустити білд.

**Per-mode toolbars (R7.9) розподілені по фазах їхніх режимів.** R7.9a ships у Phase 3
(Conflicts toolbar потрібен для resolve-flow); R7.9b — у Phase 7 (History); R7.9c — у
Phase 8 (Compare); R7.9d — у Phase 9 (Deleted). Phase 6 — це **тільки** entry-points
(R2.7), без toolbar-роботи.

**Phase 9a sync2 carve-out.** R3.5 (three-layer TTL) + R3.4 (pull-delete capture) разом
вимагають чотирьох callback-ів від `sync2`:

- `captureForDelete(path: string)` — викликається з `applyRemoteDeletion` ПЕРЕД
  `adapter.remove(path)` (R3.4). Створює `.trash/<id>/` запис з байтами файлу до того, як
  він зникне з vault.
- `confirmDeleted(paths: string[])` — викликається з `processBatch` після кожного успішного
  push (прошарок 1a).
- `confirmResolved(basePath: string)` — викликається з `processBatch` після успішного push
  side-batch-у з `meta.resolvesConflictForBasePath` set (прошарок 1b).
- `sweepOlderThan(threshold: string)` — викликається з `Sync2Manager` наприкінці drain-у,
  **тільки якщо** queue порожня і не було abort-у (прошарок 2). Threshold = `drain.startedAt`
  (17-цифровий timestamp, фіксується перед `findChanges`).

Усі чотири — **events, не імпорти.** `sync2` отримує їх як `trashHooks` через
constructor-injection; `diff2` (`TrashStore`) надає їх при wire-up у `main.ts`. Імпорт
`src/sync2/* → ../diff2/*` залишається забороненим (CLAUDE.md).

Додатково: `EnqueueMeta` (`push-queue.ts`) отримує опційне поле
`resolvesConflictForBasePath?: string`. Це єдиний type-level edit у `sync2/`; воно **не
залежить** від `diff2/` (просто пасивне metadata, яке `sync2` пише і читає в межах своєї
логіки; `diff2` його лише **спостерігає** через `B.meta` всередині `confirmResolved`-callback).

#### R9.1. Phase table

| #  | Status                                | Scope                                                                               | R-coverage                                                                | Key files (new + edits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|----|---------------------------------------|-------------------------------------------------------------------------------------|---------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 0  | infra                                 | Module scaffolding                                                                  | —                                                                         | `src/diff2/{diff-edit-view.ts, events.ts}` (new); `src/diff2/types.ts` (extend with DiffEditView/DiffPaneState/etc; trash types already there from Phase 9a); `src/main.ts` (edits: registerView, 4 stub commands)                                                                                                                                                                                                                                                                                                                                                                                                                                 | `pnpm build` clean; `Open Diff-Edit` command opens empty view tab; existing unit + integration tests pass unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 1  | infra                                 | Conflicts list + synthetic detection                                                | R2.0, R2.2                                                                | `src/diff2/{conflicts-list.ts, synthetic-detector.ts}`; `diff-edit-view.ts` (edits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status-bar 🔀 click opens view; list shows tracked + synthetic items with distinct badges; group-by-path expandable rows; click → empty detail placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2  | infra                                 | DiffPane render + free editing                                                      | R7.1–R7.4, R7.8                                                           | `src/diff2/{diff-pane.ts, diff-chunks.ts, word-level-diff.ts, markers.ts, decorations.ts}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Click conflict opens DiffPane з кольоровим diff + marker block-widgets + word-level highlights; free-edit працює; жодних action-кнопок ще нема                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3  | **mvp**                               | Action buttons + group buttons + `[←]`→write-to-vault                               | R7.5, R7.6, R7.9a, R7.7.c (steps 1, 4–5 only: write, history-null, close) | `src/diff2/{chunk-actions.ts, conflict-merge-all.ts, toolbar-conflicts.ts}`; `diff-pane.ts` (edits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Per-chunk `[apply]/[remove]`; групові `[Keep all local]/[Apply all remote]/[Join all]` (md only); `[←]` пише buffer → base-file через `atomicWriteFile`; sibling cleanup тут — **через Phase A на наступному drain** (sibling видимий до наступного [Sync] click; proactive cleanup при `[←]` ship-иться у Phase 4). Перший end-to-end resolve flow вже працює                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4  | releasable                            | Exit protocol + proactive sibling cleanup                                           | R7.11, R7.7.c (step 2 added: SHA-compare + remove)                        | `src/diff2/exit-protocol.ts`; `diff-pane.ts` (edits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `[←]` тепер додатково: `for siblingK of siblings(basePath): if SHA(base) == SHA(siblingK): vault.adapter.remove(siblingK)`. Adapter-level (не `vault.delete`), щоб працювало і для siblings у `.obsidian/*` config-dir-у (якщо `syncConfigDir=true`). Multi-sibling Scenario C працює (PSEUDO-MERGE-MODE §10). Idempotent: drain after diff2-cleaned sibling = no-op for that record. **NB**: `adapter.remove` НЕ ловиться TrashWatcher (TrashWatcher patches лише `vault.delete` — user-initiated path); sibling permanent-deleted. Без втрати інформації — bytes ідентичні base-байтам, які щойно збережені у step 1. Acceptance test: SHA match → sibling gone з vault; drain after diff2-cleanup → no-op для цього sibling-а                                  |
| 5  | releasable                            | Persistent autosave + recovery dialog                                               | R7.7.a, R7.7.b, R7.7.d                                                    | `src/diff2/{autosave-store.ts, cm-history-serde.ts, recovery-dialog.ts}`; `diff-pane.ts` (edits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Throttled (1.5 s) write `buffer.txt + history.json + cursor.json + meta.json`; atomic-rename per файл; recovery dialog при reopen; `oursShaAtStart` mismatch → wipe + fresh; tab-close видаляє autosave, crash зберігає                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 6  | releasable                            | Entry points + summary modal + diff ribbon icon                                     | R2.7 (entry-points only)                                                  | `src/diff2/{entry-points.ts, summary-modal.ts}`; `src/main.ts` (edits); `src/settings/{settings.ts, tab.ts}` (edits — `showDiffRibbonButton` toggle)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | File-menu `Compare with…` / `Show history` + **`Resolve conflict`** on `*.conflict-from-*` siblings (R2.7.1 — uses `stripConflictSuffix` from PR-2, no ConflictStore lookup, works for synthetic + delete-vs-modify); command palette commands; status-bar 🔀 живе; **new** ribbon `diff` icon (R2.7.4) показує badge з кількістю конфліктів (та сама величина, що `🔀 N`; opt-in через `Show diff ribbon button` toggle поруч з `Show sync ribbon button` у Settings → Interface; default ON для нових інсталяцій). Sync-ribbon-іконка більше НЕ показує conflict-counter (це робить push-queue depth, координовано з PUSH-REORG Phase 6). Post-sync modal `[Continue] / [Go to Diff-Edit]` (тільки коли 0→N transition).                                        |
| 7  | releasable                            | History mode                                                                        | R2.3, R7.9b                                                               | `src/github/client.ts` (edits — `listCommitsForPath`, *permitted cross-cut: read-only API wrapper, не sync2-internal*); `src/diff2/{history-list.ts, restore-version.ts, toolbar-history.ts}`; `diff-edit-view.ts` (edits)                                                                                                                                                                                                                                                                                                                                                                                                                         | `Show history of active file` працює; список спершу з push-queue, GitHub on demand (`[Show GitHub history…]`); DiffPane у read-only/edit toggle; `[Restore this version]` з confirm-модалкою                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8  | releasable                            | Compare any two                                                                     | R2.1, R7.9c                                                               | `src/diff2/{file-picker.ts, compare-mode.ts, toolbar-compare.ts}`; optional desktop-only `fs-browse.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `Compare two files…` + `Compare active file with…` + file-menu `Compare with…` працюють; FuzzySuggestModal picker; `[Swap]`; `✏️/🔒` toggle default Reference; filesystem-browse — за результатом R2.1 research (інакше scope-cut)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9a | ✅ **shipped** (`28fd725` … `4941592`) | TrashStore core (move-to-trash + three-layer cleanup + compare-lift API + list API) | R3.1–R3.13 (full subsystem), R8.1 trash rows                              | `src/diff2/{trash-store.ts, trash-watcher.ts, trash-recovery.ts}`; `src/sync2/push-queue.ts` (edits — `EnqueueMeta.resolvesConflictForBasePath?: string`); `src/sync2/sync2-manager.ts` (edits — `drain.startedAt`, constructor-injected `trashHooks: {captureForDelete, confirmDeleted, confirmResolved, sweepOlderThan}`, hook call у `applyRemoteDeletion` ПЕРЕД `adapter.remove`, set `resolvesConflictForBasePath` у Phase B `synthesizeResolutionSideBatches`); `src/main.ts` (edits — monkey-patch `app.vault.delete/trash` на onload + restore на unload, wire trash-watcher + hooks); **жодного імпорту з diff2 у sync2** — див. R9 prose | Delete через Obsidian UI → patched vault.delete захоплює байти у `.trash/<id>/`; pull-delete через sync2 → explicit `captureForDelete` hook теж захоплює (R3.4 short recovery window); three-layer cleanup при drain (1a + 1b per batch, 2 на drain-end — pull-delete entries свайп-аються наступним drain-ом за `<id> < drain.startedAt`); compare-lift API — metadata-only marker `liftedAsSessionId` у `.trash/<id>/meta.json` (R3.7), файл не рухається; `TrashStore.list()` повертає disk-scan результат (async, без in-memory index, realistic N ≈ 3–20 entries); `subscribe(() => void)` — bare-signal для UI live-update. **Restore не реалізується у цій фазі.** Onload recovery sweep для intercept partial-states + stale lift markers (clear на disk) |
| 9b | releasable (**depends on Phase 7**)   | Deleted mode UI + restore                                                           | R2.4, R3.6, R7.9d                                                         | `src/diff2/{deleted-list.ts, toolbar-deleted.ts, trash-store.ts}` (edits — `restore(id)` operation + R8.1 `TrashStore.restore` row recovery)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Deleted sub-tab список (`.trash/` + GitHub history); detail view single-side preview (R2.4); `[Restore]` повертає trash entry або з GitHub; path-only-when-empty filter. **Залежить від Phase 7** — GitHub-history-side рендер і restore вимагають `client.listCommitsForPath`, який ship-ить Phase 7. Якщо 9b треба ship-нути до 7 — scope-cut на **local-trash-only** (без GitHub-history секції); restore з GitHub додається у post-7 patch                                                                                                                                                                                                                                                                                                                    |
| 10 | releasable                            | External diff tool                                                                  | R6                                                                        | `src/diff2/{external-tool.ts, shell-arg-parse.ts}`; `src/settings/{settings.ts, tab.ts}` (edits — desktop-only section); `toolbar-*.ts` (edits — `[Open in external tool]` button)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Desktop only: settings section з command template + Read-result-back; spawn без `shell: true`; ENOENT → Notice + fall-back на internal; mobile повністю прихований; integration з R7.11 exit-protocol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 11 | releasable                            | Full `onloadRecoverySweep` + cross-phase QA                                         | R8.2                                                                      | `src/diff2/onload-recovery-sweep.ts`; `src/main.ts` (edits — wire у onload після `loadSettings`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Усі diff2-side sweep-и (`trashStore.recoverIncomplete`, `autosaveStore.sweep`, `tmpStore.sweep`, conflict-store synthetic-detection-aware behavior) ідуть з єдиної точки; kill-mid-op тести з R8.3 зеленi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### R10. Test plan

Розташування — три директорії, узгоджені з існуючою test-інфраструктурою (CLAUDE.md
*Testing*):

- `tests/diff2/` — unit тести diff2-модулів (vault-stand-in через існуючий `mock-obsidian.ts`).
- `tests/diff2/crash-resilience/` — kill-mid-op сценарії з fault-injection (R8.3 шаблон —
  `<store>-kill-after-<step>.test.ts`).
- `tests/integration/scenarios/diff2/` — справжній GitHub flows (нова buckets):
    - `m-series-history/` — `listCommitsForPath` end-to-end (Phase 7).
    - `n-series-trash/` — trash ↔ sync взаємодія, TTL=0 cleanup (Phase 9).

**Тести додаємо, не заміняємо** (Принцип #4). Існуючі 429 unit + ~106 integration тести
sync2 мають лишитись бітово ідентичними. Якщо diff2-зміна змушує sync2-тест падати —
це регрес у diff2, не "застарілий тест"; шукати корінь.

**Test-file enumeration.** Конкретний список test-файлів складається per-PR разом із
phase-кодом, не у плані (щоб не розходилося). Phase R9-row "Acceptance" формулює
поведінкові вимоги; PR-автор маппить їх на потрібну кількість test-файлів.

**Open question (Phase 2 PR-blocking) — CM6 *widget rendering* spike.** Phase 2 рендерить
`Decoration.widget` (marker block-widgets) у DiffPane. Чи існуюче JSDOM-середовище
(`mock-obsidian.ts`) коректно проганяє CM6 view-update-цикл — невідомо. Спайк (~2 години)
перед Phase 2 PR: написати найпростіший `tests/diff2/diffpane-render.test.ts` з 3-рядковим
diff і перевірити чи widget-DOM-елементи з'являються. Якщо не працює — або mock-DOM-
розширення, або переносити render-тести у Playwright.

(*Окремо від цього*, R11 згадує Phase-5-blocking CM6 *history serialization* spike —
це інша перевірка, інший API, не плутати.)

### R11. Readiness check — is the doc enough to start?

**Yes for Phase 0–1.** Документу достатньо, щоб одразу почати: scaffolding (Phase 0) і
Conflicts list + synthetic detection (Phase 1) мають чітко визначені деліверебли і
acceptance-критерії; жодних зовнішніх досліджень не потрібно.

**Blocked items для пізніших фаз** (не блокують старт Phase 0):

| Phase | Blocking item                                                                       | Type              | Resolution before PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|-------|-------------------------------------------------------------------------------------|-------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 2     | UI mockup для marker block-widgets layout, color palette, button visual style       | Design            | 1–2 mockups (Figma чи ASCII у issue), узгоджені перед Phase 2 PR. Без них Phase 2 ризикує rework-у після рев'ю. **Must validate density-on-mobile-viewport**: markdown chunks тепер мають 7 кнопок per chunk (top [apply][remove], middle [apply both][remove both][join], bottom [apply][remove]) — mockup має показати, як це render-иться на типовому phone-screen (e.g., iPhone 13 у Obsidian Mobile portrait). Якщо щільність неприйнятна — fallback на 2-кнопковий варіант з R7.5 commentary. |
| 2     | Diff library choice (`diff` vs `diff-match-patch`)                                  | Tech decision     | Порівняти bundle-size impact на mobile (production build); обрати у Phase 2 PR description.                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2     | CM6 *widget rendering* under JSDOM                                                  | Tech spike (~2 h) | Див. R10 — окрема перевірка від Phase-5 spike нижче.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 5     | CM6 *history serialization* — `historyField.spec.fromJSON` / `toJSON` API existence | Tech spike (~1 h) | Написати throwaway test що серіалізує + десеріалізує undo-stack. Якщо API нема або не покриває — fall back на buffer-only autosave без undo persistence (опція Q2-c з обговорення). **Це інша перевірка, ніж Phase-2 widget-rendering spike — не плутати.**                                                                                                                                                                                                                                         |
| 8     | Filesystem-browse API (R2.1)                                                        | Research          | Дослідити сучасні Obsidian / Capacitor / `electron.ipcRenderer` шляхи. Якщо нічого — scope-cut filesystem browse з R2.1 (план уже передбачає цей outcome). Phase 8 ship-able і без нього.                                                                                                                                                                                                                                                                                                           |

**Не блокують**: hotkey-bindings (експліцитно делеговано Obsidian Hotkeys settings),
diff lib name (decision-at-impl-time), фaза-ordering у 6–11 (orthogonal).

### R12. Remaining work — sequencing and dependencies

> **Стан:** Phase 9a (data layer) ✅ shipped. Phases 0–8 + 9b + 10–11
> залишаються. Цей розділ — runbook для виконання R9.1 well: критичний
> шлях, паралельні треки, що з чим перетинається.

#### R12.0. Pre-implementation spikes — ✅ COMPLETED

Both spikes landed at `tests/diff2/spikes/` (kept in tree as living
documentation of the assumptions Phase 2 / Phase 5 rely on).

| Spike                                                                                    | Result | Implication                                                                                                                                                                                                    |
|------------------------------------------------------------------------------------------|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **CM6 widget rendering under JSDOM** (Phase 2 blocker)                                   | ✅ PASS | `Decoration.widget` renders + updates correctly under vitest's happy-dom environment via `// @vitest-environment happy-dom` directive. Phase 2/3/4/5 testing stays in vitest — no Playwright migration needed. |
| **CM6 history `historyField` serde via `EditorState.toJSON/fromJSON`** (Phase 5 blocker) | ✅ PASS | Single + multi-edit round-trips work. JSON shape is plain (no circular refs / functions) — safe for `atomicWriteJson` persistence. R7.7.a ships per-spec.                                                      |

**Findings worth remembering for Phase 2:**

- vitest's default env is `node` (no DOM). Add
  `// @vitest-environment happy-dom` as a file directive on every
  diff2 test that constructs an `EditorView`. Existing unit tests
  (746 of them as of Phase 9a) **don't** need DOM — leave them on
  the default node env to keep them fast.
- `happy-dom@^20` added as devDependency.
- `view.requestMeasure()` may be needed after dispatching changes
  before querying widget DOM in assertions (CM6 batches measurement
  cycles).

**Findings worth remembering for Phase 5 (R7.7.a):**

- Use the **public** API `EditorState.toJSON({ historyField })` /
  `EditorState.fromJSON(json, config, { historyField })`. Internal
  `historyField.spec.toJSON/fromJSON` exists but isn't exposed via
  the TypeScript types; using it requires `as any` casts.
- Configure history with `history({ newGroupDelay: 0 })` for
  diff-edit sessions: per-chunk actions should each be their own
  undoable step. The default `newGroupDelay` (~500ms) folds rapid
  consecutive transactions into one group, which is wrong for
  programmatic chunk-action dispatching.
- `@codemirror/commands` and `@codemirror/state` versions must match
  (single-instance check fails otherwise — "Unrecognized extension
  value" runtime error). When upgrading either, bump both together.
- `@codemirror/state` bumped 6.5.2 → 6.6.0 during this spike to
  align with `@codemirror/commands@6.10.3`. No production regression
  (746 existing tests stayed green).

#### R12.1. Critical path to first user-visible release (Phases 0 → 3)

Linear sequence; each phase blocks the next. End-state: working
conflict-resolve flow.

```
Phase 0  →  Phase 1  →  Phase 2  →  Phase 3 (MVP)
scaffolding   list + synthetic   DiffPane    chunk-actions
                                  render      + [←] write
~300 LoC     ~600 LoC           ~1000 LoC    ~700 LoC
infra        infra              infra        first user-feature
```

**Realistic LoC estimate:** ~2600 lines + tests. Single engineer:
4–8 weeks. **Беta-shippable point:** end of Phase 1 — conflicts list
is itself UX-valuable as a "what's in conflict" panel even without
diff-editing. Consider an interim release tagged like
`2.1.0-alpha-conflict-list-only` if user feedback is needed early.

#### R12.2. Post-MVP — three orthogonal tracks

Once Phase 3 ships, остальні фази розпадаються на три треки. Усі **не
залежать одна від одної** і можуть йти паралельно якщо є кілька
engineers; для одного engineer обирати порядок за пріоритетом.

**Track A — UX polish (depth-first):**

```
Phase 4  →  Phase 6  →  Phase 5
exit         entry        persistent
protocol     points       autosave
+ sibling    + ribbon     + crash
cleanup      + status     recovery
                          (R7.7.a-d)
```

Чому такий порядок: Phase 4 — мала extension Phase 3 (proactive
sibling cleanup); Phase 6 робить UX feel-complete (entry points
скрізь); Phase 5 — найбільший за LoC і потребує spike, тож йде
останнім у треку.

**Track B — Read-only / compare features:**

```
Phase 7 (History)  →  Phase 8 (Compare)
listCommitsForPath    file-picker
+ DiffPane in         + compare mode
read-only mode
```

Phase 7 → 8 — м'яка залежність: Compare picker може використовувати
elements з History UI (version-list). Phase 8 інакше independent.

**Track C — Deleted UI + external tool:**

```
Phase 9b (Deleted UI)  →  Phase 10 (External diff)
needs Phase 7              desktop-only
listCommitsForPath         child_process
```

Phase 9b **требує Phase 7** для GitHub-history side рендеру і
restore (R3.6). Якщо 9b критично потрібен раніше, scope-cut на
local-trash-only варіант (без GitHub-history розділу); GitHub-side
landed-иться як post-7 patch.

#### R12.3. Final consolidation (Phase 11)

```
Phase 11 — onloadRecoverySweep unification + cross-phase QA
```

До Phase 11 кожен sub-system має власний onload sweep (trash-recovery
вже в `main.ts`, autosave-sweep з'явиться у Phase 5, tmp-sweep у
Phase 10, conflict-store sweep уже у Phase 0/sync2). Phase 11 зводить
все в єдину `onloadRecoverySweep({...})` обгортку — pure refactor + a
cross-phase smoke суіт що kill-mid-op kill при різних inflight states
і перевіряє, що жоден sweep не б'ється з іншим.

#### R12.4. Dependency matrix

Скан-friendly: лівий стовпець — фаза, права — що мусить landed
ПЕРЕД нею. Stale entries видалити, коли фаза landed.

| Phase | Hard deps (must ship first) | Soft deps (nice-to-have first)                               |
|-------|-----------------------------|--------------------------------------------------------------|
| 0     | — (Phase 9a ✅ shipped)      | spikes R12.0 пройдені                                        |
| 1     | 0                           | —                                                            |
| 2     | 1                           | R12.0 widget spike resolved                                  |
| 3     | 2                           | UI mockup (R11) узгоджений                                   |
| 4     | 3                           | —                                                            |
| 5     | 3                           | R12.0 history-serde spike resolved                           |
| 6     | 3                           | — (status-bar/ribbon тестується через Obsidian app instance) |
| 7     | 3                           | —                                                            |
| 8     | 3                           | R2.1 filesystem-browse research (R11)                        |
| 9b    | 3, **7**                    | — (scope-cut without 7: local-trash-only)                    |
| 10    | 3                           | — (desktop-only; mobile no-op)                               |
| 11    | усі попередні               | — (purely refactor)                                          |

#### R12.5. Out-of-scope for DIFF2 subproject

Items intentionally **not** in any DIFF2 phase. Listed here so вони не
re-discovered later і не silently picked up:

- **`syncConfigDir` toggle UX rework.** Existing Sync2 feature; out of
  diff2 scope.
- **Per-file sync exclusion** (R-numbered у old plans). Якщо user
  захоче "не sync-ити цей файл", це додаткова gitignore patterns
  feature, не diff2.
- **Cross-device conflict resolution merge** (e.g. "phone resolved
  half, laptop must continue"). Pseudo-merge mode currently keeps
  conflict per-device; truly distributed resolve is a sync-engine
  scope expansion, не diff2.
- **Auto-detect-mtime-based binary winner.** Explicitly rejected in
  PSEUDO-MERGE-MODE §7 (silent overwrite hostile); diff2 не
  переглядає це рішення.
- **Plugin-bundle merge tooling.** `isAtomicPluginFile` resolves
  these via semver; diff2 не вводить spec-purpose-built merge UI for
  bundles.

#### R12.6. Recommended next action

Виконати **R12.0 spikes (3 hours)** і записати результати у PR
description. Якщо обидва pass-or-known-fallback — починати Phase 0
scaffolding. Якщо widget-spike fail-ить і Playwright migration
вимагається — спершу окремий PR під infrastructure (Playwright setup +
один smoke test), і тільки потім Phase 0.
