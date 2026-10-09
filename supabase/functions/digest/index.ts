// Ежедневная сводка календаря в Telegram.
// Cron вызывает функцию каждый час; сводка уходит один раз в день, когда в часовом поясе
// из bot_state (его обновляет сайт при заходе) наступает DIGEST_HOUR.
// Секреты (Edge Functions → Secrets): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CRON_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2';

const DIGEST_HOUR = 11;
const SITE_URL = 'https://dwightun.github.io/calendar/';

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const CHAT = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';
const SECRET = Deno.env.get('CRON_SECRET') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

type Item = {
  id: string; title: string; type: 'fact' | 'task'; start: string; end: string; note: string;
  done: boolean; repeat: string; until: string; doneDates: string[];
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (!SECRET || req.headers.get('x-cron-secret') !== SECRET) return json({ error: 'forbidden' }, 403);
  const force = new URL(req.url).searchParams.has('force');

  const { data: st } = await sb.from('bot_state').select('*').eq('id', 1).maybeSingle();
  const tz = st?.tz || 'UTC';
  const { date: today, hour } = localNow(tz);
  if (!force && (hour < DIGEST_HOUR || st?.last_digest === today)) return json({ skipped: true, tz, today, hour });

  const [ev, cd] = await Promise.all([
    sb.from('events').select('*'),
    sb.from('cards').select('status'),
  ]);
  if (ev.error) return json({ error: ev.error.message }, 500);
  const items: Item[] = ev.data.map((r) => ({
    id: r.id, title: r.title, type: r.type, start: r.start_date, end: r.end_date || '', note: r.note || '',
    done: r.done, repeat: r.repeat || '', until: r.repeat_until || '', doneDates: r.done_dates || [],
  }));
  const openCards = (cd.data ?? []).filter((c) => c.status !== 'done').length;

  const text = buildDigest(items, today, openCards);
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  });
  if (!r.ok) return json({ error: await r.text() }, 502);
  if (!force) await sb.from('bot_state').update({ last_digest: today }).eq('id', 1);
  return json({ sent: true, tz, today });
});

function localNow(tz: string) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch {
    return localNow('UTC');
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

/* ---------- повторы: та же логика, что на сайте ---------- */
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => {
  const x = new Date(Date.UTC(y, m, d));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
};
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const dn = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
const fromDn = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
const weekday = (s: string) => new Date(dn(s) * 864e5).getUTCDay();
const lastDay = (i: Item) => i.end || i.start;
const durOf = (i: Item) => (i.end ? dn(i.end) - dn(i.start) : 0);

function nthWeekday(y: number, m: number, wd: number, n: number) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const day = 1 + (wd - first + 7) % 7 + (n - 1) * 7;
    return day <= daysIn(y, m) ? iso(y, m, day) : null;
  }
  const last = daysIn(y, m), lw = new Date(Date.UTC(y, m, last)).getUTCDay();
  return iso(y, m, last - (lw - wd + 7) % 7);
}
function occInMonth(i: Item, y: number, m: number) {
  const sd = +i.start.slice(8, 10), wd = weekday(i.start);
  if (i.repeat === 'monthly') return iso(y, m, Math.min(sd, daysIn(y, m)));
  if (i.repeat === 'monthly_nth') return nthWeekday(y, m, wd, Math.ceil(sd / 7));
  if (i.repeat === 'monthly_last') return nthWeekday(y, m, wd, -1);
  if (i.repeat === 'yearly') {
    const sm = +i.start.slice(5, 7) - 1;
    return sm === m ? iso(y, m, Math.min(sd, daysIn(y, m))) : null;
  }
  return null;
}
function occStart(i: Item, d: string): string | null {
  if (d < i.start) return null;
  if (!i.repeat) return d <= lastDay(i) ? i.start : null;
  const dur = durOf(i), D = dn(d);
  let occ: string | null = null;
  if (i.repeat === 'weekly' || i.repeat === 'biweekly') {
    const off = (D - dn(i.start)) % (i.repeat === 'weekly' ? 7 : 14);
    if (off <= dur) occ = fromDn(D - off);
  } else {
    const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1;
    const back = i.repeat === 'yearly' ? [[y, m], [y - 1, m]] : [[y, m], [y, m - 1]];
    for (const [yy, mm] of back) {
      const x = new Date(Date.UTC(yy, mm, 1));
      const c = i.repeat === 'yearly'
        ? occInMonth(i, yy, +i.start.slice(5, 7) - 1)
        : occInMonth(i, x.getUTCFullYear(), x.getUTCMonth());
      if (c && c >= i.start && c <= d && D - dn(c) <= dur) { occ = c; break; }
    }
  }
  if (occ && i.until && occ > i.until) return null;
  return occ;
}
const isDone = (i: Item, occ: string) => (i.repeat ? i.doneDates.includes(occ) : !!i.done);

