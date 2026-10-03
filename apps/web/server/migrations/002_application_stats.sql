-- Run once in the SEPARATE Supabase project's SQL editor, after 001. No chain changes.
-- Read-only statistics for the operator metrics page. Returns no email addresses.
begin;
create or replace function public.flurbo_application_stats()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'total', (select count(*) from public.flurbo_applications),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'account', a.account, 'state', a.state, 'decision', a.decision,
        'createdAt', a.created_at, 'verifiedAt', a.verified_at,
        'approvedAt', (select max(x.at) from public.flurbo_access_audit x where x.account = a.account and x.decision = 'approved'))
      order by a.created_at)
      from (select * from public.flurbo_applications order by created_at desc limit 5000) a), '[]'::jsonb));
$$;
revoke all on function public.flurbo_application_stats() from public, anon, authenticated;
grant execute on function public.flurbo_application_stats() to service_role;
commit;
