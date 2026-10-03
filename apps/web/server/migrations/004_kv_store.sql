-- Run once in the Supabase project's SQL editor (the same project as 001 to 003). No chain changes.
-- Rebuildable, non-critical server data moved out of Redis to save its command quota: price history
-- (flurbo:prices:*), the trade history index (flurbo:pilot:index:*), the payout index (flurbo:pilot:payouts:*)
-- and operator metrics (flurbo:metrics:*). Sessions, agents, wallet links, settlement state and email dedupe stay
-- in Redis. The server reaches these tables only through public.flurbo_kv, with the service role key; members and
-- the browser never do.
begin;

create table if not exists public.flurbo_kv (
  key text primary key,
  value text not null,
  expires_at timestamptz
);
create table if not exists public.flurbo_kv_hash (
  key text not null,
  field text not null,
  value text not null,
  primary key (key, field)
);
create table if not exists public.flurbo_kv_zset (
  key text not null,
  member text not null,
  score double precision not null,
  primary key (key, member)
);
create index if not exists flurbo_kv_zset_by_score on public.flurbo_kv_zset (key, score);
alter table public.flurbo_kv enable row level security;
alter table public.flurbo_kv_hash enable row level security;
alter table public.flurbo_kv_zset enable row level security;
revoke all on public.flurbo_kv, public.flurbo_kv_hash, public.flurbo_kv_zset from public, anon, authenticated;

