-- Server-only scheduling credentials. The secret value never leaves Vault.
do $$
begin
  if not exists(select 1 from vault.secrets where name='open_brain_scheduler_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'open_brain_scheduler_token','Open Brain scheduled reminders');
  end if;
end $$;

create or replace function public.authorize_open_brain_scheduler(p_token text)
returns boolean language sql stable security definer set search_path = '' as $$
  select length(p_token) between 32 and 128 and coalesce((
    select extensions.digest(p_token,'sha256')=extensions.digest(decrypted_secret,'sha256')
    from vault.decrypted_secrets where name='open_brain_scheduler_token' limit 1
  ),false);
$$;
revoke all on function public.authorize_open_brain_scheduler(text) from public,anon,authenticated;
grant execute on function public.authorize_open_brain_scheduler(text) to service_role;

create table public.reminder_delivery_claims (
  delivery_key text primary key check(length(delivery_key)<=200),
  lease_id uuid not null default gen_random_uuid(),
  leased_until timestamptz not null,
  retry_after timestamptz not null default now(),
  attempts integer not null default 1 check(attempts between 1 and 5),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
alter table public.reminder_delivery_claims enable row level security;
revoke all on public.reminder_delivery_claims from public,anon,authenticated;
grant all on public.reminder_delivery_claims to service_role;

create or replace function public.claim_open_brain_reminder(p_key text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v public.reminder_delivery_claims;
begin
  if p_key is null or length(p_key)>200 or p_key !~ '^(task|habit|event|health):' then
    raise exception 'Invalid reminder key';
  end if;
  insert into public.reminder_delivery_claims(delivery_key,leased_until)
  values(p_key,now()+interval '5 minutes')
  on conflict(delivery_key) do update set
    lease_id=gen_random_uuid(),leased_until=now()+interval '5 minutes',attempts=reminder_delivery_claims.attempts+1
  where reminder_delivery_claims.sent_at is null
    and reminder_delivery_claims.leased_until<=now()
    and reminder_delivery_claims.retry_after<=now()
    and reminder_delivery_claims.attempts<5
  returning * into v;
  if found then
    return jsonb_build_object('claimed',true,'sent',false,'lease_id',v.lease_id,'attempts',v.attempts);
  end if;
  select * into v from public.reminder_delivery_claims where delivery_key=p_key;
  return jsonb_build_object('claimed',false,'sent',v.sent_at is not null,'lease_id',null,'attempts',v.attempts,'sent_at',v.sent_at,'last_error',v.last_error);
end $$;

create or replace function public.finish_open_brain_reminder(p_key text,p_lease_id uuid,p_sent boolean,p_error text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.reminder_delivery_claims set
    sent_at=case when p_sent then now() else null end,
    last_error=left(p_error,500),leased_until=now(),
    retry_after=now()+make_interval(mins=>least(16,power(2,attempts-1)::integer))
  where delivery_key=p_key and lease_id=p_lease_id and sent_at is null;
  return found;
end $$;
revoke all on function public.claim_open_brain_reminder(text) from public,anon,authenticated;
revoke all on function public.finish_open_brain_reminder(text,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.claim_open_brain_reminder(text) to service_role;
grant execute on function public.finish_open_brain_reminder(text,uuid,boolean,text) to service_role;

-- Add the Vault-backed header before deploying authenticated workers. Existing
-- workers ignore the additional header, so this order preserves deliveries.
do $$
declare j record;
begin
  for j in select jobid,jobname from cron.job where jobname in
    ('send-telegram-reminders','send-event-notifications','send-habit-reminders','send-health-checkin-reminders')
  loop
    perform cron.alter_job(j.jobid,command:=format($job$
      select net.http_post(
        url:=%L,
        headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
          (select decrypted_secret from vault.decrypted_secrets where name='open_brain_scheduler_token' limit 1)),
        body:='{}'::jsonb,timeout_milliseconds:=10000
      );
    $job$,'https://prctfnpbftjepdckwpao.supabase.co/functions/v1/'||j.jobname));
  end loop;
end $$;
-- The resource row is locked before the token, so two device actions cannot
-- change the same task concurrently or deadlock while invalidating siblings.
create or replace function public.apply_open_brain_push_action(p_token uuid,p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.push_action_tokens;
  task public.family_tasks;
  habit public.habits;
  snoozed_until timestamptz;
  item_title text;
begin
  if p_action not in ('done','snooze30') or p_action is null then
    return jsonb_build_object('ok',false,'status',400,'error','Invalid action.');
  end if;
  select * into t from public.push_action_tokens where token=p_token;
  if not found then return jsonb_build_object('ok',false,'status',404,'error','Action token not found.'); end if;

  if t.resource_type='task' then
    select * into task from public.family_tasks where id=t.resource_id for update;
    if not found or task.household_id<>t.household_id or task.assigned_to_user_id is distinct from t.user_id then
      return jsonb_build_object('ok',false,'status',409,'error','Task no longer matches this notification.');
    end if;
    item_title:=task.title;
  elsif t.resource_type='habit' then
    select * into habit from public.habits where id=t.resource_id for update;
    if not found or habit.household_id<>t.household_id or habit.owner_user_id<>t.user_id then
      return jsonb_build_object('ok',false,'status',409,'error','Habit no longer matches this notification.');
    end if;
    if p_action<>'done' then return jsonb_build_object('ok',false,'status',400,'error','This action is not available for habits.'); end if;
    item_title:=habit.title;
  else
    return jsonb_build_object('ok',false,'status',400,'error','Invalid notification resource.');
  end if;

  select * into t from public.push_action_tokens where token=p_token for update;
  if t.used_at is not null then return jsonb_build_object('ok',false,'status',409,'error','This notification action was already used.'); end if;
  if t.expires_at<=now() then return jsonb_build_object('ok',false,'status',410,'error','This notification action expired.'); end if;
  if not exists(select 1 from public.household_members where household_id=t.household_id and user_id=t.user_id) then
    return jsonb_build_object('ok',false,'status',403,'error','Household membership is no longer active.');
  end if;

  if t.resource_type='task' then
    if task.status not in ('pending','in_progress') then
      return jsonb_build_object('ok',false,'status',409,'error','This reminder is no longer active.');
    end if;
    if p_action='done' then
      update public.family_tasks set status='completed',completed_at=now(),updated_at=now() where id=task.id;
    else
      snoozed_until:=now()+interval '30 minutes';
      update public.family_tasks set remind_at=snoozed_until,reminder_sent_at=null,reminder_error=null,updated_at=now() where id=task.id;
    end if;
    update public.push_action_tokens set used_at=now()
    where resource_type='task' and resource_id=task.id and used_at is null;
  else
    if habit.status<>'active' or t.resource_date is null then
      return jsonb_build_object('ok',false,'status',409,'error','This habit reminder is no longer active.');
    end if;
    insert into public.habit_completions(habit_id,household_id,owner_user_id,completed_on)
    values(habit.id,t.household_id,t.user_id,t.resource_date)
    on conflict(habit_id,completed_on) do nothing;
    update public.push_action_tokens set used_at=now() where token=p_token;
  end if;
  return jsonb_build_object('ok',true,'action',p_action,'resource_type',t.resource_type,
    'message',case when p_action='snooze30' then 'Snoozed for 30 minutes.' when t.resource_type='habit' then 'Habit marked done.' else 'Marked done.' end,
    'item_title',item_title,'snoozed_until',snoozed_until);
end $$;
revoke all on function public.apply_open_brain_push_action(uuid,text) from public,anon,authenticated;
grant execute on function public.apply_open_brain_push_action(uuid,text) to service_role;
CREATE OR REPLACE FUNCTION public.next_recurring_time(p_time timestamp with time zone, p_rule text, p_timezone text DEFAULT 'America/Denver'::text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  local_time TIMESTAMP;
  next_local TIMESTAMP;
  rule TEXT;
  amount INTEGER;
  dow INTEGER;
  allowed_days TEXT[];
  day_name TEXT;
BEGIN
  IF p_time IS NULL THEN
    RETURN NULL;
  END IF;

  local_time := p_time AT TIME ZONE p_timezone;
  rule := lower(trim(p_rule));

  -- Simple rules
  IF rule = 'daily' THEN
    next_local := local_time + INTERVAL '1 day';

  ELSIF rule = 'weekly' THEN
    next_local := local_time + INTERVAL '7 days';

  ELSIF rule = 'monthly' THEN
    next_local := local_time + INTERVAL '1 month';

  ELSIF rule = 'weekdays' THEN
    next_local := local_time + INTERVAL '1 day';

    dow := EXTRACT(DOW FROM next_local);

    IF dow = 6 THEN
      next_local := next_local + INTERVAL '2 days';
    ELSIF dow = 0 THEN
      next_local := next_local + INTERVAL '1 day';
    END IF;


  -- Flexible interval rules
  ELSIF rule ~ '^days:[0-9]+$' THEN
    amount := split_part(rule, ':', 2)::INTEGER;

    IF amount < 1 THEN
      RETURN NULL;
    END IF;

    next_local :=
      local_time + make_interval(days => amount);


  ELSIF rule ~ '^weeks:[0-9]+$' THEN
    amount := split_part(rule, ':', 2)::INTEGER;

    IF amount < 1 THEN
      RETURN NULL;
    END IF;

    next_local :=
      local_time + make_interval(days => amount * 7);


  ELSIF rule ~ '^months:[0-9]+$' THEN
    amount := split_part(rule, ':', 2)::INTEGER;

    IF amount < 1 THEN
      RETURN NULL;
    END IF;

    next_local :=
      local_time + make_interval(months => amount);


  -- Specific weekdays
  -- Example: weekdays:mon,wed,fri
  ELSIF rule ~ '^weekdays:' THEN

    allowed_days :=
      string_to_array(
        split_part(rule, ':', 2),
        ','
      );

    if coalesce(array_length(allowed_days,1),0)=0 or exists(
      select 1 from unnest(allowed_days) as d
      where d not in ('sun','mon','tue','wed','thu','fri','sat')
    ) then return null; end if;

    next_local := local_time;

    -- Look forward up to 7 days.
    FOR i IN 1..7 LOOP

      next_local :=
        local_time + make_interval(days => i);

      dow := EXTRACT(DOW FROM next_local);

      day_name :=
        CASE dow
          WHEN 0 THEN 'sun'
          WHEN 1 THEN 'mon'
          WHEN 2 THEN 'tue'
          WHEN 3 THEN 'wed'
          WHEN 4 THEN 'thu'
          WHEN 5 THEN 'fri'
          WHEN 6 THEN 'sat'
        END;

      IF day_name = ANY(allowed_days) THEN
        EXIT;
      END IF;

    END LOOP;

  ELSE
    RETURN NULL;
  END IF;

  RETURN next_local AT TIME ZONE p_timezone;
EXCEPTION WHEN numeric_value_out_of_range OR datetime_field_overflow THEN
  RETURN NULL;
END;
$function$
