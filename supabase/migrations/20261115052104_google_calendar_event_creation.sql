-- Credentials stay server-only. A fresh generation invalidates older event drafts.
alter table public.google_calendar_connections add column connection_id uuid not null default gen_random_uuid();
alter table public.google_oauth_states add column write_requested boolean not null default false;

create table public.google_calendar_event_proposals (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 household_id uuid not null references public.households(id) on delete cascade,
 connection_id uuid not null,
 request_id uuid not null,
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<16000),
 source jsonb,
 review jsonb not null check(jsonb_typeof(review)='object' and octet_length(review::text)<24000),
 state text not null default 'pending' check(state in ('pending','creating','uncertain','completed','failed','cancelled')),
 lease_id uuid,
 lease_until timestamptz,
 attempts integer not null default 0,
 write_started_at timestamptz,
 result jsonb,
 last_error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(owner_user_id,request_id)
);
create unique index calendar_event_same_intent on public.google_calendar_event_proposals(owner_user_id,connection_id,input_hash) where state<>'cancelled';
create index calendar_event_owner_page on public.google_calendar_event_proposals(owner_user_id,created_at desc,id desc);
create index calendar_event_household on public.google_calendar_event_proposals(household_id);
alter table public.google_calendar_event_proposals enable row level security;
revoke all on public.google_calendar_event_proposals from public,anon,authenticated;
grant all on public.google_calendar_event_proposals to service_role;
grant select on public.google_calendar_event_proposals to authenticated;
create policy calendar_event_owner_read on public.google_calendar_event_proposals for select to authenticated
 using(owner_user_id=(select auth.uid()) and household_id in(select household_id from public.household_members where user_id=(select auth.uid())));

create function public.save_google_calendar_event_proposal(p_owner uuid,p_household uuid,p_connection uuid,p_request uuid,p_hash text,p_payload jsonb,p_source jsonb,p_review jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare draft public.google_calendar_event_proposals;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,2));
 if not exists(select 1 from public.household_members where user_id=p_owner and household_id=p_household)
 or not exists(select 1 from public.google_calendar_connections where owner_user_id=p_owner and household_id=p_household and connection_id=p_connection and 'https://www.googleapis.com/auth/calendar.events'=any(scopes) and p_payload->>'calendar_id'=any(selected_calendar_ids)) then raise exception 'Calendar connection changed; reconnect and review again'; end if;
 select * into draft from public.google_calendar_event_proposals where owner_user_id=p_owner and request_id=p_request;
 if found then
  if draft.input_hash<>p_hash or draft.connection_id<>p_connection then raise exception 'Proposal request changed'; end if;
  return to_jsonb(draft);
 end if;
 insert into public.google_calendar_event_proposals(owner_user_id,household_id,connection_id,request_id,input_hash,payload,source,review)
 values(p_owner,p_household,p_connection,p_request,p_hash,p_payload,p_source,p_review) on conflict do nothing returning * into draft;
 if not found then select * into draft from public.google_calendar_event_proposals where owner_user_id=p_owner and connection_id=p_connection and input_hash=p_hash and state<>'cancelled'; end if;
 if draft.id is null then raise exception 'Proposal could not be saved'; end if;
 return to_jsonb(draft);
end $$;

