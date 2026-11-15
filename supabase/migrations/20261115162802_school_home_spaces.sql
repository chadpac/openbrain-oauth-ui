create table public.spaces (
 id uuid primary key default gen_random_uuid(),
 household_id uuid not null references public.households(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 template text not null check(template in ('school','home','custom')),
 name text not null check(length(trim(name)) between 1 and 80),
 description text not null default '' check(length(description)<=500),
 visibility text not null default 'private' check(visibility in ('private','household')),
 version integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index spaces_household_page on public.spaces(household_id,created_at desc,id desc);
create index spaces_owner on public.spaces(owner_user_id);
alter table public.spaces enable row level security;
revoke all on public.spaces from public,anon,authenticated;
grant select,insert,update,delete on public.spaces to authenticated;
grant all on public.spaces to service_role;
create policy spaces_read on public.spaces for select to authenticated using(household_id in(select household_id from public.household_members where user_id=(select auth.uid())) and (visibility='household' or owner_user_id=(select auth.uid())));
create policy spaces_create on public.spaces for insert to authenticated with check(owner_user_id=(select auth.uid()) and household_id in(select household_id from public.household_members where user_id=(select auth.uid())));
create policy spaces_update on public.spaces for update to authenticated using(owner_user_id=(select auth.uid()) and household_id in(select household_id from public.household_members where user_id=(select auth.uid()))) with check(owner_user_id=(select auth.uid()) and household_id in(select household_id from public.household_members where user_id=(select auth.uid())));
create policy spaces_delete on public.spaces for delete to authenticated using(owner_user_id=(select auth.uid()) and household_id in(select household_id from public.household_members where user_id=(select auth.uid())));

create function public.space_source_visible(p_space uuid,p_kind text,p_source uuid)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare home uuid;
begin
 select household_id into home from public.spaces where id=p_space;
 if home is null then return false;end if;
 case p_kind
 when 'task' then return exists(select 1 from public.family_tasks where id=p_source and household_id=home);
 when 'event' then return exists(select 1 from public.family_events where id=p_source and household_id=home);
 when 'goal' then return exists(select 1 from public.family_goals where id=p_source and household_id=home and status is distinct from 'archived');
 when 'memory' then return exists(select 1 from public.thoughts where id=p_source and household_id=home and archived_at is null);
 when 'note','document' then return p_source is null;
 else return false;
 end case;
end $$;

create table public.space_items (
 id uuid primary key default gen_random_uuid(),
 space_id uuid not null references public.spaces(id) on delete cascade,
 created_by uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('task','event','goal','memory','note','document')),
 source_id uuid,
 title text not null default '' check(length(title)<=160),
 body text not null default '' check(length(body)<=6000),
 url text not null default '' check(length(url)<=2048),
 version integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check((kind in ('task','event','goal','memory') and source_id is not null and title='' and body='' and url='') or (kind='note' and source_id is null and length(trim(title))>0 and url='') or (kind='document' and source_id is null and length(trim(title))>0 and url ~ '^https?://[^/@[:space:]:?#]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$')),
 unique(space_id,kind,source_id)
);
create index space_items_space_page on public.space_items(space_id,created_at,id);
create index space_items_creator on public.space_items(created_by);
create index space_items_source on public.space_items(kind,source_id) where source_id is not null;
alter table public.space_items enable row level security;
revoke all on public.space_items from public,anon,authenticated;
grant select,insert,update,delete on public.space_items to authenticated;
grant all on public.space_items to service_role;
create policy space_items_read on public.space_items for select to authenticated using(public.space_source_visible(space_id,kind,source_id));
create policy space_items_create on public.space_items for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.spaces where id=space_id and owner_user_id=(select auth.uid())) and public.space_source_visible(space_id,kind,source_id));
create policy space_items_update on public.space_items for update to authenticated using(exists(select 1 from public.spaces where id=space_id and owner_user_id=(select auth.uid())) and public.space_source_visible(space_id,kind,source_id)) with check(created_by=(select auth.uid()) and exists(select 1 from public.spaces where id=space_id and owner_user_id=(select auth.uid())) and public.space_source_visible(space_id,kind,source_id));
create policy space_items_delete on public.space_items for delete to authenticated using(exists(select 1 from public.spaces where id=space_id and owner_user_id=(select auth.uid())) and public.space_source_visible(space_id,kind,source_id));

