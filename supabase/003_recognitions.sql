-- Журнал распознаваний для дневного лимита на человека. Пишет и читает только облачная функция (service role).
create table if not exists public.recognitions (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  receipt_id text not null,
  ok boolean not null default false,
  tokens_in int,
  tokens_out int,
  created_at timestamptz not null default now()
);
create index if not exists recognitions_user_time on public.recognitions (user_id, created_at);
alter table public.recognitions enable row level security;
