begin;

create schema homehub_private;
revoke all on schema homehub_private from public, anon, authenticated;

create table homehub_private.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  day text not null default 'Sunday' check (day in ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
  buyer uuid
);
create table homehub_private.members (
  household uuid not null references homehub_private.households(id),
  uid uuid not null,
  name text not null,
  role text not null default 'member' check (role in ('admin','member')),
  primary key (household,uid)
);
create index on homehub_private.members(uid);
alter table homehub_private.households add foreign key (id,buyer) references homehub_private.members(household,uid);
create table homehub_private.invitations (
  household uuid primary key references homehub_private.households(id),
  digest bytea not null unique,
  expires timestamptz not null
);
create table homehub_private.attempts (
  uid uuid primary key,
  period bigint not null,
  count int not null
);
create table homehub_private.requests (
  id uuid primary key default gen_random_uuid(),
  household uuid not null references homehub_private.households(id),
  uid uuid not null,
  creator text not null,
  name text not null check (char_length(name) between 1 and 100),
  item_key text not null,
  quantity int not null check (quantity between 1 and 9999),
  created bigint not null,
  batch uuid,
  ordered bigint
);
create index on homehub_private.requests(household,batch,item_key);
create table homehub_private.contacts (
  household uuid not null references homehub_private.households(id),
  id uuid not null default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  phone text not null check (char_length(phone) <= 40 and phone ~ '^[+]?[0-9 ().-]+$' and char_length(regexp_replace(phone,'[^0-9]','','g')) >= 3),
  notes text not null default '' check (char_length(notes) <= 500),
  primary key (household,id)
);
create table homehub_private.tasks (
  household uuid not null references homehub_private.households(id),
  id uuid not null default gen_random_uuid(),
  description text not null check (char_length(description) between 1 and 240),
  creator text not null,
  assignee uuid,
  contact uuid,
  due date,
  status text not null check (status in ('Pending','In Progress','Scheduled','Completed')),
  primary key (household,id),
  foreign key (household, assignee) references homehub_private.members(household,uid),
  foreign key (household, contact) references homehub_private.contacts(household,id)
);

-- Application data stays outside exposed API schemas. RLS is also enabled as a fallback.
alter table homehub_private.households enable row level security;
alter table homehub_private.members enable row level security;
alter table homehub_private.invitations enable row level security;
alter table homehub_private.attempts enable row level security;
alter table homehub_private.requests enable row level security;
alter table homehub_private.contacts enable row level security;
alter table homehub_private.tasks enable row level security;
revoke all on all tables in schema homehub_private from public, anon, authenticated;

-- Realtime publishes a personal change signal only. It contains no household ID or records.
create table public.homehub_events (
  uid uuid primary key references auth.users(id) on delete cascade,
  revision uuid not null default gen_random_uuid()
);
alter table public.homehub_events enable row level security;
revoke all on public.homehub_events from public, anon, authenticated;
grant select on public.homehub_events to authenticated;
create policy homehub_read_own_event on public.homehub_events
  for select to authenticated using (uid = (select auth.uid()));
alter publication supabase_realtime add table public.homehub_events;