create table public.space_views (
 space_id uuid not null references public.spaces(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 pinned boolean not null default false,
 hidden boolean not null default false,
 position integer not null default 0 check(position between 0 and 10000),
 section_order text[] not null default array['progress','tasks','events','notes','documents'],
 hidden_sections text[] not null default '{}',
 pinned_items uuid[] not null default '{}',
 hidden_items uuid[] not null default '{}',
 item_order uuid[] not null default '{}',
 version integer not null default 1,
 updated_at timestamptz not null default now(),
 primary key(space_id,owner_user_id),
 check(cardinality(section_order)=5 and section_order @> array['progress','tasks','events','notes','documents'] and section_order <@ array['progress','tasks','events','notes','documents']),
 check(cardinality(hidden_sections)<=5 and hidden_sections <@ array['progress','tasks','events','notes','documents']),
 check(cardinality(pinned_items)<=200 and cardinality(hidden_items)<=200 and cardinality(item_order)<=200)
);
create index space_views_owner on public.space_views(owner_user_id);
alter table public.space_views enable row level security;
revoke all on public.space_views from public,anon,authenticated;
grant select,insert,update,delete on public.space_views to authenticated;
grant all on public.space_views to service_role;
create policy space_views_read on public.space_views for select to authenticated using(owner_user_id=(select auth.uid()) and exists(select 1 from public.spaces where id=space_id));
create policy space_views_create on public.space_views for insert to authenticated with check(owner_user_id=(select auth.uid()) and exists(select 1 from public.spaces where id=space_id));
create policy space_views_update on public.space_views for update to authenticated using(owner_user_id=(select auth.uid()) and exists(select 1 from public.spaces where id=space_id)) with check(owner_user_id=(select auth.uid()) and exists(select 1 from public.spaces where id=space_id));
create policy space_views_delete on public.space_views for delete to authenticated using(owner_user_id=(select auth.uid()) and exists(select 1 from public.spaces where id=space_id));

create function public.validate_space_write()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_name='spaces' then
  new.name:=trim(new.name);new.description:=trim(new.description);
  if tg_op='UPDATE' then
   if new.id<>old.id or new.household_id<>old.household_id or new.owner_user_id<>old.owner_user_id or new.template<>old.template or new.created_at<>old.created_at then raise exception 'Space identity cannot be changed';end if;
   new.version:=old.version+1;
  else
   perform pg_advisory_xact_lock(hashtextextended(new.owner_user_id::text,6));
   if (select count(*) from public.spaces where owner_user_id=new.owner_user_id and household_id=new.household_id)>=20 then raise exception 'Use up to 20 Spaces per household';end if;
   new.version:=1;
  end if;
 elsif tg_table_name='space_items' then
  if tg_op='UPDATE' then
   if new.id<>old.id or new.space_id<>old.space_id or new.created_by<>old.created_by or new.kind<>old.kind or new.source_id is distinct from old.source_id or new.created_at<>old.created_at then raise exception 'Space item identity cannot be changed';end if;
   new.version:=old.version+1;
  else
   perform 1 from public.spaces where id=new.space_id and owner_user_id=auth.uid() for update;
   if not found then raise exception 'Only the Space creator can add items';end if;
   if (select count(*) from public.space_items where space_id=new.space_id)>=200 then raise exception 'Use up to 200 accessible items in one Space';end if;
   new.version:=1;
  end if;
  new.title:=trim(new.title);new.body:=trim(new.body);new.url:=trim(new.url);
 else
  if tg_op='UPDATE' then
   if new.space_id<>old.space_id or new.owner_user_id<>old.owner_user_id then raise exception 'View identity cannot be changed';end if;
   new.version:=old.version+1;
  else new.version:=1;end if;
 end if;
 new.updated_at:=now();return new;
end $$;
create trigger validate_space before insert or update on public.spaces for each row execute function public.validate_space_write();
create trigger validate_space_item before insert or update on public.space_items for each row execute function public.validate_space_write();
create trigger validate_space_view before insert or update on public.space_views for each row execute function public.validate_space_write();

create function public.save_open_brain_space(p_id uuid,p_household uuid,p_template text,p_name text,p_description text,p_visibility text,p_version integer default null,p_confirm_sharing boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.spaces;
begin
 if auth.uid() is null then raise exception 'Sign in first';end if;
 if p_version is null then
  select * into s from public.spaces where id=p_id;
  if found then
   if s.owner_user_id<>auth.uid() or s.household_id<>p_household or s.template<>p_template or s.name<>trim(p_name) or s.description<>trim(p_description) or s.visibility<>p_visibility then raise exception 'Space request changed. Refresh before retrying';end if;
   return to_jsonb(s);
  end if;
  if p_visibility='household' and not coalesce(p_confirm_sharing,false) then raise exception 'Confirm sharing the Space name, notes and document links with your household';end if;
  insert into public.spaces(id,household_id,owner_user_id,template,name,description,visibility) values(p_id,p_household,auth.uid(),p_template,p_name,p_description,p_visibility) returning * into s;
 else
  select * into s from public.spaces where id=p_id and owner_user_id=auth.uid() for update;
  if not found or s.version<>p_version or s.household_id<>p_household or s.template<>p_template then raise exception 'Space changed or is unavailable. Refresh first';end if;
  if s.visibility='private' and p_visibility='household' and not coalesce(p_confirm_sharing,false) then raise exception 'Confirm sharing the Space name, notes and document links with your household';end if;
  update public.spaces set name=p_name,description=p_description,visibility=p_visibility where id=p_id and owner_user_id=auth.uid() and version=p_version returning * into s;
  if not found then raise exception 'Space changed or is unavailable. Refresh first';end if;
 end if;
 return to_jsonb(s);
end $$;

create function public.list_open_brain_spaces(p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rows jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in first';end if;
 if (p_before is null)<>(p_before_id is null) then raise exception 'Invalid Space page';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id desc),'[]') into rows from (
  select s.*,to_jsonb(v)-'owner_user_id' as view from public.spaces s left join public.space_views v on v.space_id=s.id and v.owner_user_id=auth.uid()
  where p_before is null or (s.created_at,s.id)<(p_before,p_before_id) order by s.created_at desc,s.id desc limit 101
 ) x;
 return jsonb_build_object('spaces',(select coalesce(jsonb_agg(value),'[]') from jsonb_array_elements(rows) with ordinality t(value,n) where n<=100),'has_more',jsonb_array_length(rows)>100);
end $$;

create function public.get_open_brain_space(p_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.spaces; v public.space_views; items jsonb;
begin
 select * into s from public.spaces where id=p_id;if not found then raise exception 'Space is unavailable';end if;
 select * into v from public.space_views where space_id=p_id and owner_user_id=auth.uid();
 select coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('source',case i.kind
 when 'task' then (select jsonb_build_object('id',t.id,'title',left(t.title,200),'status',t.status,'due_at',t.due_at,'remind_at',t.remind_at,'assigned_to',left(t.assigned_to,120),'visibility',t.visibility) from public.family_tasks t where t.id=i.source_id and t.household_id=s.household_id)
 when 'event' then (select jsonb_build_object('id',e.id,'title',left(e.title,200),'starts_at',e.starts_at,'ends_at',e.ends_at,'all_day',e.all_day,'location',left(e.location,500)) from public.family_events e where e.id=i.source_id and e.household_id=s.household_id)
 when 'goal' then (select jsonb_build_object('id',g.id,'title',left(g.title,200),'progress_percent',g.progress_percent,'status',g.status,'target_date',g.target_date,'next_action',left(g.next_action,1000),'visibility',g.visibility) from public.family_goals g where g.id=i.source_id and g.household_id=s.household_id)
 when 'memory' then (select jsonb_build_object('id',m.id,'title',left(m.content,160),'content',left(m.content,6000),'visibility',m.visibility) from public.thoughts m where m.id=i.source_id and m.household_id=s.household_id and m.archived_at is null)
 else null end) order by i.created_at,i.id),'[]') into items from (select * from public.space_items where space_id=p_id order by created_at,id limit 201) i;
 if jsonb_array_length(items)>200 then raise exception 'Space has too many accessible items. Narrow the collection';end if;
 return jsonb_build_object('space',to_jsonb(s),'view',case when v.space_id is null then null else to_jsonb(v)-'owner_user_id' end,'items',items);
