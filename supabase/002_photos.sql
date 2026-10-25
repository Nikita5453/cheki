-- Фото лежат в папке загрузившего: «<id пользователя>/<файл>».
-- Видят фото загрузивший и участники сборки, чей чек ссылается на это фото,
-- поэтому чек можно переносить между сборками, не перемещая файлы.

drop policy if exists photos_select on storage.objects;
drop policy if exists photos_insert on storage.objects;
drop policy if exists photos_delete on storage.objects;
drop function if exists public.photo_book(text);

create or replace function public.can_see_photo(path text) returns boolean
language sql security definer stable set search_path = public as $$
  select split_part(path, '/', 1) = auth.uid()::text
      or exists (select 1 from receipts r where path = any (r.photos) and public.is_member(r.book_id))
$$;

create policy photos_select on storage.objects for select
  using (bucket_id = 'photos' and public.can_see_photo(name));
create policy photos_insert on storage.objects for insert
  with check (bucket_id = 'photos' and split_part(name, '/', 1) = auth.uid()::text);
create policy photos_delete on storage.objects for delete
  using (bucket_id = 'photos' and public.can_see_photo(name));
