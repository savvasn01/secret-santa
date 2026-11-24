-- Secret Santa: run this once in Supabase SQL Editor.
-- Participants use anonymous sign-in; only the game owner can appoint admins.
create extension if not exists pgcrypto;

create table public.games (
  id uuid primary key default gen_random_uuid(),
  invite_code text not null unique check (invite_code ~ '^[A-Z0-9]{8}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Тайный Санта',
  capacity integer not null check (capacity between 3 and 100),
  budget integer not null check (budget >= 100),
  is_drawn boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 32),
  created_at timestamptz not null default now(),
  unique (game_id, user_id),
  unique (game_id, name)
);

create table public.wishes (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 300)
);

create table public.game_admins (
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (game_id, user_id)
);

create table public.assignments (
  game_id uuid not null references public.games(id) on delete cascade,
  giver_id uuid not null references public.participants(id) on delete cascade,
  recipient_id uuid not null references public.participants(id) on delete cascade,
  primary key (game_id, giver_id),
  unique (game_id, recipient_id),
  check (giver_id <> recipient_id)
);

-- Security helpers. SECURITY DEFINER avoids circular row-security checks.
create or replace function public.is_game_owner(game uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.games where id = game and owner_id = auth.uid());
$$;
create or replace function public.is_game_admin(game uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_game_owner(game) or exists
    (select 1 from public.game_admins where game_id = game and user_id = auth.uid());
$$;
create or replace function public.is_game_member(game uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.participants where game_id = game and user_id = auth.uid());
$$;

alter table public.games enable row level security;
alter table public.participants enable row level security;
alter table public.wishes enable row level security;
alter table public.game_admins enable row level security;
alter table public.assignments enable row level security;

-- The public may read a game only by its unguessable eight-character invitation code.
-- Its rows do not contain wishes or pairings.
create policy "read game metadata" on public.games for select to authenticated using (true);
create policy "create a game" on public.games for insert to authenticated with check (owner_id = auth.uid());
create policy "owner or admin edits game" on public.games for update to authenticated using (public.is_game_admin(id)) with check (public.is_game_admin(id));

create policy "members see participant names" on public.participants for select to authenticated using (public.is_game_member(game_id) or public.is_game_admin(game_id));
create policy "join once as yourself" on public.participants for insert to authenticated with check (user_id = auth.uid() and not exists (select 1 from public.games where id = game_id and is_drawn));
create policy "owner can remove participant" on public.participants for delete to authenticated using (public.is_game_owner(game_id));

-- Wishes never go to ordinary participants, including after the draw.
create policy "admins read wishes" on public.wishes for select to authenticated using (public.is_game_admin(game_id));
create policy "participant writes own wish" on public.wishes for insert to authenticated with check (
  exists (select 1 from public.participants p where p.id = participant_id and p.user_id = auth.uid())
);

create policy "admins can read admin list" on public.game_admins for select to authenticated using (public.is_game_admin(game_id) or user_id = auth.uid());
create policy "only owner appoints admins" on public.game_admins for insert to authenticated with check (public.is_game_owner(game_id));
create policy "only owner removes admins" on public.game_admins for delete to authenticated using (public.is_game_owner(game_id));

-- An ordinary participant sees only their own recipient. Admins see all results.
create policy "private assignments" on public.assignments for select to authenticated using (
  public.is_game_admin(game_id) or exists (
    select 1 from public.participants p where p.id = giver_id and p.user_id = auth.uid()
  )
);

create or replace function public.reject_join_when_closed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select is_drawn from public.games where id = new.game_id) then
    raise exception 'Registration is closed';
  end if;
  if (select count(*) from public.participants where game_id = new.game_id) >=
     (select capacity from public.games where id = new.game_id) then
    raise exception 'There are no free places left';
  end if;
  return new;
end;
$$;
create trigger reject_join_when_full before insert on public.participants
for each row execute function public.reject_join_when_closed();

-- Start the draw transactionally as soon as the last participant joins.
create or replace function public.run_draw_when_full()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  total integer; cap integer; giver_ids uuid[]; recipient_ids uuid[]; attempt integer := 0;
begin
  select count(*), max(g.capacity) into total, cap from public.participants p join public.games g on g.id=p.game_id where p.game_id=new.game_id;
  if (select count(*) from public.wishes where game_id=new.game_id) <> total then return new; end if;
  if total <> cap or (select is_drawn from public.games where id=new.game_id) then return new; end if;
  select array_agg(id order by random()) into giver_ids from public.participants where game_id=new.game_id;
  loop
    select array_agg(id order by random()) into recipient_ids from public.participants where game_id=new.game_id;
    exit when not exists (select 1 from unnest(giver_ids, recipient_ids) as x(giver_id, recipient_id) where giver_id=recipient_id);
    attempt := attempt + 1;
    if attempt > 100 then raise exception 'Could not generate a valid draw'; end if;
  end loop;
  insert into public.assignments(game_id,giver_id,recipient_id)
    select new.game_id, x.giver_id, x.recipient_id from unnest(giver_ids, recipient_ids) as x(giver_id, recipient_id);
  update public.games set is_drawn=true where id=new.game_id;
  return new;
end;
$$;
create trigger automatically_draw_secret_santa after insert on public.wishes
for each row execute function public.run_draw_when_full();

create or replace function public.validate_game_change()
returns trigger language plpgsql as $$
begin
  if new.capacity < (select count(*) from public.participants where game_id = new.id) then
    raise exception 'Capacity cannot be lower than the number of registered participants';
  end if;
  if old.is_drawn and (new.capacity <> old.capacity or new.budget <> old.budget) then
    raise exception 'Game settings cannot be changed after the draw';
  end if;
  return new;
end;
$$;
create trigger validate_game_settings before update on public.games
for each row execute function public.validate_game_change();

-- Needed for live updates in the browser.
alter table public.games replica identity full;
alter table public.participants replica identity full;
alter table public.wishes replica identity full;
alter table public.assignments replica identity full;
alter table public.game_admins replica identity full;
alter publication supabase_realtime add table public.games, public.participants, public.wishes, public.assignments, public.game_admins;
