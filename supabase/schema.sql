-- =====================================================================
--  TCP Immigration — Payment Links backend (Supabase)
--  Run this in Supabase: SQL Editor -> New query -> paste -> Run.
-- =====================================================================

-- ---------- Tables ----------

create table if not exists public.payment_links (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  title           text not null,
  -- Currency the CUSTOMER pays in (set in the admin dashboard, e.g. USD / NGN)
  source_currency text not null default 'USD',
  -- Currency the business accepts (fixed to CAD per spec)
  target_currency text not null default 'CAD',
  -- Optional FIXED rate set by the admin: how many SOURCE units equal 1 CAD.
  -- NULL = use the live market rate at the time the customer pays.
  rate_override   numeric,
  rate_markup_pct numeric,
  -- Which payment methods this link offers. Values: 'crypto', 'card', 'bank'.
  -- The customer picker only shows the methods listed here.
  methods         text[] not null default array['crypto','bank'],
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id)
);

-- Add the rate columns if this script is re-run on an existing project.
alter table public.payment_links add column if not exists rate_override numeric;
alter table public.payment_links add column if not exists rate_markup_pct numeric;

-- Add the methods column if this script is re-run on an existing project.
-- Existing links backfill to crypto + bank (card was added later).
alter table public.payment_links add column if not exists methods text[] not null default array['crypto','bank'];

create index if not exists payment_links_slug_idx on public.payment_links (slug);

create table if not exists public.bank_details (
  id              uuid primary key default gen_random_uuid(),
  link_id         uuid unique references public.payment_links (id) on delete cascade,
  bank_name       text not null,
  account_name    text not null,
  account_number  text not null,
  sort_code       text,
  swift_code      text,
  routing_number  text,
  bank_address    text,
  instructions    text,
  updated_at      timestamptz not null default now()
);

-- Global default bank account. Used on the public payment page for any link
-- that has no per-link bank_details row. A single row with id = 'default'.
create table if not exists public.default_bank_details (
  id              text primary key default 'default',
  bank_name       text not null,
  account_name    text not null,
  account_number  text not null,
  sort_code       text,
  swift_code      text,
  routing_number  text,
  bank_address    text,
  instructions    text,
  updated_at      timestamptz not null default now()
);

create table if not exists public.payments (
  id               uuid primary key default gen_random_uuid(),
  link_id          uuid references public.payment_links (id) on delete set null,
  customer_name    text not null,
  customer_email   text not null,
  customer_phone   text not null,
  customer_address text not null,
  amount_source    numeric not null,
  amount_target    numeric not null,
  source_currency  text not null,
  target_currency  text not null,
  fx_rate          numeric not null,
  status           text not null default 'submitted',
  receipt_url      text,
  created_at       timestamptz not null default now()
);

create index if not exists payments_link_id_idx on public.payments (link_id);

-- ---------- Storage bucket for receipts ----------
-- Public so the customer can upload from an unauthenticated browser and the
-- admin can later view the file. Object paths are randomised (not guessable).

insert into storage.buckets (id, name, public)
  values ('receipts', 'receipts', true)
  on conflict (id) do nothing;

-- ---------- Row Level Security ----------

alter table public.payment_links enable row level security;
alter table public.bank_details  enable row level security;
alter table public.payments      enable row level security;
alter table public.default_bank_details enable row level security;

-- Public (the customer) can read active payment links + their bank details.
drop policy if exists "public read active links" on public.payment_links;
create policy "public read active links" on public.payment_links
  for select using (active = true);

drop policy if exists "public read bank details for active links" on public.bank_details;
create policy "public read bank details for active links" on public.bank_details
  for select using (
    exists (
      select 1 from public.payment_links pl
      where pl.id = bank_details.link_id and pl.active = true
    )
  );

-- Anyone (anon) can read the default bank account (used when a link has no
-- specific bank_details row). The row's id is always 'default'.
drop policy if exists "public read default bank details" on public.default_bank_details;
create policy "public read default bank details" on public.default_bank_details
  for select using (true);

-- Public can submit a payment (the customer sending their order + receipt).
drop policy if exists "public insert payments" on public.payments;
create policy "public insert payments" on public.payments
  for insert with check (true);

-- Authenticated admin can do everything on all three tables.
drop policy if exists "admin full access links" on public.payment_links;
create policy "admin full access links" on public.payment_links
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "admin full access bank details" on public.bank_details;
create policy "admin full access bank details" on public.bank_details
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "admin full access default bank details" on public.default_bank_details;
create policy "admin full access default bank details" on public.default_bank_details
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "admin full access payments" on public.payments;
create policy "admin full access payments" on public.payments
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Receipt uploads: anyone can upload into the receipts bucket (paths are random).
drop policy if exists "public upload receipts" on storage.objects;
create policy "public upload receipts" on storage.objects
  for insert with check (bucket_id = 'receipts');

-- Allow admins to read any receipt.
drop policy if exists "public read receipts" on storage.objects;
create policy "public read receipts" on storage.objects
  for select using (bucket_id = 'receipts');

-- ---------- Crypto (Binance) payment ----------
create table if not exists public.crypto_details (
  id               uuid primary key default gen_random_uuid(),
  link_id          uuid unique references public.payment_links (id) on delete cascade,
  binance_id       text,
  trc20_address    text,
  bep20_address    text,
  instructions     text,
  updated_at       timestamptz not null default now()
);

-- Global default crypto (Binance) config. A single row with id = 'default'.
-- The business's main Binance account — set once, rarely changes.
create table if not exists public.default_crypto_details (
  id               text primary key default 'default',
  binance_id       text,
  trc20_address    text,
  bep20_address    text,
  instructions     text,
  updated_at       timestamptz not null default now()
);

alter table public.crypto_details enable row level security;
alter table public.default_crypto_details enable row level security;

-- Public can read a link's crypto details (only when the link is active).
drop policy if exists "public read crypto details for active links" on public.crypto_details;
create policy "public read crypto details for active links" on public.crypto_details
  for select using (
    exists (
      select 1 from public.payment_links pl
      where pl.id = crypto_details.link_id and pl.active = true
    )
  );

-- Anyone (anon) can read the default crypto config (row id is always 'default').
drop policy if exists "public read default crypto details" on public.default_crypto_details;
create policy "public read default crypto details" on public.default_crypto_details
  for select using (true);

drop policy if exists "admin full access crypto details" on public.crypto_details;
create policy "admin full access crypto details" on public.crypto_details
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "admin full access default crypto details" on public.default_crypto_details;
create policy "admin full access default crypto details" on public.default_crypto_details
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
