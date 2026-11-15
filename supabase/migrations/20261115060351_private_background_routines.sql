create table public.background_routines (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 household_id uuid not null references public.households(id) on delete cascade,
 kind text not null check(kind in ('daily_deadlines','deadline_watch')),
 title text not null check(length(title) between 1 and 100),
 enabled boolean not null default false,
 version integer not null default 1,
 local_time time not null default '08:00' check(extract(second from local_time)=0 and local_time<time '24:00'),
 timezone text not null,
 horizon_days integer not null default 7 check(horizon_days in (1,3,7)),
 notify_push boolean not null default false,
 notify_telegram boolean not null default false,
 next_run_at timestamptz not null default now(),
 last_started_at timestamptz,
 baseline jsonb,
 updated_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 unique(owner_user_id,kind)
);
create index routines_household on public.background_routines(household_id);
create index routines_due on public.background_routines(next_run_at) where enabled;
create table public.background_routine_runs (
 id uuid primary key default gen_random_uuid(),
 routine_id uuid not null references public.background_routines(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 household_id uuid not null references public.households(id) on delete cascade,
 routine_version integer not null,
 scheduled_at timestamptz not null,
 status text not null default 'queued' check(status in ('queued','running','completed','failed','cancelled')),
 phase text not null default 'queued' check(phase in ('queued','checking','ready','finished')),
 attempts integer not null default 0 check(attempts between 0 and 3),
 available_at timestamptz not null default now(),
 lease_id uuid,
 lease_until timestamptz,
 result jsonb check(result is null or octet_length(result::text)<256000),
 error_code text,
 notification_state text not null default 'none',
 channels jsonb not null default '{"push":"off","telegram":"off"}',
 notification_reserved boolean not null default false,
 notification_reserved_day date,
 notification_lease uuid,
 notification_until timestamptz,
 notification_after timestamptz not null default now(),
 started_at timestamptz,
 completed_at timestamptz,
 created_at timestamptz not null default now(),
 unique(routine_id,routine_version,scheduled_at)
);
create index routine_runs_owner_page on public.background_routine_runs(owner_user_id,created_at desc,id desc);
create index routine_runs_routine on public.background_routine_runs(routine_id,created_at desc);
create index routine_runs_household on public.background_routine_runs(household_id);
create index routine_runs_retention on public.background_routine_runs(created_at);
create index routine_runs_queue on public.background_routine_runs(available_at) where status in ('queued','running');
create index routine_runs_claim on public.background_routine_runs(routine_id,routine_version,available_at,id) where status in ('queued','running');
create index routine_runs_notifications on public.background_routine_runs(notification_after) where notification_state in ('pending','deferred','sending');
create index routine_task_deadlines on public.family_tasks(household_id,assigned_to_user_id,due_at,id) include(visibility,created_by) where status in ('pending','in_progress') and due_at is not null;
create table public.background_routine_usage (
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 usage_day date not null,
 checks integer not null default 0 check(checks between 0 and 30),
 alerts integer not null default 0 check(alerts between 0 and 4),
 primary key(owner_user_id,usage_day)
);
alter table public.background_routines enable row level security;
alter table public.background_routine_runs enable row level security;
alter table public.background_routine_usage enable row level security;
revoke all on public.background_routines,public.background_routine_runs,public.background_routine_usage from public,anon,authenticated;
grant all on public.background_routines,public.background_routine_runs,public.background_routine_usage to service_role;
grant select on public.background_routines,public.background_routine_runs,public.background_routine_usage to authenticated;
create policy routine_owner_read on public.background_routines for select to authenticated using(owner_user_id=(select auth.uid()) and household_id in(select household_id from public.household_members where user_id=(select auth.uid())));
create policy routine_run_owner_read on public.background_routine_runs for select to authenticated using(owner_user_id=(select auth.uid()) and household_id in(select household_id from public.household_members where user_id=(select auth.uid())));
create policy routine_usage_owner_read on public.background_routine_usage for select to authenticated using(owner_user_id=(select auth.uid()));

create function public.next_background_routine_time(p_time time,p_zone text,p_after timestamptz)
returns timestamptz language plpgsql stable security invoker set search_path='' as $$
declare candidate timestamptz;
begin
 candidate:=((p_after at time zone p_zone)::date+p_time) at time zone p_zone;
 if candidate<=p_after then candidate:=((p_after at time zone p_zone)::date+1+p_time) at time zone p_zone; end if;
 return candidate;
end $$;

create function public.queue_background_routines()
returns integer language plpgsql security invoker set search_path='' as $$
declare r public.background_routines; total integer:=0;
begin
 delete from public.background_routine_runs where id in(select id from public.background_routine_runs where created_at<now()-interval '30 days' and status in ('completed','failed','cancelled') and notification_state not in ('pending','deferred','sending') order by created_at limit 500);
 delete from public.background_routine_usage where usage_day<(now() at time zone 'UTC')::date-35;
 -- Cancel work whose owner left the household. No source content is read.
 update public.background_routine_runs j set status=case when j.status in ('queued','running') then 'cancelled' else j.status end,notification_state='cancelled'
 where (j.status in ('queued','running') or j.notification_state in ('pending','deferred','sending')) and not exists(select 1 from public.household_members m where m.user_id=j.owner_user_id and m.household_id=j.household_id);
 for r in select b.* from public.background_routines b where b.enabled and b.next_run_at<=now() and exists(select 1 from public.household_members m where m.user_id=b.owner_user_id and m.household_id=b.household_id) order by b.next_run_at,b.id limit 20 for update skip locked loop
  if not exists(select 1 from public.background_routine_runs where routine_id=r.id and routine_version=r.version and status in ('queued','running')) then
   insert into public.background_routine_runs(routine_id,owner_user_id,household_id,routine_version,scheduled_at) values(r.id,r.owner_user_id,r.household_id,r.version,r.next_run_at) on conflict do nothing;
   total:=total+1;
  end if;
  update public.background_routines set next_run_at=case when r.kind='deadline_watch' then now()+interval '1 hour' else public.next_background_routine_time(r.local_time,r.timezone,now()) end where id=r.id;
 end loop;
 return total;
end $$;

create function public.claim_background_routine()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.background_routine_runs; r public.background_routines; used integer; today date:=(now() at time zone 'UTC')::date;
begin
 for r in select b.* from public.background_routines b where b.enabled and exists(select 1 from public.background_routine_runs q where q.routine_id=b.id and q.routine_version=b.version and q.status in ('queued','running') and q.available_at<=now() and (q.lease_until is null or q.lease_until<=now())) order by b.next_run_at,b.id limit 20 for update of b skip locked loop
  select * into j from public.background_routine_runs q where q.routine_id=r.id and q.routine_version=r.version and q.status in ('queued','running') and q.available_at<=now() and (q.lease_until is null or q.lease_until<=now()) order by q.available_at,q.id limit 1 for update skip locked;
  if not found then continue;end if;
  if not exists(select 1 from public.household_members where user_id=j.owner_user_id and household_id=j.household_id) then update public.background_routine_runs set status='cancelled',phase='finished' where id=j.id;continue;end if;
  if j.attempts>=3 then update public.background_routine_runs set status='failed',phase='finished',error_code='retry_limit' where id=j.id;continue;end if;
  perform pg_advisory_xact_lock(hashtextextended(j.owner_user_id::text,4));
  insert into public.background_routine_usage(owner_user_id,usage_day) values(j.owner_user_id,today) on conflict do nothing;
  update public.background_routine_usage set checks=checks+1 where owner_user_id=j.owner_user_id and usage_day=today and checks<30 returning checks into used;
  if not found then update public.background_routine_runs set available_at=((today+1)::timestamp at time zone 'UTC'),error_code='daily_check_limit' where id=j.id;continue;end if;
  update public.background_routine_runs set status='running',phase='checking',attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=now()+interval '2 minutes',started_at=coalesce(started_at,now()),error_code=null where id=j.id returning * into j;
  update public.background_routines set last_started_at=now() where id=r.id;
  return to_jsonb(j);
 end loop;
 return null;
end $$;

create function public.check_background_routine(p_id uuid,p_lease uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.background_routine_runs; r public.background_routines; tasks jsonb; snapshot jsonb; previous jsonb; report jsonb; changed integer; added integer; removed integer; became_overdue integer; overdue integer; upcoming integer; should_notify boolean;
begin
 select b.* into r from public.background_routines b join public.background_routine_runs q on q.routine_id=b.id where q.id=p_id for update of b;
 select * into j from public.background_routine_runs where id=p_id for update;
 if j.id is null or j.status<>'running' or j.lease_id is distinct from p_lease or j.lease_until<=now() or not r.enabled or r.version<>j.routine_version or not exists(select 1 from public.household_members where user_id=j.owner_user_id and household_id=j.household_id) then raise exception 'Routine changed or lease expired';end if;
 -- This server-only scan deliberately mirrors family_tasks SELECT RLS, then
 -- narrows it to the owner as assignee. No descriptions or Health tables.
 select coalesce(jsonb_agg(to_jsonb(t) order by t.due_at,t.id),'[]') into tasks from (
  select id,left(title,180) as title,due_at,case when due_at<now() then 'overdue' else 'upcoming' end as bucket
  from public.family_tasks where household_id=j.household_id and assigned_to_user_id=j.owner_user_id and (visibility='household' or visibility='private' and created_by=j.owner_user_id)
  and status in ('pending','in_progress') and due_at>=now()-interval '30 days' and due_at<=now()+make_interval(days=>r.horizon_days)
  order by due_at,id limit 201
 ) t;
 if jsonb_array_length(tasks)>200 then raise exception 'Too many deadlines. Narrow the routine window';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','due_at',x->>'due_at','bucket',x->>'bucket') order by x->>'id'),'[]') into snapshot from jsonb_array_elements(tasks) x;
 previous:=coalesce(r.baseline,'[]');
 select count(*) into added from jsonb_array_elements(snapshot) x where not exists(select 1 from jsonb_array_elements(previous) p where p->>'id'=x->>'id');
 select count(*) into removed from jsonb_array_elements(previous) p where not exists(select 1 from jsonb_array_elements(snapshot) x where x->>'id'=p->>'id');
 select count(*) into changed from jsonb_array_elements(snapshot) x join jsonb_array_elements(previous) p on p->>'id'=x->>'id' where p->>'due_at' is distinct from x->>'due_at';
 select count(*) into became_overdue from jsonb_array_elements(snapshot) x join jsonb_array_elements(previous) p on p->>'id'=x->>'id' where x->>'bucket'='overdue' and p->>'bucket'<>'overdue';
 select count(*) filter(where x->>'bucket'='overdue'),count(*) filter(where x->>'bucket'='upcoming') into overdue,upcoming from jsonb_array_elements(snapshot) x;
 should_notify:=case when r.kind='daily_deadlines' then jsonb_array_length(tasks)>0 else r.baseline is not null and added+removed+changed+became_overdue>0 end;
 report:=jsonb_build_object('kind',r.kind,'title',r.title,'timezone',r.timezone,'checked_at',now(),'horizon_days',r.horizon_days,'overdue',overdue,'upcoming',upcoming,'added',added,'removed',removed,'changed',changed,'became_overdue',became_overdue,'baseline',r.baseline is null,'tasks',tasks,'ai_calls',0);
 update public.background_routines set baseline=snapshot where id=r.id and version=r.version and enabled;
 -- New results supersede deferred alerts instead of replaying stale digests.
 update public.background_routine_runs set notification_state='superseded' where routine_id=r.id and id<>j.id and notification_state in ('pending','deferred');
 update public.background_routine_runs set status='completed',phase='finished',result=report,completed_at=now(),lease_id=null,lease_until=null,
 notification_state=case when not should_notify then 'no_change' when not r.notify_push and not r.notify_telegram then 'in_app' else 'pending' end,
 channels=jsonb_build_object('push',case when should_notify and r.notify_push then 'pending' else 'off' end,'telegram',case when should_notify and r.notify_telegram then 'pending' else 'off' end)
 where id=j.id returning * into j;
 return to_jsonb(j);
end $$;

create function public.fail_background_routine(p_id uuid,p_lease uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.background_routine_runs set status=case when attempts>=3 then 'failed' else 'queued' end,phase=case when attempts>=3 then 'finished' else 'queued' end,error_code='check_failed',available_at=now()+make_interval(mins=>power(2,attempts-1)::integer),lease_id=null,lease_until=null where id=p_id and status='running' and lease_id=p_lease;
 return found;
end $$;

create function public.background_routine_is_quiet(p_owner uuid)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare p public.notification_preferences; clock time;
begin
 select * into p from public.notification_preferences where owner_user_id=p_owner;
 if not found or not p.quiet_hours_enabled then return false;end if;
 if not exists(select 1 from pg_catalog.pg_timezone_names where name=p.timezone) or p.quiet_start=p.quiet_end then return true;end if;
 clock:=(now() at time zone p.timezone)::time;
 return case when p.quiet_start<p.quiet_end then clock>=p.quiet_start and clock<p.quiet_end else clock>=p.quiet_start or clock<p.quiet_end end;
end $$;

create function public.claim_background_routine_notification()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.background_routine_runs; r public.background_routines; today date:=(now() at time zone 'UTC')::date; used integer;
begin
 -- A worker that died after dispatch left a durable per-channel stamp. Never
 -- replay that channel: its receipt is unknown. Other unstarted channels resume.
 update public.background_routine_runs set channels=jsonb_build_object('push',case when channels->>'push'='sending' then 'unknown' else channels->>'push' end,'telegram',case when channels->>'telegram'='sending' then 'unknown' else channels->>'telegram' end),notification_state='pending',notification_lease=null
 where notification_state='sending' and notification_until<=now();
 update public.background_routine_runs set notification_state='expired' where notification_state in ('pending','deferred') and completed_at<now()-interval '24 hours';
 for j in select q.* from public.background_routine_runs q join public.background_routines b on b.id=q.routine_id where q.status='completed' and q.notification_state in ('pending','deferred') and q.notification_after<=now() and b.enabled and b.version=q.routine_version order by q.created_at desc limit 20 for update of q skip locked loop
  if not exists(select 1 from public.household_members where user_id=j.owner_user_id and household_id=j.household_id) then update public.background_routine_runs set notification_state='cancelled' where id=j.id;continue;end if;
  if j.channels->>'push'<>'pending' and j.channels->>'telegram'<>'pending' then update public.background_routine_runs set notification_state=case when channels->>'push'='accepted' or channels->>'telegram'='accepted' then 'partial' else 'unknown' end where id=j.id;continue;end if;
  if public.background_routine_is_quiet(j.owner_user_id) then update public.background_routine_runs set notification_state='deferred',notification_after=now()+interval '5 minutes' where id=j.id;continue;end if;
  perform pg_advisory_xact_lock(hashtextextended(j.owner_user_id::text,4));
  if not j.notification_reserved or j.notification_reserved_day is distinct from today then
   insert into public.background_routine_usage(owner_user_id,usage_day) values(j.owner_user_id,today) on conflict do nothing;
   update public.background_routine_usage set alerts=alerts+1 where owner_user_id=j.owner_user_id and usage_day=today and alerts<4 returning alerts into used;
   if not found then update public.background_routine_runs set notification_state='daily_limit' where id=j.id;continue;end if;
  end if;
  update public.background_routine_runs set notification_state='sending',notification_reserved=true,notification_reserved_day=today,notification_lease=gen_random_uuid(),notification_until=now()+interval '3 minutes' where id=j.id returning * into j;
  select * into r from public.background_routines where id=j.routine_id;
  return to_jsonb(j)||jsonb_build_object('routine_title',r.title);
 end loop;
 return null;
end $$;

create function public.background_routine_notification_allowed(p_id uuid,p_lease uuid)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.background_routine_runs j join public.background_routines r on r.id=j.routine_id
 where j.id=p_id and j.notification_lease=p_lease and j.notification_state='sending' and j.notification_reserved_day=(now() at time zone 'UTC')::date and j.notification_until>now() and j.completed_at>now()-interval '24 hours' and r.enabled and r.version=j.routine_version
 and exists(select 1 from public.household_members m where m.user_id=j.owner_user_id and m.household_id=j.household_id)
 and not public.background_routine_is_quiet(j.owner_user_id));
$$;

create function public.background_routine_channel(p_id uuid,p_lease uuid,p_channel text,p_state text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare j public.background_routine_runs;
begin
 if p_channel not in ('push','telegram') or p_state not in ('sending','accepted','failed','unknown','pending','off') then raise exception 'Invalid notification state';end if;
 select * into j from public.background_routine_runs where id=p_id and notification_lease=p_lease and notification_state='sending' and notification_until>now() for update;
 if not found then return false;end if;
 if p_state='sending' and (j.channels->>p_channel<>'pending' or not public.background_routine_notification_allowed(p_id,p_lease)) then return false;end if;
 if p_state<>'sending' and j.channels->>p_channel<>'sending' then return false;end if;
 update public.background_routine_runs set channels=jsonb_set(channels,array[p_channel],to_jsonb(p_state)) where id=p_id;
 return true;
end $$;

create function public.finish_background_routine_notification(p_id uuid,p_lease uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.background_routine_runs set notification_state=case when channels->>'push'='pending' or channels->>'telegram'='pending' then 'deferred' when channels->>'push'='unknown' or channels->>'telegram'='unknown' then 'unknown' when (channels->>'push'='accepted' and channels->>'telegram' in ('accepted','off')) or (channels->>'telegram'='accepted' and channels->>'push'='off') then 'accepted' when channels->>'push'='accepted' or channels->>'telegram'='accepted' then 'partial' when channels->>'push'='off' and channels->>'telegram'='off' then 'no_channel' else 'failed' end,
 notification_after=now()+interval '5 minutes',notification_lease=null,notification_until=null
 where id=p_id and notification_lease=p_lease and notification_state='sending' and channels->>'push'<>'sending' and channels->>'telegram'<>'sending';
 return found;
end $$;

create function public.control_background_routine(p_owner uuid,p_household uuid,p_command text,p_id uuid default null,p_version integer default null,p_config jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.background_routines; zone text; routine_kind text; clock time;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,3));
 if not exists(select 1 from public.household_members where user_id=p_owner and household_id=p_household) then raise exception 'Household membership required'; end if;
 if p_command='save' then
  routine_kind:=p_config->>'kind';
  if coalesce(routine_kind,'') not in ('daily_deadlines','deadline_watch') or length(trim(coalesce(p_config->>'title',''))) not between 1 and 100 or coalesce(p_config->>'horizon_days','') not in ('1','3','7') or coalesce(p_config->>'local_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or jsonb_typeof(p_config->'enabled') is distinct from 'boolean' or jsonb_typeof(p_config->'notify_push') is distinct from 'boolean' or jsonb_typeof(p_config->'notify_telegram') is distinct from 'boolean' then raise exception 'Check the routine settings'; end if;
  select timezone into zone from public.households where id=p_household;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=zone) then raise exception 'Household timezone is unavailable'; end if;
  clock:=(p_config->>'local_time')::time;
  select * into r from public.background_routines where owner_user_id=p_owner and background_routines.kind=p_config->>'kind' for update;
  -- A stored version prevents one device from overwriting another device's changes.
  if found and r.household_id=p_household and (p_id is distinct from r.id or p_version is distinct from r.version) then raise exception 'Routine changed. Refresh before saving'; end if;
  if r.id is null and p_id is not null then raise exception 'Routine not found'; end if;
  insert into public.background_routines(owner_user_id,household_id,kind,title,enabled,local_time,timezone,horizon_days,notify_push,notify_telegram,next_run_at)
  values(p_owner,p_household,routine_kind,trim(p_config->>'title'),(p_config->>'enabled')::boolean,clock,zone,(p_config->>'horizon_days')::integer,(p_config->>'notify_push')::boolean,(p_config->>'notify_telegram')::boolean,case when routine_kind='deadline_watch' then now() else public.next_background_routine_time(clock,zone,now()) end)
  on conflict(owner_user_id,kind) do update set household_id=excluded.household_id,title=excluded.title,enabled=excluded.enabled,local_time=excluded.local_time,timezone=excluded.timezone,horizon_days=excluded.horizon_days,notify_push=excluded.notify_push,notify_telegram=excluded.notify_telegram,next_run_at=excluded.next_run_at,version=background_routines.version+1,baseline=null,updated_at=now() returning * into r;
 elsif p_command in ('pause','resume','run_now','delete') then
  select * into r from public.background_routines where id=p_id and owner_user_id=p_owner and household_id=p_household for update;
  if not found then raise exception 'Routine not found'; end if;
  if r.version is distinct from p_version then raise exception 'Routine changed. Refresh first'; end if;
  if p_command='delete' then delete from public.background_routines where id=r.id;return jsonb_build_object('deleted',true);end if;
  if p_command='run_now' then
   if not r.enabled then raise exception 'Resume the routine before running it'; end if;
   if exists(select 1 from public.background_routine_runs where routine_id=r.id and routine_version=r.version and status in ('queued','running')) or r.next_run_at<=now() then return to_jsonb(r); end if;
   if r.last_started_at>now()-interval '5 minutes' then raise exception 'Wait five minutes between manual checks'; end if;
   update public.background_routines set next_run_at=now(),updated_at=now() where id=r.id returning * into r;
   return to_jsonb(r);
  end if;
  update public.background_routines set enabled=p_command='resume',version=version+1,baseline=null,next_run_at=now(),updated_at=now() where id=r.id returning * into r;
 else raise exception 'Unknown routine command'; end if;
 update public.background_routine_runs set status=case when status in ('queued','running') then 'cancelled' else status end,phase='finished',notification_state='cancelled',lease_id=null,notification_lease=null where routine_id=r.id and routine_version<>r.version and (status in ('queued','running') or notification_state in ('pending','deferred','sending'));
 return to_jsonb(r);
end $$;

-- This narrowly scoped private definer is necessary because ordinary task
-- writers have no rights on service-managed routine queues. It queues only
-- opted-in assignees; hourly watch checks also recover missed wake-ups.
create function private.wake_deadline_routines()
returns trigger language plpgsql security definer set search_path='' as $$
declare old_owner uuid; new_owner uuid; old_home uuid; new_home uuid;
begin
 if tg_op<>'INSERT' then old_owner:=old.assigned_to_user_id;old_home:=old.household_id;end if;
 if tg_op<>'DELETE' then new_owner:=new.assigned_to_user_id;new_home:=new.household_id;end if;
 if auth.uid() is not null and not exists(select 1 from public.household_members where user_id=auth.uid() and household_id in(old_home,new_home)) then return null;end if;
 if auth.uid() is null and coalesce(current_setting('role',true),'none') not in ('postgres','service_role','none') then return null;end if;
 update public.background_routines set next_run_at=least(next_run_at,greatest(now()+interval '1 minute',coalesce(last_started_at,'-infinity')+interval '15 minutes'))
 where enabled and kind='deadline_watch' and owner_user_id in(old_owner,new_owner) and household_id in(old_home,new_home);
 return null;
exception when others then
 -- A wake-up failure must not break saving a task. The hourly sweep remains.
 raise warning 'Background deadline wake-up unavailable';return null;
end $$;
revoke all on function private.wake_deadline_routines() from public,anon,authenticated;
create trigger wake_deadline_routines after insert or delete or update of due_at,status,assigned_to_user_id,visibility,household_id,created_by on public.family_tasks for each row execute function private.wake_deadline_routines();

do $$
declare f record;
begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('next_background_routine_time','control_background_routine','queue_background_routines','claim_background_routine','check_background_routine','fail_background_routine','background_routine_is_quiet','claim_background_routine_notification','background_routine_notification_allowed','background_routine_channel','finish_background_routine_notification') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

-- Disabled until the worker deployment is verified. Enabling the new job is a
-- separate release step; the four existing reminder jobs are left untouched.
do $$
declare job bigint;
begin
 job:=cron.schedule('run-background-routines','* * * * *',$job$
  select net.http_post(
   url:='https://prctfnpbftjepdckwpao.supabase.co/functions/v1/run-background-routines',
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='open_brain_scheduler_token' limit 1)),
   body:='{}'::jsonb,timeout_milliseconds:=55000)
  where exists(select 1 from public.background_routines r where r.enabled and exists(select 1 from public.household_members m where m.user_id=r.owner_user_id and m.household_id=r.household_id))
    or exists(select 1 from public.background_routine_runs where created_at<now()-interval '30 days')
    or exists(select 1 from public.background_routine_usage where usage_day<(now() at time zone 'UTC')::date-35);
 $job$);
 perform cron.alter_job(job,active:=false);
end $$;
