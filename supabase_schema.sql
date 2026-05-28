-- EM 환경 모니터링 관리 시스템 - Supabase 스키마
-- Supabase SQL Editor에서 실행하세요.

-- 교정 장비 테이블
create table if not exists public.calibration (
  id uuid default gen_random_uuid() primary key,
  no text not null,
  sn text,
  cert_no text,
  calib_date date,
  next_calib_date text,
  name text,
  note text,
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 모니터링 구역 테이블
create table if not exists public.monitoring_zones (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  grade text not null,
  category text default '공조',
  sort_order int default 0,
  created_at timestamptz default now()
);

-- 월별 모니터링 데이터 테이블
create table if not exists public.monitoring_data (
  id uuid default gen_random_uuid() primary key,
  zone_id uuid references public.monitoring_zones(id) on delete cascade,
  year int not null,
  month int not null,
  airborne text,
  settle text,
  surface text,
  particle text,
  count int default 0,
  note text,
  start_date date,
  done boolean default false,
  updated_at timestamptz default now(),
  unique(zone_id, year, month)
);

-- 연간 계획 (AHU) 테이블
create table if not exists public.annual_plan (
  id uuid default gen_random_uuid() primary key,
  ahu_name text not null,
  year int not null,
  month int not null,
  planned boolean default false,
  done boolean default false,
  note text,
  updated_at timestamptz default now(),
  unique(ahu_name, year, month)
);

-- RLS (Row Level Security) 활성화 - 로그인한 사용자만 접근
alter table public.calibration enable row level security;
alter table public.monitoring_zones enable row level security;
alter table public.monitoring_data enable row level security;
alter table public.annual_plan enable row level security;

-- 인증된 사용자 전체 접근 허용 정책
create policy "authenticated users can read calibration"
  on public.calibration for select to authenticated using (true);
create policy "authenticated users can insert calibration"
  on public.calibration for insert to authenticated with check (true);
create policy "authenticated users can update calibration"
  on public.calibration for update to authenticated using (true);
create policy "authenticated users can delete calibration"
  on public.calibration for delete to authenticated using (true);

create policy "authenticated users can read zones"
  on public.monitoring_zones for select to authenticated using (true);
create policy "authenticated users can insert zones"
  on public.monitoring_zones for insert to authenticated with check (true);
create policy "authenticated users can update zones"
  on public.monitoring_zones for update to authenticated using (true);
create policy "authenticated users can delete zones"
  on public.monitoring_zones for delete to authenticated using (true);

create policy "authenticated users can read monitoring_data"
  on public.monitoring_data for select to authenticated using (true);
create policy "authenticated users can insert monitoring_data"
  on public.monitoring_data for insert to authenticated with check (true);
create policy "authenticated users can update monitoring_data"
  on public.monitoring_data for update to authenticated using (true);
create policy "authenticated users can delete monitoring_data"
  on public.monitoring_data for delete to authenticated using (true);

create policy "authenticated users can read annual_plan"
  on public.annual_plan for select to authenticated using (true);
create policy "authenticated users can insert annual_plan"
  on public.annual_plan for insert to authenticated with check (true);
create policy "authenticated users can update annual_plan"
  on public.annual_plan for update to authenticated using (true);
create policy "authenticated users can delete annual_plan"
  on public.annual_plan for delete to authenticated using (true);

-- updated_at 자동 갱신 함수
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger handle_calibration_updated_at
  before update on public.calibration
  for each row execute function public.handle_updated_at();

create trigger handle_monitoring_data_updated_at
  before update on public.monitoring_data
  for each row execute function public.handle_updated_at();

create trigger handle_annual_plan_updated_at
  before update on public.annual_plan
  for each row execute function public.handle_updated_at();
