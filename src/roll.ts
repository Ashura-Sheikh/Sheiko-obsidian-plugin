// Phase 3: pure auto-roll logic. No Obsidian imports, so it can be unit-tested with Node.
//
// Rules (Build task, 2026-09-23):
// - At each day's cutoff (no weekend skipping), unfinished tasks scheduled on or
//   before that day get `scheduled` moved to the next day. `due` never moves (1a).
// - Tasks with no scheduled date aren't rolled; they're listed so they get a date.
// - In-review tasks roll too and are listed first (7a).

import { formatMinutes, localDateString, toLocalIso } from './lifecycle';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(.+))?$/;

export interface ParsedScheduled {
	/** YYYY-MM-DD */
	date: string;
	/** Everything after the date (e.g. "T14:30"), kept unchanged when rolled. */
	rest: string;
}

export function parseScheduled(value: unknown): ParsedScheduled | null {
	if (value instanceof Date && !isNaN(value.getTime())) return { date: localDateString(value), rest: '' };
	if (typeof value !== 'string') return null;
	const m = DATE_RE.exec(value.trim());
	if (!m) return null;
	return { date: `${m[1]}-${m[2]}-${m[3]}`, rest: m[4] ? `${m[4]}${m[5] ?? ''}` : '' };
}

export function addDays(date: string, n: number): string {
	const [y, mo, d] = date.split('-').map(Number);
	return localDateString(new Date(y ?? 1970, (mo ?? 1) - 1, (d ?? 1) + n));
}

/**
 * New `scheduled` value if the task should roll at the cutoff of `cutDay`
 * (scheduled on or before that day), else null. Rolls to the day after the
 * cutoff, not one day after its old date, so an old task lands on the next day.
 */
export function rollTarget(scheduled: unknown, cutDay: string): string | null {
	const p = parseScheduled(scheduled);
	if (!p || p.date > cutDay) return null;
	return `${addDays(cutDay, 1)}${p.rest}`;
}

export interface RollEntry {
	path: string;
	name: string;
	statusLabel: string;
	inReview: boolean;
	from: string;
	to: string;
	due: string | null;
	rollCount: number;
	/** Minutes in the current status, from Status History; null if not tracked. */
	minutesInStatus: number | null;
}

export interface RollReport {
	cut: Date;
	runAt: Date;
	catchUp: boolean;
	manual: boolean;
	rolled: RollEntry[];
	noDate: { path: string; name: string; statusLabel: string }[];
	/** Not rolled because the per-run edit limit was reached. */
	capped: { path: string; name: string }[];
}

const link = (path: string, name: string): string => `[[${path.replace(/\.md$/, '')}\\|${name}]]`;
const cell = (s: string): string => s.replace(/\|/g, '\\|');

/** The block appended under "## 🔁 Rolled Over" in the daily note, one per run. */
export function buildRollBlock(r: RollReport): string[] {
	const hm = toLocalIso(r.cut).slice(11, 16);
	const kind = r.manual ? 'manual roll' : r.catchUp ? 'catch-up after Obsidian was closed' : 'daily cutoff';
	const out: string[] = [
		`### ${hm} cutoff (${kind})`,
		'',
		`*Run at ${toLocalIso(r.runAt)} by Sheiko. \`scheduled\` moved to the next day; \`due\` never changes.*`,
		'',
	];
	const rolled = [...r.rolled].sort((a, b) => Number(b.inReview) - Number(a.inReview) || a.name.localeCompare(b.name));
	if (rolled.length === 0) {
		out.push('Nothing to roll.');
	} else {
		out.push('| Task | Status | Scheduled | Due | Rolls | In status for |', '|---|---|---|---|---|---|');
		for (const e of rolled) {
			const pastDue = e.due !== null && e.due < e.to.slice(0, 10);
			out.push(
				`| ${e.inReview ? '⭐ ' : ''}${link(e.path, cell(e.name))} | ${cell(e.statusLabel)} | ${e.from} → ${e.to} | ` +
					`${e.due ?? '—'}${pastDue ? ' ⚠️ past due' : ''} | ${e.rollCount} | ` +
					`${e.minutesInStatus === null ? '—' : formatMinutes(e.minutesInStatus)} |`,
			);
		}
		if (rolled.some((e) => e.inReview)) out.push('', '⭐ In review, waiting for sign-off: listed first.');
	}
	if (r.noDate.length) {
		out.push('', '**No scheduled date, so not rolled. Give these a date:**', '');
		for (const n of [...r.noDate].sort((a, b) => a.name.localeCompare(b.name))) {
			out.push(`- ${link(n.path, n.name)} (${n.statusLabel})`);
		}
	}
	if (r.capped.length) {
		out.push('', `**Not rolled: the edit limit per run was reached (${r.capped.length}).** They'll be picked up at the next cutoff, or run the roll command.`, '');
		for (const c of r.capped) out.push(`- ${link(c.path, c.name)}`);
	}
	out.push('');
	return out;
}

export function contextLineText(from: string, to: string, cut: Date, statusLabel: string, rollCount: number, catchUp: boolean, manual: boolean): string {
	const hm = toLocalIso(cut).slice(11, 16);
	const how = manual ? 'manual roll' : catchUp ? `catch-up for the ${hm} cutoff (Obsidian was closed)` : `${hm} cutoff`;
	return `Rolled ${from} → ${to} at the ${how}. Status: ${statusLabel}. Roll #${rollCount}.`;
}
