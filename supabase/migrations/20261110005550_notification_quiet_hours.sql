create table public.notification_preferences (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  quiet_hours_enabled boolean not null default false,
  quiet_start time without time zone not null default '22:00',
  quiet_end time without time zone not null default '08:00',
  timezone text not null default 'America/Denver' check(length(timezone) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quiet_hours_distinct_times check(not quiet_hours_enabled or quiet_start<>quiet_end),
  constraint quiet_hours_minute_precision check(
    quiet_start<time '24:00' and quiet_end<time '24:00'
    and extract(second from quiet_start)=0 and extract(second from quiet_end)=0
  )
);
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from public,anon,authenticated;
grant select,insert,update on public.notification_preferences to authenticated;
grant all on public.notification_preferences to service_role;
create policy notification_preferences_select_own on public.notification_preferences
  for select to authenticated using ((select auth.uid())=owner_user_id);
create policy notification_preferences_insert_own on public.notification_preferences
  for insert to authenticated with check ((select auth.uid())=owner_user_id);
create policy notification_preferences_update_own on public.notification_preferences
  for update to authenticated using ((select auth.uid())=owner_user_id)
  with check ((select auth.uid())=owner_user_id);

create or replace function public.validate_notification_preferences()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then
    raise exception 'Choose a valid IANA time zone, such as America/Denver.' using errcode='22023';
  end if;
  new.updated_at:=now();
  return new;
end $$;
revoke all on function public.validate_notification_preferences() from public,anon,authenticated;
create trigger validate_notification_preferences_before_write
  before insert or update on public.notification_preferences
  for each row execute function public.validate_notification_preferences();
notify pgrst,'reload schema';