create function public.claim_google_calendar_event(p_owner uuid,p_id uuid,p_lease uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare draft public.google_calendar_event_proposals;
begin
 select * into draft from public.google_calendar_event_proposals where id=p_id and owner_user_id=p_owner for update;
 if not found then raise exception 'Event proposal not found'; end if;
 if draft.state='completed' then return to_jsonb(draft); end if;
 if draft.state in ('failed','cancelled') then raise exception 'Prepare a new event review'; end if;
 if draft.state='creating' and draft.lease_until>now() then raise exception 'Save in progress; check the result shortly'; end if;
 if not exists(select 1 from public.household_members where user_id=p_owner and household_id=draft.household_id)
 or not exists(select 1 from public.google_calendar_connections where owner_user_id=p_owner and household_id=draft.household_id and connection_id=draft.connection_id and 'https://www.googleapis.com/auth/calendar.events'=any(scopes) and draft.payload->>'calendar_id'=any(selected_calendar_ids)) then raise exception 'Calendar connection changed; check the original calendar before preparing again'; end if;
 update public.google_calendar_event_proposals set state='creating',lease_id=p_lease,lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() where id=p_id returning * into draft;
 return to_jsonb(draft);
end $$;

create function public.finish_google_calendar_event(p_owner uuid,p_id uuid,p_lease uuid,p_state text,p_result jsonb default null,p_error text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare draft public.google_calendar_event_proposals;
begin
 if p_state not in ('pending','uncertain','completed','failed') then raise exception 'Invalid event result'; end if;
 update public.google_calendar_event_proposals set state=case when p_state='pending' and write_started_at is not null then 'uncertain' else p_state end,result=p_result,last_error=left(p_error,500),lease_id=null,lease_until=null,updated_at=now()
 where id=p_id and owner_user_id=p_owner and state='creating' and lease_id=p_lease returning * into draft;
 if not found then raise exception 'Save result changed; check event history'; end if;
 return to_jsonb(draft);
end $$;

create function public.cancel_google_calendar_event(p_owner uuid,p_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare draft public.google_calendar_event_proposals;
begin
 select * into draft from public.google_calendar_event_proposals where id=p_id and owner_user_id=p_owner for update;
 if not found then raise exception 'Event proposal not found'; end if;
 if draft.state not in ('pending','cancelled','failed') or draft.state='pending' and draft.write_started_at is not null then raise exception 'A save may have reached Google; check or retry its result first'; end if;
 update public.google_calendar_event_proposals set state='cancelled',updated_at=now() where id=p_id returning * into draft;
 return to_jsonb(draft);
end $$;
create function public.start_google_calendar_event_insert(p_owner uuid,p_id uuid,p_lease uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare draft public.google_calendar_event_proposals;
begin
 select * into draft from public.google_calendar_event_proposals where id=p_id and owner_user_id=p_owner for update;
 if not found or draft.state<>'creating' or draft.lease_id is distinct from p_lease or draft.lease_until<=now() then raise exception 'Save lease expired; retry the same event'; end if;
 if not exists(select 1 from public.household_members where user_id=p_owner and household_id=draft.household_id)
 or not exists(select 1 from public.google_calendar_connections where owner_user_id=p_owner and household_id=draft.household_id and connection_id=draft.connection_id and 'https://www.googleapis.com/auth/calendar.events'=any(scopes) and draft.payload->>'calendar_id'=any(selected_calendar_ids)) then raise exception 'Calendar connection changed'; end if;
 if draft.source is not null and not exists(select 1 from public.google_gmail_accounts where owner_user_id=p_owner and connected and connection_id::text=draft.source->>'connection_id') then raise exception 'Gmail connection changed'; end if;
 update public.google_calendar_event_proposals set write_started_at=coalesce(write_started_at,now()),updated_at=now() where id=p_id;
end $$;
revoke all on function public.save_google_calendar_event_proposal(uuid,uuid,uuid,uuid,text,jsonb,jsonb,jsonb),public.claim_google_calendar_event(uuid,uuid,uuid),public.finish_google_calendar_event(uuid,uuid,uuid,text,jsonb,text),public.cancel_google_calendar_event(uuid,uuid) from public,anon,authenticated;
grant execute on function public.save_google_calendar_event_proposal(uuid,uuid,uuid,uuid,text,jsonb,jsonb,jsonb),public.claim_google_calendar_event(uuid,uuid,uuid),public.finish_google_calendar_event(uuid,uuid,uuid,text,jsonb,text),public.cancel_google_calendar_event(uuid,uuid) to service_role;
revoke all on function public.start_google_calendar_event_insert(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.start_google_calendar_event_insert(uuid,uuid,uuid) to service_role;
