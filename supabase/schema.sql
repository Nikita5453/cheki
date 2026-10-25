-- «Бюджет по чекам»: сборки чеков, участники, приглашения, чеки и фото.
-- Доступ к данным даёт только участие в сборке (row level security).

create extension if not exists pgcrypto;

-- Профиль пользователя, заполняется из Google при первом входе.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  name text,
  avatar text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, avatar)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Сборка чеков. monthly_budget = null: только учёт расходов, без лимита.
create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  monthly_budget numeric check (monthly_budget is null or monthly_budget > 0),
  start_date date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists public.book_members (
  book_id uuid not null references public.books on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (book_id, user_id)
);

create table if not exists public.invites (
  token text primary key default encode(gen_random_bytes(12), 'hex'),
  book_id uuid not null references public.books on delete cascade,
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.receipts (
  id text primary key,
  book_id uuid not null references public.books on delete cascade,
  author uuid default auth.uid() references auth.users on delete set null,
  status text not null default 'done' check (status in ('pending', 'done', 'error')),
  date date,
  store text not null default '',
  total numeric not null default 0,
  items jsonb not null default '[]',
  photos text[] not null default '{}',
  manual boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists receipts_book_date on public.receipts (book_id, date);
create index if not exists receipts_pending on public.receipts (status) where status = 'pending';

-- Проверки участия; security definer, чтобы правила не зацикливались на book_members.
create or replace function public.is_member(b uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from book_members where book_id = b and user_id = auth.uid())
$$;

create or replace function public.is_owner(b uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from book_members where book_id = b and user_id = auth.uid() and role = 'owner')
$$;

-- Создатель сборки сразу становится её владельцем.
create or replace function public.add_book_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into book_members (book_id, user_id, role) values (new.id, new.owner, 'owner')
  on conflict (book_id, user_id) do update set role = 'owner';
  return new;
end $$;

drop trigger if exists on_book_created on public.books;
create trigger on_book_created after insert on public.books
  for each row execute function public.add_book_owner();

-- Вступление по ссылке-приглашению. Возвращает id и название сборки.
create or replace function public.join_book(invite text) returns table (book_id uuid, name text)
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select i.book_id into b from invites i where i.token = invite;
  if b is null then raise exception 'invite not found'; end if;
  insert into book_members (book_id, user_id) values (b, auth.uid()) on conflict do nothing;
  return query select books.id, books.name from books where books.id = b;
end $$;

alter table public.profiles enable row level security;
alter table public.books enable row level security;
alter table public.book_members enable row level security;
alter table public.invites enable row level security;
alter table public.receipts enable row level security;

-- Профили видны себе и тем, с кем есть общая сборка.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (
  id = auth.uid() or exists (
    select 1 from book_members a join book_members b on a.book_id = b.book_id
    where a.user_id = auth.uid() and b.user_id = profiles.id)
);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (id = auth.uid());

drop policy if exists books_select on public.books;
create policy books_select on public.books for select using (public.is_member(id));
drop policy if exists books_insert on public.books;
create policy books_insert on public.books for insert with check (owner = auth.uid());
drop policy if exists books_update on public.books;
create policy books_update on public.books for update using (public.is_owner(id));
drop policy if exists books_delete on public.books;
create policy books_delete on public.books for delete using (public.is_owner(id));

drop policy if exists members_select on public.book_members;
create policy members_select on public.book_members for select using (public.is_member(book_id));
-- Выйти из сборки сам может любой, удалить другого участника — только владелец.
drop policy if exists members_delete on public.book_members;
create policy members_delete on public.book_members for delete using (
  (user_id = auth.uid() and role <> 'owner') or (public.is_owner(book_id) and user_id <> auth.uid())
);

drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select using (public.is_member(book_id));
drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert with check (public.is_member(book_id) and created_by = auth.uid());
drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites for delete using (public.is_owner(book_id) or created_by = auth.uid());

-- Чеки видят все участники; добавлять может любой участник от своего имени;
-- менять и удалять — автор или владелец сборки.
drop policy if exists receipts_select on public.receipts;
create policy receipts_select on public.receipts for select using (public.is_member(book_id));
drop policy if exists receipts_insert on public.receipts;
create policy receipts_insert on public.receipts for insert with check (public.is_member(book_id) and author = auth.uid());
drop policy if exists receipts_update on public.receipts;
create policy receipts_update on public.receipts for update
  using (public.is_member(book_id) and (author = auth.uid() or public.is_owner(book_id)))
  with check (public.is_member(book_id));
drop policy if exists receipts_delete on public.receipts;
create policy receipts_delete on public.receipts for delete
  using (public.is_member(book_id) and (author = auth.uid() or public.is_owner(book_id)));

-- Фото: приватное хранилище, путь «<id сборки>/<файл>», доступ участникам сборки.
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
on conflict (id) do nothing;

create or replace function public.photo_book(path text) returns uuid
language plpgsql immutable as $$
begin
  return split_part(path, '/', 1)::uuid;
exception when others then
  return null;
end $$;

drop policy if exists photos_select on storage.objects;
create policy photos_select on storage.objects for select
  using (bucket_id = 'photos' and public.is_member(public.photo_book(name)));
drop policy if exists photos_insert on storage.objects;
create policy photos_insert on storage.objects for insert
  with check (bucket_id = 'photos' and public.is_member(public.photo_book(name)));
drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects for delete
  using (bucket_id = 'photos' and public.is_member(public.photo_book(name)));
