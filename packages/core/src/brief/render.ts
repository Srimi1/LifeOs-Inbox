import type { BriefFacts } from './facts.ts';
import { describeStreakGroup } from './streaks.ts';

/**
 * Rendering is templates and nothing else.
 *
 * Every value below is interpolated from the facts object. There is no model
 * in this file and there is not meant to be one: when a generative lede is
 * added in a later week it gets the facts and is forbidden from emitting
 * digits, so the worst a bad prompt can do is write an awkward sentence rather
 * than a wrong number.
 */
const TZ = 'Asia/Kolkata';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dayFmt = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: TZ,
});

const headerFmt = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: TZ,
});

export function money(n?: number): string {
  return typeof n === 'number' ? inr.format(n) : '—';
}

export function day(isoDate: string): string {
  return dayFmt.format(new Date(`${isoDate}T12:00:00Z`));
}

/** Truncate on a word boundary so a title never breaks mid-token. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd() + '…';
}

function relative(days: number): string {
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export function renderSubject(f: BriefFacts): string {
  const prefix = f.sync.alert ? '[LifeOS ALERT] ' : '';
  const parts: string[] = [];
  if (f.actNow.length) parts.push(`${f.actNow.length} need${f.actNow.length === 1 ? 's' : ''} you`);
  if (f.billTotal > 0) parts.push(`${money(f.billTotal)} due`);
  if (!parts.length) parts.push('all clear');
  return `${prefix}LifeOS — ${parts.join(' · ')}`;
}

export function renderText(f: BriefFacts): string {
  const L: string[] = [];
  const date = headerFmt.format(new Date(f.generatedAt));

  L.push(`LifeOS Inbox — ${date}`);

  // The opening line is the whole pitch: a small number of real things,
  // against the volume they were buried in.
  const buried = f.counts.total - f.actNow.length;
  L.push(
    f.actNow.length
      ? `${f.actNow.length} thing${f.actNow.length === 1 ? '' : 's'} need you. ${buried} others do not.`
      : `Nothing needs you. ${f.counts.total} signals processed.`,
  );

  if (f.sync.alert) {
    L.push('');
    L.push(`!! ${f.sync.alert}`);
    L.push('   Everything below may be out of date.');
  }

  if (f.actNow.length) {
    L.push('');
    L.push('ACT NOW');
    for (const a of f.actNow) {
      const amt = a.amount ? ` — ${money(a.amount)}` : '';
      L.push(`  * ${a.title}${amt}`);
      if (a.detail) L.push(`    ${a.detail}`);
    }
  }

  if (f.bills.length) {
    L.push('');
    L.push(
      `MONEY — ${f.bills.length} bill${f.bills.length === 1 ? '' : 's'}, ` +
        `${money(f.billTotal)} over the next ${f.billWindowDays} days`,
    );
    const labels = f.bills.map((b) => `${b.label}${b.cardLast4 ? ` ····${b.cardLast4}` : ''}`);
    const labelWidth = Math.max(...labels.map((l) => l.length));
    const amountWidth = Math.max(...f.bills.map((b) => money(b.amount).length));
    f.bills.forEach((b, i) => {
      L.push(
        `  ${labels[i].padEnd(labelWidth)}  ${money(b.amount).padStart(amountWidth)}` +
          `  ${day(b.dueDate)} (${relative(b.daysUntil)})`,
      );
    });
  }

  if (f.deadlines.length) {
    L.push('');
    L.push('DEADLINES');
    for (const d of f.deadlines.slice(0, 6)) {
      L.push(`  ${day(d.date)}  ${clip(d.title, 64)}`);
      L.push(`            ${relative(d.daysUntil)} · from ${d.source}`);
    }
  }

  if (f.loops.length) {
    L.push('');
    L.push('WAITING ON');
    for (const l of f.loops) {
      const dir = l.direction === 'i_owe_reply' ? 'you owe a reply' : 'silent';
      // A bouncing counterparty is not merely slow; a nudge would not land.
      const tail = l.dead ? '  ← dead channel, use another route' : l.pastThreshold ? '  ← nudge' : '';
      L.push(`  ${l.counterparty}${l.ticketId ? ` (#${l.ticketId})` : ''} — ${l.daysSilent}d ${dir}${tail}`);
    }
  }

  const quiet: string[] = [];
  if (f.streaks.length) quiet.push(`  ${describeStreakGroup(f.streaks)}`);
  if (f.noise.suppressed) {
    const top = f.noise.topSenders.map((s) => `${s.sender} ×${s.count}`).join(', ');
    quiet.push(`  ${f.noise.suppressed} promotional emails filed${top ? ` — ${top}` : ''}`);
  }
  if (f.counts.notYours) quiet.push(`  ${f.counts.notYours} not yours, excluded from your money picture`);
  if (f.counts.needsCardConfirmation) {
    quiet.push(`  ${f.counts.needsCardConfirmation} unrecognised card — confirm it is yours`);
  }
  if (f.counts.unresolved) quiet.push(`  ${f.counts.unresolved} unclassified, waiting for review`);

  if (quiet.length) {
    L.push('');
    L.push('HANDLED QUIETLY');
    L.push(...quiet);
  }

  L.push('');
  L.push(
    f.sync.lastSyncAt
      ? `synced ${f.sync.ageMinutes}m ago · ${f.counts.total} signals`
      : `never synced · ${f.counts.total} signals`,
  );

  return L.join('\n');
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Email HTML: inline styles only, no external assets, no web fonts. Mail
 * clients strip stylesheets and block remote content, and a brief that renders
 * as unstyled soup is a brief that stops being read.
 */
