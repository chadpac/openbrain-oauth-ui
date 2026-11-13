create table public.assistant_preferences (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  assistant_name text not null default 'Open Brain' check(length(trim(assistant_name)) between 1 and 40),
  tone text not null default 'warm' check(tone in ('warm','direct','neutral')),
  response_length text not null default 'balanced' check(response_length in ('concise','balanced','detailed')),
  planning_notes text not null default '' check(length(planning_notes)<=1500),
  working_hours_enabled boolean not null default false,
  work_start time without time zone not null default '09:00',
  work_end time without time zone not null default '17:00',
  working_days smallint[] not null default array[1,2,3,4,5]::smallint[],
  timezone text not null default 'America/Denver' check(length(timezone) between 1 and 80),
  use_saved_memories boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assistant_work_times check(not working_hours_enabled or work_start<>work_end),
  constraint assistant_work_precision check(work_start<time '24:00' and work_end<time '24:00' and extract(second from work_start)=0 and extract(second from work_end)=0),
  constraint assistant_work_days check(cardinality(working_days) between 1 and 7 and working_days<@array[1,2,3,4,5,6,7]::smallint[])
);
alter table public.assistant_preferences enable row level security;
revoke all on public.assistant_preferences from public,anon,authenticated;
grant select,insert,update on public.assistant_preferences to authenticated;
grant all on public.assistant_preferences to service_role;
create policy assistant_preferences_select_own on public.assistant_preferences for select to authenticated using ((select auth.uid())=owner_user_id);
create policy assistant_preferences_insert_own on public.assistant_preferences for insert to authenticated with check ((select auth.uid())=owner_user_id);
create policy assistant_preferences_update_own on public.assistant_preferences for update to authenticated using ((select auth.uid())=owner_user_id) with check ((select auth.uid())=owner_user_id);

create function public.validate_assistant_preferences()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  new.assistant_name:=trim(new.assistant_name);
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then
    raise exception 'Choose a valid IANA time zone.' using errcode='22023';
  end if;
  if (select count(distinct day) from unnest(new.working_days) day)<>cardinality(new.working_days) then
    raise exception 'Choose distinct working days.' using errcode='22023';
  end if;
  new.updated_at:=now();
  if tg_op='UPDATE' then new.created_at:=old.created_at;end if;
  return new;
end $$;
revoke all on function public.validate_assistant_preferences() from public,anon,authenticated;
create trigger validate_assistant_preferences_before_write before insert or update on public.assistant_preferences for each row execute function public.validate_assistant_preferences();

-- Invoker rights: both preferences and memory visibility always use the current
-- authenticated user's RLS. No user ID parameter and no elevated row access.
-- A content fingerprint detects edits/deletes, including shared-memory changes,
-- without privileged triggers writing into other household members' settings.
create function public.get_open_brain_assistant_preferences()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  current_owner uuid:=auth.uid();
  pref public.assistant_preferences;
  profile jsonb;
  memories_hash text;
  version text;
begin
  if current_owner is null then raise exception 'Authentication required.' using errcode='42501';end if;
  select * into pref from public.assistant_preferences where owner_user_id=current_owner;
  profile:=jsonb_build_object(
    'assistant_name',coalesce(pref.assistant_name,'Open Brain'),
    'tone',coalesce(pref.tone,'warm'),
    'response_length',coalesce(pref.response_length,'balanced'),
    'planning_notes',coalesce(pref.planning_notes,''),
    'working_hours_enabled',coalesce(pref.working_hours_enabled,false),
    'work_start',left(coalesce(pref.work_start,time '09:00')::text,5),
    'work_end',left(coalesce(pref.work_end,time '17:00')::text,5),
    'working_days',coalesce(pref.working_days,array[1,2,3,4,5]::smallint[]),
    'timezone',coalesce(pref.timezone,'America/Denver'),
    'use_saved_memories',coalesce(pref.use_saved_memories,true)
  );
  -- Fingerprint only: no memory content is returned, including when use is paused.
    select encode(sha256(convert_to(coalesce(string_agg(
      encode(sha256(convert_to(jsonb_build_array(t.id,t.content,t.metadata,t.visibility,t.created_by,t.household_id)::text,'UTF8')),'hex'),'' order by t.id
    ),''),'UTF8')),'hex') into memories_hash
    from public.thoughts t
    where t.archived_at is null and t.household_id in (select m.household_id from public.household_members m where m.user_id=current_owner);
  version:=encode(sha256(convert_to(profile::text||':'||memories_hash,'UTF8')),'hex');
  return jsonb_build_object('owner_user_id',current_owner,'profile',profile,'context_version',version);
end $$;
revoke all on function public.get_open_brain_assistant_preferences() from public,anon,authenticated;
grant execute on function public.get_open_brain_assistant_preferences() to authenticated;
notify pgrst,'reload schema';
