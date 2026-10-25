-- При создании сборки база сразу возвращает новую строку, а участие владельца добавляет триггер в том же запросе,
-- которого is_member() ещё не видит. Поэтому владелец видит свою сборку напрямую.
drop policy if exists books_select on public.books;
create policy books_select on public.books for select using (owner = auth.uid() or public.is_member(id));