export function renderHtml(f: BriefFacts): string {
  const date = headerFmt.format(new Date(f.generatedAt));
  const P = {
    ink: '#16181F',
    dim: '#6E7383',
    rule: '#E3E2DE',
    pen: '#2547E8',
    due: '#B3730B',
    breach: '#B8332A',
    paper: '#FAF9F6',
    card: '#FFFFFF',
  };
  const mono = "ui-monospace,SFMono-Regular,Menlo,'Courier New',monospace";
  const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const H: string[] = [];

  const section = (title: string, color: string) =>
    `<div style="font:600 11px ${mono};letter-spacing:.12em;text-transform:uppercase;color:${color};margin:26px 0 8px">${esc(title)}</div>`;

  const row = (inner: string, accent: string) =>
    `<div style="border-left:3px solid ${accent};padding:8px 0 8px 12px;margin-bottom:6px">${inner}</div>`;

  H.push(
    `<div style="background:${P.paper};padding:24px 0"><div style="max-width:600px;margin:0 auto;background:${P.card};border:1px solid ${P.rule};border-radius:10px;padding:26px 28px;font:15px/1.55 ${sans};color:${P.ink}">`,
  );

  H.push(
    `<div style="font:600 11px ${mono};letter-spacing:.14em;text-transform:uppercase;color:${P.pen}">LifeOS Inbox</div>`,
    `<div style="font-size:20px;font-weight:600;margin:2px 0 4px">${esc(date)}</div>`,
  );

  const buried = f.counts.total - f.actNow.length;
  H.push(
    `<div style="color:${P.dim};font-size:15px">${
      f.actNow.length
        ? `${f.actNow.length} thing${f.actNow.length === 1 ? '' : 's'} need you. ${buried} others do not.`
        : `Nothing needs you. ${f.counts.total} signals processed.`
    }</div>`,
  );

  if (f.sync.alert) {
    H.push(
      `<div style="margin-top:16px;background:#FBE9E7;border:1px solid ${P.breach};border-radius:6px;padding:10px 12px;color:${P.breach};font-size:14px"><b>${esc(f.sync.alert)}</b><br>Everything below may be out of date.</div>`,
    );
  }

  if (f.actNow.length) {
    H.push(section('Act now', P.breach));
    for (const a of f.actNow) {
      const amt = a.amount ? ` — <b>${esc(money(a.amount))}</b>` : '';
      H.push(
        row(
          `<div style="font-weight:600">${esc(a.title)}${amt}</div>` +
            (a.detail ? `<div style="color:${P.dim};font:12px ${mono};margin-top:2px">${esc(a.detail)}</div>` : ''),
          P.breach,
        ),
      );
    }
  }

  if (f.bills.length) {
    H.push(section(`Money — ${money(f.billTotal)} over ${f.billWindowDays} days`, P.due));
    H.push(`<table style="width:100%;border-collapse:collapse;font-size:14px">`);
    for (const b of f.bills) {
      const tail = b.cardLast4 ? `<span style="color:${P.dim}"> ····${b.cardLast4}</span>` : '';
      H.push(
        `<tr>` +
          `<td style="padding:6px 0;border-bottom:1px solid ${P.rule}">${esc(b.label)}${tail}</td>` +
          `<td style="padding:6px 0;border-bottom:1px solid ${P.rule};text-align:right;font-family:${mono};font-weight:600">${esc(money(b.amount))}</td>` +
          `<td style="padding:6px 0 6px 14px;border-bottom:1px solid ${P.rule};text-align:right;color:${P.dim};font:12px ${mono};white-space:nowrap">${esc(day(b.dueDate))} · ${esc(relative(b.daysUntil))}</td>` +
          `</tr>`,
      );
    }
    H.push(`</table>`);
  }

  if (f.deadlines.length) {
    H.push(section('Deadlines', P.pen));
    for (const d of f.deadlines.slice(0, 6)) {
      H.push(
        row(
          `<div>${esc(clip(d.title, 88))}</div>` +
            `<div style="color:${P.dim};font:12px ${mono};margin-top:2px">${esc(day(d.date))} · ${esc(relative(d.daysUntil))} · ${esc(d.source)}</div>`,
          P.pen,
        ),
      );
    }
  }

  if (f.loops.length) {
    H.push(section('Waiting on', P.pen));
    for (const l of f.loops) {
      const dir = l.direction === 'i_owe_reply' ? 'you owe a reply' : 'silent';
      const tail = l.dead
        ? ' · dead channel — a nudge would not arrive'
        : l.pastThreshold
          ? ' · worth a nudge'
          : '';
      H.push(
        row(
          `<div>${esc(l.counterparty)}${l.ticketId ? ` <span style="color:${P.dim}">#${esc(l.ticketId)}</span>` : ''}</div>` +
            `<div style="color:${P.dim};font:12px ${mono};margin-top:2px">${l.daysSilent}d ${dir}${tail}</div>`,
          l.dead ? P.breach : l.pastThreshold ? P.due : P.rule,
        ),
      );
    }
  }

  const quiet: string[] = [];
  if (f.streaks.length) quiet.push(esc(describeStreakGroup(f.streaks)));
  if (f.noise.suppressed) {
    const top = f.noise.topSenders.map((s) => `${s.sender} ×${s.count}`).join(', ');
    quiet.push(`${f.noise.suppressed} promotional emails filed${top ? ` — ${esc(top)}` : ''}`);
  }
  if (f.counts.notYours) quiet.push(`${f.counts.notYours} not yours, excluded from your money picture`);
  if (f.counts.needsCardConfirmation) {
    quiet.push(`${f.counts.needsCardConfirmation} unrecognised card — confirm it is yours`);
  }
  if (f.counts.unresolved) quiet.push(`${f.counts.unresolved} unclassified, waiting for review`);

  if (quiet.length) {
    H.push(section('Handled quietly', P.dim));
    H.push(
      `<ul style="margin:0;padding-left:18px;color:${P.dim};font-size:13px">${quiet.map((q) => `<li style="margin-bottom:4px">${q}</li>`).join('')}</ul>`,
    );
  }

  H.push(
    `<div style="margin-top:24px;padding-top:12px;border-top:1px solid ${P.rule};color:${P.dim};font:11px ${mono}">${
      f.sync.lastSyncAt ? `synced ${f.sync.ageMinutes}m ago` : 'never synced'
    } · ${f.counts.total} signals · every figure above is quoted from a source email</div>`,
  );

  H.push('</div></div>');
  return H.join('');
}
