-- Run once in the SEPARATE Supabase project's SQL editor. No chain changes.
begin;
create table if not exists public.flurbo_applications (
  account text primary key check (account ~ '^0x[0-9a-f]{40}$'),
  email text,
  state text not null default 'unverified' check (state in ('unverified','pending','approved','declined','revoked','withdrawn')),
  decision text check (decision in ('approved','declined','revoked')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision integer not null default 0,
  notice_version text,
  code_hash text,
  code_expires timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,
  send_day date,
  sends integer not null default 0,
  notification_id uuid,
  notification_at timestamptz,
  notified boolean not null default false
);
create table if not exists public.flurbo_access_audit (
  id bigint generated always as identity primary key,
  account text not null,
  operator text not null,
  decision text not null,
  at timestamptz not null default now()
);
create table if not exists public.flurbo_application_mail_days (
  day date primary key,
  attempts integer not null default 0
);
alter table public.flurbo_applications enable row level security;
alter table public.flurbo_access_audit enable row level security;
alter table public.flurbo_application_mail_days enable row level security;
revoke all on public.flurbo_applications, public.flurbo_access_audit, public.flurbo_application_mail_days from public, anon, authenticated;

create or replace function public.flurbo_application_view(a public.flurbo_applications)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('account',a.account,'email',a.email,'state',a.state,
    'verified',a.verified_at is not null,'createdAt',a.created_at,'revision',a.revision,
    'notification',case when a.notification_id is null then 'none' when a.notified then 'sent'
      when a.notification_at < now()-interval '23 hours' then 'needs_review' else 'pending' end);
$$;
revoke all on function public.flurbo_application_view(public.flurbo_applications) from public, anon, authenticated;

create or replace function public.flurbo_application(p_action text,p_account text,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.flurbo_applications;
  rows jsonb;
  n integer;
begin
  if p_account !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid account'; end if;
  if p_action='email_budget' then
    if (p_data->>'limit')::integer not between 1 and 5000 then raise exception 'invalid limit'; end if;
    insert into public.flurbo_application_mail_days(day,attempts) values(current_date,1)
      on conflict(day) do update set attempts=flurbo_application_mail_days.attempts+1 returning attempts into n;
    if n>(p_data->>'limit')::integer then return jsonb_build_object('status',429,'error','Application email capacity is reached for today. Please try tomorrow.'); end if;
    return '{}'::jsonb;
  end if;
  if p_action='list' then
    n := coalesce((p_data->>'offset')::integer,0);
    if n<0 or n>100000 then raise exception 'invalid page'; end if;
    select coalesce(jsonb_agg(public.flurbo_application_view(x)), '[]'::jsonb) into rows
      from (select * from public.flurbo_applications order by created_at desc,account limit 26 offset n) x;
    return jsonb_build_object('applications',rows,'offset',n);
  end if;
  -- Serializes mutations even when no row exists. Supports concurrent server instances.
  perform pg_advisory_xact_lock(hashtextextended(p_account,0));
  select * into a from public.flurbo_applications where account=p_account for update;
  if p_action='decision' then return jsonb_build_object('decision',a.decision); end if;
  if p_action='status' then return jsonb_build_object('application',case when a.account is null then null else public.flurbo_application_view(a) end); end if;
  if p_action='submit' then
    if a.state in ('approved','declined','revoked') then
      return jsonb_build_object('status',409,'error','This application already has a decision. Contact the team if it needs review.');
    end if;
    if a.state='pending' and a.email=p_data->>'email' then
      return jsonb_build_object('application',public.flurbo_application_view(a),'send',false);
    end if;
    if a.sent_at > now()-interval '1 minute' then return jsonb_build_object('status',429,'error','Wait one minute before requesting another code.'); end if;
    if a.send_day=current_date and a.sends>=5 then return jsonb_build_object('status',429,'error','Daily email limit reached. Try again tomorrow.'); end if;
    if length(p_data->>'email')>254 or p_data->>'codeHash' !~ '^[0-9a-f]{64}$' then raise exception 'invalid submission'; end if;
    insert into public.flurbo_applications(account,email,code_hash,code_expires,sent_at,send_day,sends,notice_version)
      values(p_account,p_data->>'email',p_data->>'codeHash',now()+interval '10 minutes',now(),current_date,1,p_data->>'noticeVersion')
    on conflict(account) do update set email=excluded.email,state='unverified',verified_at=null,
      code_hash=excluded.code_hash,code_expires=excluded.code_expires,attempts=0,sent_at=now(),send_day=current_date,
      sends=case when flurbo_applications.send_day=current_date then flurbo_applications.sends+1 else 1 end,
      notice_version=excluded.notice_version,updated_at=now(),revision=flurbo_applications.revision+1
    returning * into a;
    return jsonb_build_object('application',public.flurbo_application_view(a),'send',true);
  end if;
  if a.account is null then return jsonb_build_object('status',404,'error','Application not found.'); end if;
  if p_action='verify' then
    if a.state<>'unverified' or a.code_hash is null or a.code_expires<=now() or a.attempts>=5 then
      return jsonb_build_object('status',400,'error','This code is no longer available. Request a new code.');
    end if;
    update public.flurbo_applications set attempts=attempts+1 where account=p_account;
    if a.code_hash<>p_data->>'codeHash' then return jsonb_build_object('status',400,'error','The code did not match. Check your email and try again.'); end if;
    update public.flurbo_applications set state='pending',verified_at=now(),code_hash=null,code_expires=null,updated_at=now(),revision=revision+1
      where account=p_account returning * into a;
  elsif p_action='withdraw' then
    if a.decision='approved' then return jsonb_build_object('status',409,'error','Approved accounts cannot withdraw an application. Contact the team for account deletion.'); end if;
    update public.flurbo_applications set state='withdrawn',email=null,verified_at=null,code_hash=null,code_expires=null,
      notification_id=null,notification_at=null,updated_at=now(),revision=revision+1 where account=p_account returning * into a;
  elsif p_action='decide' then
    if a.revision<>(p_data->>'revision')::integer then return jsonb_build_object('status',409,'error','This application changed. Refresh before deciding.'); end if;
    if p_data->>'decision' not in ('approved','declined','revoked') or p_data->>'operator' !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid decision'; end if;
    if p_data->>'decision'='approved' and (a.verified_at is null or a.state='withdrawn') then return jsonb_build_object('status',409,'error','Verify the email before approving.'); end if;
    if a.decision=p_data->>'decision' then return jsonb_build_object('application',public.flurbo_application_view(a)); end if;
    update public.flurbo_applications set decision=p_data->>'decision',state=p_data->>'decision',updated_at=now(),revision=revision+1,
      code_hash=null,code_expires=null,
      notification_id=case when p_data->>'decision'='approved' then gen_random_uuid() else null end,
      notification_at=case when p_data->>'decision'='approved' then now() else null end,notified=false
      where account=p_account returning * into a;
    insert into public.flurbo_access_audit(account,operator,decision) values(p_account,p_data->>'operator',p_data->>'decision');
  elsif p_action='notification' then
    if a.decision<>'approved' or a.notification_id is null or a.notified then return '{}'::jsonb; end if;
    return jsonb_build_object('id',a.notification_id,'email',a.email,'expired',a.notification_at<now()-interval '23 hours');
  elsif p_action='notified' then
    update public.flurbo_applications set notified=true where account=p_account and notification_id=(p_data->>'id')::uuid;
    return '{}'::jsonb;
  else raise exception 'unknown action';
  end if;
  return jsonb_build_object('application',public.flurbo_application_view(a));
end;
$$;
revoke all on function public.flurbo_application(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.flurbo_application(text,text,jsonb) to service_role;
commit;
