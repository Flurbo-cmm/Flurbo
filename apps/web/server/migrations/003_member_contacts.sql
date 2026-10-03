-- Run once in the SEPARATE Supabase project's SQL editor, after 001 and 002. No chain changes.
-- Contact emails for position notices (payout ready, answer proposed, trading closing). Returns only
-- approved accounts with a verified email, and only for the accounts asked about (at most 500 per call).
begin;
create or replace function public.flurbo_member_contacts(p_accounts text[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('account', a.account, 'email', a.email)), '[]'::jsonb)
  from public.flurbo_applications a
  where a.account = any(p_accounts[1:500])
    and a.state = 'approved' and a.decision = 'approved'
    and a.verified_at is not null and a.email is not null;
$$;
revoke all on function public.flurbo_member_contacts(text[]) from public, anon, authenticated;
grant execute on function public.flurbo_member_contacts(text[]) to service_role;
commit;