end $$;

create function public.save_open_brain_space_item(p_id uuid,p_space uuid,p_kind text,p_source uuid default null,p_title text default '',p_body text default '',p_url text default '',p_version integer default null,p_space_version integer default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item public.space_items; parent public.spaces;
begin
 if auth.uid() is null then raise exception 'Sign in first';end if;
 select * into parent from public.spaces where id=p_space and owner_user_id=auth.uid() for update;
 if not found then raise exception 'Only the Space creator can change its contents';end if;
 if (p_kind in ('note','document') or p_space_version is not null) and parent.version is distinct from p_space_version then raise exception 'Space settings changed. Refresh the Space and reopen this item editor before saving';end if;
 if not public.space_source_visible(p_space,p_kind,p_source) then raise exception 'This source is unavailable. Refresh the picker';end if;
 if p_version is null then
  select * into item from public.space_items where id=p_id;
  if found then
   if item.space_id<>p_space or item.kind<>p_kind or item.source_id is distinct from p_source or item.title<>trim(p_title) or item.body<>trim(p_body) or item.url<>trim(p_url) then raise exception 'Item request changed. Refresh before retrying';end if;
   return to_jsonb(item);
  end if;
  if p_source is not null then
   select * into item from public.space_items where space_id=p_space and kind=p_kind and source_id=p_source;
   if found then return to_jsonb(item);end if;
  end if;
  insert into public.space_items(id,space_id,created_by,kind,source_id,title,body,url) values(p_id,p_space,auth.uid(),p_kind,p_source,p_title,p_body,p_url) returning * into item;
 else
  update public.space_items set title=p_title,body=p_body,url=p_url where id=p_id and space_id=p_space and kind=p_kind and source_id is not distinct from p_source and version=p_version returning * into item;
  if not found then raise exception 'Item changed or is unavailable. Refresh first';end if;
 end if;
 return to_jsonb(item);
end $$;

create function public.remove_open_brain_space_item(p_space uuid,p_id uuid,p_version integer)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.spaces where id=p_space and owner_user_id=auth.uid() for update;
 if not found then raise exception 'Only the Space creator can change its contents';end if;
 delete from public.space_items where id=p_id and space_id=p_space and version=p_version;
 if not found then raise exception 'Item changed or is unavailable. Refresh first';end if;
 return true;
end $$;

create function public.delete_open_brain_space(p_id uuid,p_version integer)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 delete from public.spaces where id=p_id and owner_user_id=auth.uid() and version=p_version;
 if not found then raise exception 'Space changed or is unavailable. Refresh first';end if;
 return true;
end $$;

create function public.save_open_brain_space_view(p_space uuid,p_settings jsonb,p_version integer default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v public.space_views; sections text[]; hidden_sections text[]; pinned uuid[]; hidden uuid[]; ordering uuid[];
begin
 if auth.uid() is null or not exists(select 1 from public.spaces where id=p_space) then raise exception 'Space is unavailable';end if;
 if jsonb_typeof(p_settings->'pinned') is distinct from 'boolean' or jsonb_typeof(p_settings->'hidden') is distinct from 'boolean' or coalesce(p_settings->>'position','') !~ '^\d{1,5}$' or (p_settings->>'position')::integer>10000 then raise exception 'Invalid Space layout';end if;
 if jsonb_typeof(p_settings->'section_order') is distinct from 'array' or jsonb_typeof(p_settings->'hidden_sections') is distinct from 'array' or jsonb_typeof(p_settings->'pinned_items') is distinct from 'array' or jsonb_typeof(p_settings->'hidden_items') is distinct from 'array' or jsonb_typeof(p_settings->'item_order') is distinct from 'array' then raise exception 'Invalid Space layout';end if;
 if jsonb_array_length(p_settings->'section_order')<>5 or jsonb_array_length(p_settings->'hidden_sections')>5 or jsonb_array_length(p_settings->'pinned_items')>200 or jsonb_array_length(p_settings->'hidden_items')>200 or jsonb_array_length(p_settings->'item_order')>200 then raise exception 'Layout is too large';end if;
 select coalesce(array_agg(x.value order by x.n),'{}') into sections from jsonb_array_elements_text(p_settings->'section_order') with ordinality x(value,n);
 select coalesce(array_agg(x.value order by x.n),'{}') into hidden_sections from jsonb_array_elements_text(p_settings->'hidden_sections') with ordinality x(value,n);
 select coalesce(array_agg(x.value::uuid order by x.n),'{}') into pinned from jsonb_array_elements_text(p_settings->'pinned_items') with ordinality x(value,n);
 select coalesce(array_agg(x.value::uuid order by x.n),'{}') into hidden from jsonb_array_elements_text(p_settings->'hidden_items') with ordinality x(value,n);
 select coalesce(array_agg(x.value::uuid order by x.n),'{}') into ordering from jsonb_array_elements_text(p_settings->'item_order') with ordinality x(value,n);
 -- Drop stale/inaccessible IDs without exposing whether a hidden source exists.
 select coalesce(array_agg(wanted.item_id order by wanted.n),'{}') into pinned from unnest(pinned) with ordinality as wanted(item_id,n) where exists(select 1 from public.space_items where space_id=p_space and id=wanted.item_id);
 select coalesce(array_agg(wanted.item_id order by wanted.n),'{}') into hidden from unnest(hidden) with ordinality as wanted(item_id,n) where exists(select 1 from public.space_items where space_id=p_space and id=wanted.item_id);
 select coalesce(array_agg(wanted.item_id order by wanted.n),'{}') into ordering from unnest(ordering) with ordinality as wanted(item_id,n) where exists(select 1 from public.space_items where space_id=p_space and id=wanted.item_id);
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_space::text,7));
 select * into v from public.space_views where space_id=p_space and owner_user_id=auth.uid() for update;
 if found and v.version is distinct from p_version or not found and p_version is not null then raise exception 'Layout changed on another device. Refresh first';end if;
 insert into public.space_views(space_id,owner_user_id,pinned,hidden,position,section_order,hidden_sections,pinned_items,hidden_items,item_order)
 values(p_space,auth.uid(),(p_settings->>'pinned')::boolean,(p_settings->>'hidden')::boolean,(p_settings->>'position')::integer,sections,hidden_sections,pinned,hidden,ordering)
 on conflict(space_id,owner_user_id) do update set pinned=excluded.pinned,hidden=excluded.hidden,position=excluded.position,section_order=excluded.section_order,hidden_sections=excluded.hidden_sections,pinned_items=excluded.pinned_items,hidden_items=excluded.hidden_items,item_order=excluded.item_order returning * into v;
 return to_jsonb(v)-'owner_user_id';
