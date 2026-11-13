-- Private activity history; lifecycle and proposal text are written only by the server.
create table public.assistant_activity (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  kind text not null check(kind in ('question','today','week','calendar')),
  status text not null default 'queued' check(status in ('queued','running','waiting','paused','completed','failed','cancelled')),
  version integer not null default 1,
  context_version text not null check(context_version ~ '^[a-f0-9]{64}$'),
  actions jsonb not null default '[]' check(jsonb_typeof(actions)='array' and jsonb_array_length(actions)<=12 and octet_length(actions::text)<=100000),
  sources jsonb not null default '[]' check(jsonb_typeof(sources)='array' and jsonb_array_length(sources)<=20),
  error_code text check(error_code in ('unavailable','context_changed','interrupted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '30 minutes'
);
create index assistant_activity_owner_page on public.assistant_activity(owner_user_id,created_at desc,id desc);
create index assistant_activity_household on public.assistant_activity(household_id);
alter table public.assistant_activity enable row level security;
revoke all on public.assistant_activity from public,anon,authenticated;
grant select on public.assistant_activity to authenticated;
grant all on public.assistant_activity to service_role;
create policy assistant_activity_owner_read on public.assistant_activity for select to authenticated using(owner_user_id=(select auth.uid()));

create table public.assistant_activity_receipts (
  run_id uuid not null references public.assistant_activity(id) on delete cascade,
  action_index integer not null check(action_index between 0 and 11),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  decision text not null check(decision in ('saved','dismissed')),
  result_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key(run_id,action_index)
);
create index assistant_receipts_owner on public.assistant_activity_receipts(owner_user_id);
alter table public.assistant_activity_receipts enable row level security;
revoke all on public.assistant_activity_receipts from public,anon,authenticated;
grant select,insert on public.assistant_activity_receipts to authenticated;
grant all on public.assistant_activity_receipts to service_role;
create policy assistant_receipt_read on public.assistant_activity_receipts for select to authenticated using(owner_user_id=(select auth.uid()));
create policy assistant_receipt_insert on public.assistant_activity_receipts for insert to authenticated with check(
  owner_user_id=(select auth.uid()) and exists(select 1 from public.assistant_activity a where a.id=run_id and a.owner_user_id=(select auth.uid()) and a.status='waiting' and a.expires_at>now() and action_index<jsonb_array_length(a.actions))
);

-- All control/finish/approval operations take the same transaction lock. A late
-- model response cannot undo pause/cancel. Service role never saves app records.
create function public.control_open_brain_activity(p_owner uuid,p_id uuid,p_command text,p_version integer default null,p_result jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.assistant_activity; next_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into a from public.assistant_activity where id=p_id and owner_user_id=p_owner;
  if not found then raise exception 'Activity not found'; end if;
  if p_version is not null and a.version<>p_version then raise exception 'Activity changed'; end if;
  if p_command='start' and a.status='queued' and a.expires_at>now() then next_status:='running';
  elsif p_command='finish' and a.status='running' then
    next_status:=case when jsonb_array_length(coalesce(p_result->'actions','[]'))>0 then 'waiting' else 'completed' end;
  elsif p_command='fail' and a.status in ('queued','running') then next_status:='failed';
  elsif p_command='pause' and a.status in ('queued','running','waiting') then next_status:='paused';
  elsif p_command='resume' and a.status='paused' and a.expires_at>now() then
    next_status:=case when jsonb_array_length(a.actions)>0 then 'waiting' else 'cancelled' end;
  elsif p_command='cancel' and a.status in ('queued','running','waiting','paused') then next_status:='cancelled';
  elsif p_command='settle' then
    if a.status='waiting' and (select count(*) from public.assistant_activity_receipts where run_id=p_id)>=jsonb_array_length(a.actions) then next_status:='completed';
    else return to_jsonb(a); end if;
  else raise exception 'Activity is no longer in that state'; end if;
  update public.assistant_activity set status=next_status,version=version+1,updated_at=now(),
    actions=case when p_command='finish' then coalesce(p_result->'actions','[]') else actions end,
    sources=case when p_command='finish' then coalesce(p_result->'sources','[]') else sources end,
    error_code=case when p_command='fail' then coalesce(p_result->>'error_code','unavailable') else error_code end
    where id=p_id returning * into a;
  return to_jsonb(a);
end $$;
revoke all on function public.control_open_brain_activity(uuid,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.control_open_brain_activity(uuid,uuid,text,integer,jsonb) to service_role;

-- Exact immutable server proposal -> caller-RLS insert + receipt in ONE transaction.
-- The receipt is a retry token, not authorization: all domain writes retain RLS.
create function public.approve_open_brain_activity(p_id uuid,p_index integer,p_version integer,p_decision text default 'saved',p_embedding text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.assistant_activity; r public.assistant_activity_receipts; proposal jsonb; p jsonb; member public.household_members; assignee public.household_members; l public.lists; item jsonb; result_id uuid; result_ids uuid[]:='{}'; profile jsonb;
begin
  if auth.uid() is null or p_index is null or p_index<0 or p_index>11 or p_decision not in ('saved','dismissed') or p_decision is null then raise exception 'Invalid approval'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into a from public.assistant_activity where id=p_id and owner_user_id=auth.uid();
  if not found then raise exception 'Activity not found'; end if;
  select * into r from public.assistant_activity_receipts where run_id=p_id and action_index=p_index;
  if found then
    if r.decision<>p_decision then raise exception 'Proposal already decided'; end if;
    return to_jsonb(r);
  end if;
  if a.status<>'waiting' or p_version is null or a.version<>p_version or a.expires_at<=now() or p_index>=jsonb_array_length(a.actions) then raise exception 'Approval changed or expired'; end if;
  proposal:=a.actions->p_index; p:=proposal->'payload';
  if p_decision='saved' then
    profile:=public.get_open_brain_assistant_preferences();
    if profile->>'context_version' is distinct from a.context_version then raise exception 'Assistant context changed; ask again'; end if;
    if proposal->>'blocked' is not null then raise exception 'Proposal needs clarification'; end if;
    select * into member from public.household_members where user_id=auth.uid() and household_id=a.household_id;
    if not found then raise exception 'Household membership changed'; end if;
    if proposal->>'type'='task' then
      select * into assignee from public.household_members where user_id=(p->>'assigned_to_user_id')::uuid and household_id=a.household_id;
      if not found or (assignee.user_id<>auth.uid() and member.role<>'admin') or assignee.display_name is distinct from p->>'assigned_to' then raise exception 'Invalid assignee'; end if;
      if (p->>'remind_at')::timestamptz<=now() then raise exception 'Reminder time has passed; ask again'; end if;
      if p->>'recurrence_rule' is not null and public.next_recurring_time((p->>'remind_at')::timestamptz,p->>'recurrence_rule',coalesce((select timezone from public.households where id=a.household_id),'America/Denver')) is null then raise exception 'Invalid recurrence'; end if;
      insert into public.family_tasks(household_id,created_by,title,description,assigned_to,assigned_to_user_id,priority,status,remind_at,due_at,recurrence_rule,estimated_minutes,visibility,category)
      values(a.household_id,auth.uid(),p->>'title',p->>'description',assignee.display_name,assignee.user_id,p->>'priority','pending',(p->>'remind_at')::timestamptz,(p->>'due_at')::timestamptz,p->>'recurrence_rule',(p->>'estimated_minutes')::integer,p->>'visibility',case when p->>'visibility'='private' then 'personal' else 'household' end) returning id into result_id;
      result_ids:=array[result_id];
    elsif proposal->>'type'='event' then
      insert into public.family_events(household_id,created_by,title,description,location,starts_at,ends_at)
      values(a.household_id,auth.uid(),p->>'title',p->>'description',p->>'location',(p->>'starts_at')::timestamptz,(p->>'ends_at')::timestamptz) returning id into result_id;
      result_ids:=array[result_id];
    elsif proposal->>'type'='list_items' then
      select * into l from public.lists where id=(p->>'list_id')::uuid and household_id=a.household_id and archived_at is null;
      if not found or l.visibility is distinct from p->>'visibility' or l.name is distinct from p->>'list_name' then raise exception 'List changed; ask again'; end if;
      for item in select value from jsonb_array_elements(p->'items') loop
        insert into public.list_items(household_id,owner_user_id,list_id,list_name,content,quantity,notes,visibility)
        values(a.household_id,auth.uid(),l.id,l.name,item->>'content',item->>'quantity',item->>'notes',l.visibility) returning id into result_id;
        result_ids:=array_append(result_ids,result_id);
      end loop;
    elsif proposal->>'type'='memory' then
      if p->>'visibility'='parents' and member.role<>'admin' then raise exception 'Parents-only requires admin'; end if;
      if p_embedding is null then raise exception 'Memory embedding is required'; end if;
      insert into public.thoughts(household_id,created_by,content,visibility,metadata,embedding)
      values(a.household_id,auth.uid(),p->>'content',p->>'visibility',jsonb_build_object('type',p->>'type','topics',p->'topics','source','assistant_approval'),(jsonb_populate_record(null::public.thoughts,jsonb_build_object('embedding',p_embedding))).embedding) returning id into result_id;
      result_ids:=array[result_id];
    else raise exception 'Unsupported proposal'; end if;
  end if;
  insert into public.assistant_activity_receipts(run_id,action_index,owner_user_id,decision,result_ids)
    values(p_id,p_index,auth.uid(),p_decision,result_ids) returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.approve_open_brain_activity(uuid,integer,integer,text,text) from public,anon;
grant execute on function public.approve_open_brain_activity(uuid,integer,integer,text,text) to authenticated;
