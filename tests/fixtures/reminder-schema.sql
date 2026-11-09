-- Minimal Supabase service/schema fixtures. No real users, keys, or notifications.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema extensions;
create schema vault;
create schema cron;
create table vault.secrets(name text primary key,decrypted_secret text);
create view vault.decrypted_secrets as select * from vault.secrets;
create function vault.create_secret(secret text,name text,description text) returns uuid language plpgsql as $$
begin insert into vault.secrets values($2,$1);return gen_random_uuid();end $$;
create function extensions.gen_random_bytes(n integer) returns bytea language sql as $$select decode(repeat('ab',$1),'hex')$$;
create function extensions.digest(input text,algorithm text) returns bytea language sql as $$select sha256(convert_to($1,'UTF8'))$$;
create table cron.job(jobid bigint primary key,jobname text,command text);
insert into cron.job values(1,'send-telegram-reminders','old task command'),(2,'send-habit-reminders','old habit command'),(3,'send-event-notifications','old event command'),(4,'send-health-checkin-reminders','old health command');
create function cron.alter_job(jobid bigint,command text) returns void language sql as $$update cron.job set command=$2 where jobid=$1$$;
create table public.households(id uuid primary key,timezone text);
create table public.household_members(household_id uuid,user_id uuid,primary key(household_id,user_id));
create table public.family_tasks(
 id uuid primary key default gen_random_uuid(),title text,description text,assigned_to text,category text,priority text,
 status text default 'pending',due_at timestamptz,remind_at timestamptz,recurrence_rule text,visibility text,
 household_id uuid,created_by uuid,assigned_to_user_id uuid,completed_at timestamptz,updated_at timestamptz,
 reminder_sent_at timestamptz,reminder_error text
);
create table public.habits(id uuid primary key,title text,household_id uuid,owner_user_id uuid,status text);
create table public.habit_completions(habit_id uuid,household_id uuid,owner_user_id uuid,completed_on date,unique(habit_id,completed_on));
create table public.push_action_tokens(token uuid primary key default gen_random_uuid(),household_id uuid,user_id uuid,resource_type text,resource_id uuid,resource_date date,expires_at timestamptz not null,used_at timestamptz,created_at timestamptz default now());