create function public.homehub(
  p_operation text,
  p_household uuid default null,
  p_record uuid default null,
  p_body jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  display_name text;
  household_id uuid := p_household;
  member_role text;
  item_name text;
  assigned uuid;
  linked uuid;
  due_date date;
  code text;
  code_hash bytea;
  order_batch uuid;
  current_time_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  expiration timestamptz;
  rate_period bigint := current_time_ms / 900000;
  attempt_count int;
  changed int;
  result jsonb := '{"ok":true}';
  removed_uid uuid;
begin
  if actor is null or coalesce(auth.jwt()->>'role','') <> 'authenticated' then
    return '{"status":401,"error":"Sign in to use HomeHub."}';
  end if;
  select left(coalesce(nullif(u.raw_user_meta_data->>'full_name',''),nullif(u.raw_user_meta_data->>'name',''),'Household member'),160)
    into display_name from auth.users u where u.id=actor;
  if display_name is null then return '{"status":401,"error":"Sign in to use HomeHub."}'; end if;
  if jsonb_typeof(p_body) is distinct from 'object' or octet_length(p_body::text) > 450000 then
    return '{"status":400,"error":"Invalid or oversized request."}';
  end if;

  if p_operation = 'list' then
    return jsonb_build_object('uid',actor,'display',display_name,'households',
      coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'name',h.name,'role',m.role) order by h.name,h.id)
        from homehub_private.members m join homehub_private.households h on h.id=m.household where m.uid=actor),'[]'::jsonb));
  elsif p_operation = 'create' then
    insert into homehub_private.households(name) values (btrim(p_body->>'name')) returning id into household_id;
    insert into homehub_private.members values (household_id,actor,display_name,'admin');
    update homehub_private.households set buyer=actor where id=household_id;
    result := jsonb_build_object('id',household_id);
  elsif p_operation = 'join' then
    -- Return errors as data so failed attempts commit their rate-limit increment.
    insert into homehub_private.attempts as a values (actor,rate_period,1)
      on conflict (uid) do update set period=excluded.period,
        count=case when a.period=excluded.period then least(a.count+1,9) else 1 end
      returning count into attempt_count;
    if attempt_count > 8 then return '{"status":429,"error":"Too many attempts. Try again in a few minutes."}'; end if;
    code := lower(btrim(p_body->>'code'));
    if code is null or code !~ '^[a-f0-9]{32}$' then return '{"status":404,"error":"Invitation is invalid or has expired."}'; end if;
    code_hash := sha256(convert_to(code,'UTF8'));
    select i.household into household_id from homehub_private.invitations i where i.digest=code_hash;
    perform 1 from homehub_private.households h where h.id=household_id for update;
    if not exists (select 1 from homehub_private.invitations i where i.household=household_id and i.digest=code_hash and i.expires>clock_timestamp()) then
      return '{"status":404,"error":"Invitation is invalid or has expired."}';
    end if;
    insert into homehub_private.members values (household_id,actor,display_name,'member') on conflict do nothing;
    result := jsonb_build_object('id',household_id);
  else
    -- Preliminary membership check avoids taking locks on arbitrary household IDs.
    if not exists(select 1 from homehub_private.members m where m.household=household_id and m.uid=actor) then
      return '{"status":404,"error":"Household unavailable."}';
    end if;
    if p_operation = 'get' then
      perform 1 from homehub_private.households h where h.id=household_id for share;
    else
      perform 1 from homehub_private.households h where h.id=household_id for update;
    end if;
    select m.role into member_role from homehub_private.members m where m.household=household_id and m.uid=actor;
    if member_role is null then return '{"status":404,"error":"Household unavailable."}'; end if;
    if p_operation in ('settings','rotate','invite','revoke','role','remove') and member_role <> 'admin' then
      return '{"status":403,"error":"An admin is required."}';
    end if;

    case p_operation
    when 'get' then
      return jsonb_build_object(
        'household',(select to_jsonb(h) from homehub_private.households h where h.id=household_id),
        'members',coalesce((select jsonb_agg(to_jsonb(m)-'household' order by m.name,m.uid) from homehub_private.members m where m.household=household_id),'[]'::jsonb),
        'items',coalesce((select jsonb_agg(to_jsonb(r) order by r.created desc,r.id) from homehub_private.requests r where r.household=household_id),'[]'::jsonb),
        'tasks',coalesce((select jsonb_agg(to_jsonb(t) order by (t.status='Completed'),t.due nulls last,t.description) from homehub_private.tasks t where t.household=household_id),'[]'::jsonb),
        'contacts',coalesce((select jsonb_agg(to_jsonb(c) order by lower(c.name),c.id) from homehub_private.contacts c where c.household=household_id),'[]'::jsonb),
        'inviteExpiry',case when member_role='admin' then (select floor(extract(epoch from i.expires)*1000)
          from homehub_private.invitations i where i.household=household_id and i.expires>clock_timestamp()) end);
    when 'item_add','item_edit' then
      item_name := btrim(regexp_replace(normalize(p_body->>'name',NFKC),'[[:space:]]+',' ','g'));
      if p_operation='item_add' then
        insert into homehub_private.requests(household,uid,creator,name,item_key,quantity,created)
          values(household_id,actor,display_name,item_name,lower(item_name),(p_body->>'quantity')::int,current_time_ms);
      else
        update homehub_private.requests
          set name=item_name,item_key=lower(item_name),quantity=(p_body->>'quantity')::int
          where household=household_id and id=p_record and uid=actor and batch is null;
      end if;
      get diagnostics changed = row_count;
    when 'item_delete' then
      delete from homehub_private.requests where household=household_id and id=p_record and uid=actor and batch is null;
      get diagnostics changed = row_count;
    when 'order' then
      if jsonb_typeof(p_body->'ids') is distinct from 'array' then return '{"status":400,"error":"Select requests to mark as ordered."}'; end if;
      if jsonb_array_length(p_body->'ids') not between 1 and 10000 then return '{"status":400,"error":"Select requests to mark as ordered."}'; end if;
      order_batch := gen_random_uuid();
      update homehub_private.requests set batch=order_batch,ordered=current_time_ms where household=household_id and batch is null
        and id in (select value::uuid from jsonb_array_elements_text(p_body->'ids'));
      get diagnostics changed = row_count;
      result := jsonb_build_object('batch',order_batch);
    when 'undo' then
      update homehub_private.requests set batch=null,ordered=null where household=household_id and batch=p_record;
      get diagnostics changed = row_count;
    when 'task_add','task_edit' then
      assigned := nullif(p_body->>'assignee','')::uuid;
      linked := nullif(p_body->>'contact','')::uuid;
      if coalesce(p_body->>'due','') <> '' and p_body->>'due' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        return '{"status":400,"error":"Enter a valid due date."}';
      end if;
      due_date := nullif(p_body->>'due','')::date;
      if p_operation='task_add' then
        insert into homehub_private.tasks(household,description,creator,assignee,contact,due,status)
          values(household_id,btrim(p_body->>'description'),display_name,assigned,linked,due_date,p_body->>'status');
      else
        update homehub_private.tasks set description=btrim(p_body->>'description'),assignee=assigned,contact=linked,due=due_date,status=p_body->>'status'
          where household=household_id and id=p_record;
      end if;
      get diagnostics changed = row_count;
    when 'task_delete' then
      delete from homehub_private.tasks where household=household_id and id=p_record;
      get diagnostics changed = row_count;
    when 'contact_add','contact_edit' then
      if p_operation='contact_add' then
        insert into homehub_private.contacts(household,name,phone,notes)
          values(household_id,btrim(p_body->>'name'),btrim(p_body->>'phone'),btrim(coalesce(p_body->>'notes','')));
      else
        update homehub_private.contacts set name=btrim(p_body->>'name'),phone=btrim(p_body->>'phone'),notes=btrim(coalesce(p_body->>'notes',''))
          where household=household_id and id=p_record;
      end if;
      get diagnostics changed = row_count;
    when 'contact_delete' then
      update homehub_private.tasks set contact=null where household=household_id and contact=p_record;
      delete from homehub_private.contacts where household=household_id and id=p_record;
      get diagnostics changed = row_count;
    when 'settings' then
      update homehub_private.households set name=btrim(p_body->>'name'),day=p_body->>'day',buyer=nullif(p_body->>'buyer','')::uuid where id=household_id;
    when 'rotate' then
      update homehub_private.households h set buyer=coalesce(
        (select m.uid from homehub_private.members m where m.household=household_id and m.uid>h.buyer order by m.uid limit 1),
        (select m.uid from homehub_private.members m where m.household=household_id order by m.uid limit 1))
        where h.id=household_id;
    when 'invite' then
      code := replace(gen_random_uuid()::text,'-','');
      expiration := date_trunc('milliseconds',clock_timestamp() + interval '24 hours');
      insert into homehub_private.invitations values(household_id,sha256(convert_to(code,'UTF8')),expiration)
        on conflict(household) do update set digest=excluded.digest,expires=excluded.expires;
      result := jsonb_build_object('code',code,'expires',floor(extract(epoch from expiration)*1000));
    when 'revoke' then
      delete from homehub_private.invitations where household=household_id;
    when 'role','remove' then
      if p_record=actor then return '{"status":400,"error":"Choose another member."}'; end if;
      if p_operation='role' then
        update homehub_private.members set role=p_body->>'role' where household=household_id and uid=p_record;
        get diagnostics changed = row_count;
      else
        update homehub_private.tasks set assignee=null where household=household_id and assignee=p_record;
        update homehub_private.households set buyer=null where id=household_id and buyer=p_record;
        delete from homehub_private.members where household=household_id and uid=p_record;
        get diagnostics changed = row_count;
        if changed=1 then
          removed_uid := p_record;
          delete from homehub_private.invitations where household=household_id;
        end if;
      end if;
    else
      return '{"status":404,"error":"Action unavailable."}';
    end case;
    if changed=0 then return '{"status":404,"error":"This record is unavailable or has already changed."}'; end if;
  end if;
  insert into public.homehub_events(uid)
    select m.uid from homehub_private.members m join auth.users u on u.id=m.uid where m.household=household_id
    union select u.id from auth.users u where u.id=removed_uid
    order by 1
    on conflict(uid) do update set revision=gen_random_uuid();
  return result;
exception
  when foreign_key_violation then return '{"status":400,"error":"The selected member or contact is unavailable."}';
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
    return '{"status":400,"error":"Check the fields and try again."}';
end;
$$;
revoke all on function public.homehub(text,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.homehub(text,uuid,uuid,jsonb) to authenticated;
commit;