/* ---------- текст сводки ---------- */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (s: string, o: Intl.DateTimeFormatOptions) =>
  new Date(dn(s) * 864e5).toLocaleDateString('ru-RU', { ...o, timeZone: 'UTC' });
const short = (s: string) => fmt(s, { day: 'numeric', month: 'short' });

function itemsOn(items: Item[], d: string) {
  return items
    .map((i) => ({ i, occ: occStart(i, d) }))
    .filter((e): e is { i: Item; occ: string } => !!e.occ)
    .sort((a, b) => (a.i.type === b.i.type ? 0 : a.i.type === 'task' ? 1 : -1) || a.i.title.localeCompare(b.i.title));
}

function line({ i, occ }: { i: Item; occ: string }, day: string) {
  const mark = i.type === 'task' ? (isDone(i, occ) ? '☑' : '☐') : '◆';
  const dur = durOf(i);
  const span = dur > 0
    ? ` <i>(${dn(day) - dn(occ) + 1}-й день из ${dur + 1}, до ${short(fromDn(dn(occ) + dur))})</i>`
    : '';
  const note = i.note ? `\n    <i>${esc(i.note.length > 90 ? i.note.slice(0, 90) + '…' : i.note)}</i>` : '';
  return `${mark} ${esc(i.title)}${i.repeat ? ' ↻' : ''}${span}${note}`;
}

function buildDigest(items: Item[], today: string, openCards: number) {
  const head = fmt(today, { weekday: 'long', day: 'numeric', month: 'long' });
  const out = [`☀️ <b>${head[0].toUpperCase() + head.slice(1)}</b>`];

  const todayList = itemsOn(items, today);
  out.push(todayList.length ? `\n<b>Сегодня</b>\n${todayList.map((e) => line(e, today)).join('\n')}` : '\nСегодня свободно 🌿');

  // Просроченные задачи: разовые — по последнему дню, повторяющиеся — незакрытые повторы за последний месяц.
  const T = dn(today), overdue: string[] = [];
  for (const i of items) {
    if (i.type !== 'task') continue;
    if (!i.repeat) {
      if (!i.done && lastDay(i) < today) overdue.push(`☐ ${esc(i.title)} <i>(${short(lastDay(i))})</i>`);
      continue;
    }
    for (let n = T - 1; n >= T - 31; n--) {
      const d = fromDn(n);
      if (occStart(i, d) === d && dn(d) + durOf(i) < T && !isDone(i, d)) { overdue.push(`☐ ${esc(i.title)} ↻ <i>(${short(d)})</i>`); break; }
    }
  }
  if (overdue.length) out.push(`\n<b>Просрочено</b>\n${overdue.join('\n')}`);

  const tomorrow = fromDn(T + 1);
  const tList = itemsOn(items, tomorrow).filter((e) => e.occ === tomorrow || e.i.type === 'task');
  if (tList.length) out.push(`\n<b>Завтра</b>: ${tList.map((e) => esc(e.i.title)).join(', ')}`);

  if (openCards) out.push(`\n📋 Без даты: ${openCards}`);
  out.push(`\n<a href="${SITE_URL}">Открыть календарь</a>`);
  return out.join('\n');
}
