-- Partners & Platforms on the landing page, managed by admins in Admin → Partners.
-- Everyone can read the active rows; only admins (is_admin) can add, edit, reorder, hide or delete.
-- logo: an https URL or a small data:image/... URL (PNG, WebP, JPEG or SVG, at most ~100 KB) shown in an <img>, so an SVG cannot run script.
create table if not exists public.partners (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 40),
  kind        text not null check (kind in ('broker', 'platform')),
  url         text not null check (url ~ '^https://[^\s"<>]+$' and char_length(url) <= 300),
  role_en     text check (char_length(role_en) <= 80),
  role_km     text check (char_length(role_km) <= 120),
  logo        text check (logo is null or (char_length(logo) <= 140000 and (logo ~ '^https://[^\s"<>]+$' or logo ~ '^data:image/(png|webp|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$'))),
  svg_path    text check (svg_path is null or (char_length(svg_path) <= 6000 and svg_path ~ '^[0-9A-Za-z .,\-]+$')),
  color       text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  sort        int not null default 100,
  active      boolean not null default true,
  updated_at  timestamptz not null default now(),
  unique (name)
);
alter table public.partners enable row level security;
drop policy if exists partners_read on public.partners;
create policy partners_read on public.partners for select using (active or public.is_admin(auth.uid()));
drop policy if exists partners_admin_ins on public.partners;
create policy partners_admin_ins on public.partners for insert to authenticated with check (public.is_admin(auth.uid()));
drop policy if exists partners_admin_upd on public.partners;
create policy partners_admin_upd on public.partners for update to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
drop policy if exists partners_admin_del on public.partners;
create policy partners_admin_del on public.partners for delete to authenticated using (public.is_admin(auth.uid()));
grant select on public.partners to anon, authenticated;
grant insert, update, delete on public.partners to authenticated;

insert into public.partners (name, kind, url, role_en, role_km, svg_path, color, sort) values
('Exness', 'broker', 'https://www.exness.com', 'Forex & gold broker', 'ឈ្មួញកណ្តាល Forex និងមាស', null, null, 10),
('Dupoin', 'broker', 'https://www.dupoin.com', 'Forex & gold broker', 'ឈ្មួញកណ្តាល Forex និងមាស', null, null, 20),
('HFM', 'broker', 'https://www.hfm.com', 'Forex & gold broker', 'ឈ្មួញកណ្តាល Forex និងមាស', null, null, 30),
('TradingView', 'platform', 'https://www.tradingview.com', 'Live market prices', 'តម្លៃទីផ្សារផ្ទាល់', 'M15.8654 8.2789c0 1.3541-1.0978 2.4519-2.452 2.4519-1.354 0-2.4519-1.0978-2.4519-2.452 0-1.354 1.0978-2.4518 2.452-2.4518 1.3541 0 2.4519 1.0977 2.4519 2.4519zM9.75 6H0v4.9038h4.8462v7.2692H9.75Zm8.5962 0H24l-5.1058 12.173h-5.6538z', '#EEF3F8', 40),
('Forex Factory', 'platform', 'https://www.forexfactory.com', 'Economic calendar', 'ប្រតិទិនសេដ្ឋកិច្ច', null, null, 50),
('Supabase', 'platform', 'https://supabase.com', 'Database · auth · bots', 'មូលដ្ឋានទិន្នន័យ · ចូលគណនី · Bot', 'M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z', '#3FCF8E', 60),
('Vercel', 'platform', 'https://vercel.com', 'Hosting · price API', 'Hosting · API តម្លៃ', 'm12 1.608 12 20.784H0Z', '#EEF3F8', 70),
('Telegram', 'platform', 'https://telegram.org', 'AI signal & news alerts', 'សញ្ញា AI និងការជូនដំណឹងព័ត៌មាន', 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z', '#26A5E4', 80),
('GitHub', 'platform', 'https://github.com', 'Code & deploys', 'កូដ និងការ deploy', 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12', '#EEF3F8', 90),
('Hostinger', 'platform', 'https://www.hostinger.com', 'Web services', 'សេវាវេប', 'M16.415 0v7.16l5.785 3.384V2.949L16.415 0ZM1.8 0v11.237h18.815L14.89 8.09l-7.457-.003V3.024L1.8 0Zm14.615 20.894v-5.019l-7.514-.005c.007.033-5.82-3.197-5.82-3.197l19.119.091V24l-5.785-3.106ZM1.8 13.551v7.343l5.633 2.949v-6.988L1.8 13.551Z', '#673DE6', 100)
on conflict do nothing;