-- One entry point with the few operations those modules use. Values are text, as in Redis.
create or replace function public.flurbo_kv(p_op text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k text := p_args->>'key';
  v text;
  n integer := 0;
  total integer;
  i integer;
  first_index integer;
  last_index integer;
  bucket double precision;
  inserted boolean;
  result jsonb;
begin
  if p_op = 'get' then
    select value into v from flurbo_kv where key = k and (expires_at is null or expires_at > now());
    return to_jsonb(v);

  elsif p_op = 'mget' then
    select coalesce(jsonb_agg(to_jsonb(kv.value) order by wanted.ord), '[]'::jsonb) into result
    from jsonb_array_elements_text(p_args->'keys') with ordinality as wanted(key, ord)
    left join flurbo_kv kv on kv.key = wanted.key and (kv.expires_at is null or kv.expires_at > now());
    return result;

  elsif p_op = 'set' then
    delete from flurbo_kv where key = k and expires_at is not null and expires_at <= now();
    if coalesce((p_args->>'nx')::boolean, false) then
      insert into flurbo_kv (key, value, expires_at)
      values (k, p_args->>'value', case when p_args ? 'ex' then now() + make_interval(secs => (p_args->>'ex')::integer) end)
      on conflict (key) do nothing;
      get diagnostics n = row_count;
      return case when n = 1 then to_jsonb('OK'::text) else null end;
    end if;
    insert into flurbo_kv (key, value, expires_at)
    values (k, p_args->>'value', case when p_args ? 'ex' then now() + make_interval(secs => (p_args->>'ex')::integer) end)
    on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at;
    return to_jsonb('OK'::text);

  elsif p_op = 'del' then
    select count(*) into n from (
      select key from flurbo_kv where key in (select jsonb_array_elements_text(p_args->'keys'))
        and (expires_at is null or expires_at > now())
      union select key from flurbo_kv_hash where key in (select jsonb_array_elements_text(p_args->'keys'))
      union select key from flurbo_kv_zset where key in (select jsonb_array_elements_text(p_args->'keys'))) existing;
    delete from flurbo_kv where key in (select jsonb_array_elements_text(p_args->'keys'));
    delete from flurbo_kv_hash where key in (select jsonb_array_elements_text(p_args->'keys'));
    delete from flurbo_kv_zset where key in (select jsonb_array_elements_text(p_args->'keys'));
    return to_jsonb(n);

  elsif p_op = 'hset' then
    for i in 0 .. jsonb_array_length(p_args->'pairs') / 2 - 1 loop
      insert into flurbo_kv_hash (key, field, value) values (k, p_args->'pairs'->>(2 * i), p_args->'pairs'->>(2 * i + 1))
      on conflict (key, field) do update set value = excluded.value
      returning (xmax = 0) into inserted;
      if inserted then n := n + 1; end if;
    end loop;
    return to_jsonb(n);

  elsif p_op = 'hsetnx' then
    insert into flurbo_kv_hash (key, field, value) values (k, p_args->>'field', p_args->>'value') on conflict (key, field) do nothing;
    get diagnostics n = row_count;
    return to_jsonb(n);

  elsif p_op = 'hget' then
    select value into v from flurbo_kv_hash where key = k and field = p_args->>'field';
    return to_jsonb(v);

  elsif p_op = 'hgetall' then
    select coalesce(jsonb_agg(item order by field, pos), '[]'::jsonb) into result
    from flurbo_kv_hash h, lateral (values (1, to_jsonb(h.field)), (2, to_jsonb(h.value))) as pair(pos, item)
    where h.key = k;
    return result;

  elsif p_op = 'hmget' then
    select coalesce(jsonb_agg(to_jsonb(h.value) order by wanted.ord), '[]'::jsonb) into result
    from jsonb_array_elements_text(p_args->'fields') with ordinality as wanted(field, ord)
    left join flurbo_kv_hash h on h.key = k and h.field = wanted.field;
    return result;

  elsif p_op = 'zadd' then
    for i in 0 .. jsonb_array_length(p_args->'pairs') / 2 - 1 loop
      insert into flurbo_kv_zset (key, score, member) values (k, (p_args->'pairs'->>(2 * i))::double precision, p_args->'pairs'->>(2 * i + 1))
      on conflict (key, member) do update set score = excluded.score
      returning (xmax = 0) into inserted;
      if inserted then n := n + 1; end if;
    end loop;
    return to_jsonb(n);

  elsif p_op = 'zrange' then
    -- Redis index rules: negative indexes count from the end; out-of-range indexes are clamped.
    select count(*) into total from flurbo_kv_zset where key = k;
    first_index := (p_args->>'start')::integer; last_index := (p_args->>'stop')::integer;
    if first_index < 0 then first_index := greatest(total + first_index, 0); end if;
    if last_index < 0 then last_index := total + last_index; end if;
    last_index := least(last_index, total - 1);
    if total = 0 or first_index > last_index then return '[]'::jsonb; end if;
    select coalesce(jsonb_agg(to_jsonb(member) order by score, member), '[]'::jsonb) into result
    from (select member, score from flurbo_kv_zset where key = k order by score, member offset first_index limit last_index - first_index + 1) ranged;
    return result;

  elsif p_op = 'price_append' then
    -- Same effect as price-history.mjs appendPriceSample: the first sample per bucket wins, 30 days, 288 at most.
    bucket := (p_args->>'score')::double precision;
    perform pg_advisory_xact_lock(hashtext('flurbo_kv_zset:' || k));
    if not exists (select 1 from flurbo_kv_zset z where z.key = k and z.score = bucket) then
      insert into flurbo_kv_zset (key, score, member) values (k, bucket, p_args->>'member') on conflict (key, member) do nothing;
    end if;
    delete from flurbo_kv_zset z where z.key = k and z.score < bucket - 2592000;
    delete from flurbo_kv_zset where key = k and member in (
      select member from flurbo_kv_zset where key = k order by score desc, member desc offset 288);
    select coalesce(jsonb_agg(to_jsonb(member) order by score, member), '[]'::jsonb) into result
    from (select member, score from flurbo_kv_zset where key = k order by score desc, member desc limit 288) newest;
    return result;

  elsif p_op = 'cas' then
    -- Same effect as the index compare-and-swap scripts: write only if the stored value is still the expected one.
    select value into v from flurbo_kv where key = k for update;
    if v is null then
      if coalesce(p_args->>'expected', '') <> '' then return to_jsonb(0); end if;
      insert into flurbo_kv (key, value) values (k, p_args->>'value') on conflict (key) do nothing;
      get diagnostics n = row_count;
      return to_jsonb(n);
    end if;
    if v <> coalesce(p_args->>'expected', '') then return to_jsonb(0); end if;
    update flurbo_kv set value = p_args->>'value', expires_at = null where key = k;
    return to_jsonb(1);
  end if;
  raise exception 'Unsupported flurbo_kv operation';
end;
$$;

revoke all on function public.flurbo_kv(text, jsonb) from public, anon, authenticated;
grant execute on function public.flurbo_kv(text, jsonb) to service_role;
commit;