end $$;

create function public.find_open_brain_space_sources(p_space uuid,p_kind text,p_query text default '',p_after uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare home uuid; rows jsonb;
begin
 select household_id into home from public.spaces where id=p_space;
 if home is null then raise exception 'Space is unavailable';end if;
 if length(p_query)>200 then raise exception 'Use a shorter search';end if;
 case p_kind
 when 'task' then select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into rows from(select id,left(title,200) as title,status,visibility,due_at from public.family_tasks where household_id=home and (p_after is null or id>p_after) and position(lower(trim(p_query)) in lower(title))>0 order by id limit 21)t;
 when 'event' then select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into rows from(select id,left(title,200) as title,starts_at,all_day from public.family_events where household_id=home and (p_after is null or id>p_after) and position(lower(trim(p_query)) in lower(title))>0 order by id limit 21)t;
 when 'goal' then select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into rows from(select id,left(title,200) as title,status,visibility,progress_percent from public.family_goals where household_id=home and status is distinct from 'archived' and (p_after is null or id>p_after) and position(lower(trim(p_query)) in lower(title))>0 order by id limit 21)t;
 when 'memory' then select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into rows from(select id,left(content,160) as title,visibility from public.thoughts where household_id=home and archived_at is null and (p_after is null or id>p_after) and position(lower(trim(p_query)) in lower(content))>0 order by id limit 21)t;
 else raise exception 'Choose a supported record type';end case;
 return jsonb_build_object('rows',(select coalesce(jsonb_agg(value),'[]') from jsonb_array_elements(rows) with ordinality t(value,n) where n<=20),'has_more',jsonb_array_length(rows)>20);
end $$;

revoke all on function public.validate_space_write() from public,anon,authenticated;
do $$ declare f record;begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in ('space_source_visible','save_open_brain_space','list_open_brain_spaces','get_open_brain_space','save_open_brain_space_item','remove_open_brain_space_item','delete_open_brain_space','save_open_brain_space_view','find_open_brain_space_sources') loop
  execute format('revoke all on function %s from public,anon',f.signature);
  execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;

notify pgrst,'reload schema';
