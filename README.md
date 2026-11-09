# Бюджет по чекам

Сборки чеков в гривнах: бюджет на месяц (или просто учёт расходов), разбивка по видам затрат и продуктов,
общие сборки с близкими по ссылке-приглашению и «кто сколько потратил».

Как устроено:

- **Сайт** (`index.html`, `style.css`, `app.js`, `sb.js`, `config.js`) — статический, на GitHub Pages: https://nikita5453.github.io/cheki/
- **Вход и данные** — Supabase: вход через Google, таблицы `books`, `book_members`, `invites`, `receipts`, `profiles`
  и приватное хранилище фото `photos`. Кто что видит, решают правила row level security (`supabase/schema.sql`, `supabase/002_photos.sql`).
  В `config.js` лежит только публичный ключ `anon`.
- **Распознавание** — `worker/process.py` на компьютере. Берёт чеки со статусом «ждёт распознавания» из всех сборок,
  отдаёт фото Claude Code CLI (`claude -p`, лимиты подписки Claude) и записывает позиции и категории обратно.
  Ключ `SUPABASE_SERVICE_KEY` лежит только в локальном `.env`. Запуск: `Распознавание чеков.bat`.

Служебное: `supabase/admin.py` (настройка проекта и деплой функций через Management API), `supabase/migrate.py` (разовый перенос старых данных из GitHub),
`supabase/rerecognize.ts` (разовое перераспознавание старых чеков для новых полей позиций, `node supabase/rerecognize.ts`).

Настройки скрипта через переменные окружения: `CHEKI_MODEL` (`sonnet` по умолчанию, `haiku` экономнее), `CHEKI_INTERVAL` (секунды между проверками, 30).
