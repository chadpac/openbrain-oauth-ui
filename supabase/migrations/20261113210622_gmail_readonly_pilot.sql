create table public.google_gmail_connections (
 owner_user_id uuid primary key references auth.users(id) on delete cascade,
 household_id uuid not null references public.households(id) on delete cascade,
 connection_id uuid not null,
 refresh_token_cipher bytea not null,
 scopes text[] not null,
 connected_at timestamptz not null default now()
);
create index gmail_connections_household on public.google_gmail_connections(household_id);
create table public.google_gmail_accounts (
 owner_user_id uuid primary key references auth.users(id) on delete cascade,
 connection_id uuid not null,
 email text not null check(length(email) between 3 and 320),
 connected boolean not null default true,
 checked_at timestamptz,
 updated_at timestamptz not null default now()
);
create table public.google_gmail_oauth_states (
 state text primary key check(state like 'gmail.%'),
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 household_id uuid not null references public.households(id) on delete cascade,
 code_verifier text not null,
 expires_at timestamptz not null
);
create index gmail_states_owner on public.google_gmail_oauth_states(owner_user_id);
create index gmail_states_household on public.google_gmail_oauth_states(household_id);
create index gmail_states_expiry on public.google_gmail_oauth_states(expires_at);
alter table public.google_gmail_connections enable row level security;
alter table public.google_gmail_accounts enable row level security;
alter table public.google_gmail_oauth_states enable row level security;
revoke all on public.google_gmail_connections,public.google_gmail_accounts,public.google_gmail_oauth_states from public,anon,authenticated;
grant all on public.google_gmail_connections,public.google_gmail_accounts,public.google_gmail_oauth_states to service_role;
grant select on public.google_gmail_accounts to authenticated;
create policy gmail_account_owner_read on public.google_gmail_accounts for select to authenticated using(owner_user_id=(select auth.uid()));
alter table public.assistant_activity drop constraint assistant_activity_kind_check;
alter table public.assistant_activity add constraint assistant_activity_kind_check check(kind in ('question','today','week','calendar','gmail'));

create function public.save_open_brain_gmail_connection(p_owner uuid,p_household uuid,p_connection uuid,p_email text,p_cipher bytea,p_scopes text[])
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,1));
 if not exists(select 1 from public.household_members where user_id=p_owner and household_id=p_household) or not ('https://www.googleapis.com/auth/gmail.readonly'=any(p_scopes)) then raise exception 'Invalid Gmail connection'; end if;
 insert into public.google_gmail_connections(owner_user_id,household_id,connection_id,refresh_token_cipher,scopes) values(p_owner,p_household,p_connection,p_cipher,p_scopes)
 on conflict(owner_user_id) do update set household_id=excluded.household_id,connection_id=excluded.connection_id,refresh_token_cipher=excluded.refresh_token_cipher,scopes=excluded.scopes,connected_at=now();
 insert into public.google_gmail_accounts(owner_user_id,connection_id,email,connected) values(p_owner,p_connection,p_email,true)
 on conflict(owner_user_id) do update set connection_id=excluded.connection_id,email=excluded.email,connected=true,checked_at=null,updated_at=now();
end $$;
create function public.clear_open_brain_gmail_connection(p_owner uuid,p_connection uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,1));
 if exists(select 1 from public.google_gmail_connections where owner_user_id=p_owner and connection_id<>p_connection) then raise exception 'Gmail connection changed'; end if;
 delete from public.google_gmail_connections where owner_user_id=p_owner and connection_id=p_connection;
 update public.google_gmail_accounts set connected=false,updated_at=now() where owner_user_id=p_owner and connection_id=p_connection;
 delete from public.google_gmail_oauth_states where owner_user_id=p_owner;
 -- Approval takes a per-activity lock; the guarded account read below also locks
 -- the account advisory lock, serializing an approval with disconnect/reconnect.
end $$;
create function public.create_open_brain_gmail_proposal(p_owner uuid,p_household uuid,p_connection uuid,p_request uuid,p_context text,p_action jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare a public.assistant_activity;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,1));
 if not exists(select 1 from public.google_gmail_accounts where owner_user_id=p_owner and connection_id=p_connection and connected) or not exists(select 1 from public.household_members where user_id=p_owner and household_id=p_household) then raise exception 'Gmail connection changed'; end if;
 if p_action->>'type' is distinct from 'task' or p_action->'payload'->>'visibility' is distinct from 'private' or p_action->'payload'->>'assigned_to_user_id' is distinct from p_owner::text or p_action->'gmail_source'->>'connection_id' is distinct from p_connection::text then raise exception 'Invalid Gmail proposal'; end if;
 insert into public.assistant_activity(id,owner_user_id,household_id,kind,status,version,context_version,actions,sources)
 values(p_request,p_owner,p_household,'gmail','waiting',3,p_context,jsonb_build_array(p_action),jsonb_build_array(jsonb_build_object('kind','gmail','id',p_action->'gmail_source'->>'message_id')))
 on conflict(id) do nothing;
 select * into a from public.assistant_activity where id=p_request and owner_user_id=p_owner and kind='gmail';
 if not found or a.actions<>jsonb_build_array(p_action) or a.context_version<>p_context then raise exception 'Proposal request changed'; end if;
 return a.id;
end $$;
revoke all on function public.save_open_brain_gmail_connection(uuid,uuid,uuid,text,bytea,text[]),public.clear_open_brain_gmail_connection(uuid,uuid),public.create_open_brain_gmail_proposal(uuid,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_open_brain_gmail_connection(uuid,uuid,uuid,text,bytea,text[]),public.clear_open_brain_gmail_connection(uuid,uuid),public.create_open_brain_gmail_proposal(uuid,uuid,uuid,uuid,text,jsonb) to service_role;

-- Trigger performs a caller-RLS account read before an approved task insert. It
-- does not read tokens and does not elevate privileges. Its account advisory
-- lock serializes with disconnect/reconnect; a failed check rolls back the save.
create function public.check_gmail_approval_source()
returns trigger language plpgsql security invoker set search_path='' as $$
declare a public.assistant_activity; source jsonb; account public.google_gmail_accounts;
begin
 if new.decision<>'saved' then return new; end if;
 select * into a from public.assistant_activity where id=new.run_id;
 source:=a.actions->new.action_index->'gmail_source';
 if a.kind='gmail' then
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,1));
  select * into account from public.google_gmail_accounts where owner_user_id=auth.uid();
  if not found or not account.connected or account.connection_id::text is distinct from source->>'connection_id' then raise exception 'Gmail connection changed; ask again'; end if;
 end if;
 return new;
end $$;
create trigger check_gmail_approval_source before insert on public.assistant_activity_receipts for each row execute function public.check_gmail_approval_source();
revoke all on function public.check_gmail_approval_source() from public,anon,authenticated;
