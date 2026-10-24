-- Bodyscan schema
create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  result jsonb not null
);
create index if not exists scans_user_created on public.scans(user_id, created_at desc);
alter table public.scans enable row level security;
drop policy if exists "own scans read" on public.scans;
create policy "own scans read" on public.scans for select using (auth.uid() = user_id);
drop policy if exists "own scans delete" on public.scans;
create policy "own scans delete" on public.scans for delete using (auth.uid() = user_id);

create table if not exists public.subscriptions (
  email text primary key,
  plan text,
  checked_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
-- pas de policy : accès uniquement via la fonction serveur (service role)
