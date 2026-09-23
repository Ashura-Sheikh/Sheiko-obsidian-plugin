// Pure lifecycle logic: timestamps, Status History parsing, durations, time buckets.
// No Obsidian imports, so this file can be unit-tested directly with Node.

export interface DaySchedule {
	/** "HH:mm", local time */
	start: string;
	/** "HH:mm", local time. Also the daily roll cutoff (Phase 3). */
	end: string;
}

/** Index 0 = Sunday ... 6 = Saturday, matching Date.getDay(). */
export type WeekSchedule = DaySchedule[];

export interface Buckets {
	working: number;
	overnight: number;
	weekend: number;
}

export type TransitionKind = 'live' | 'created' | 'detected';

export interface Transition {
	at: Date;
	from: string | null;
	to: string;
	kind: TransitionKind;
	/** Optional reason for a live change, e.g. "auto: timer started". */
	note?: string;
}

export const HISTORY_HEADING = '## Status History';
export const CONTEXT_HEADING = '## Context';
export const DETECTED_SUFFIX = '(detected at startup — actual change time unknown)';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local ISO 8601 with ±HH:mm offset and no milliseconds, per the vault convention. */
export function toLocalIso(d: Date): string {
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? '+' : '-';
	const abs = Math.abs(off);
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
		`${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
	);
}

export function localDateString(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isDateOnly(value: unknown): boolean {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/** Parses a full timestamp. Returns null for date-only or unparseable values; never guesses a time of day. */
export function parseTimestamp(value: unknown): Date | null {
	if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
	if (typeof value !== 'string') return null;
	const v = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
	const d = new Date(v);
	return isNaN(d.getTime()) ? null : d;
}

export function minutesBetween(a: Date, b: Date): number {
	return Math.round((b.getTime() - a.getTime()) / 60000);
}

// ---------- Status History lines ----------

export function formatTransition(t: Transition): string {
	const ts = toLocalIso(t.at);
	if (t.kind === 'created') return `- ${ts} — created → ${t.to}`;
	const base = `- ${ts} — ${t.from ?? '?'} → ${t.to}`;
	if (t.kind === 'detected') return `${base} ${DETECTED_SUFFIX}`;
	return t.note ? `${base} (${t.note})` : base;
}

const LINE_RE = /^- (\d{4}-\d{2}-\d{2}T[^\s]+) — (\S+) → (\S+)(.*)$/;

export function parseTransition(line: string): Transition | null {
	const m = LINE_RE.exec(line.trim());
	if (!m) return null;
	const at = parseTimestamp(m[1]);
	if (!at) return null;
	const from = m[2] ?? '';
	const to = m[3] ?? '';
	const rest = m[4] ?? '';
	if (from === 'created') return { at, from: null, to, kind: 'created' };
	if (rest.includes('detected at startup')) return { at, from, to, kind: 'detected' };
	const note = /^\s*\((.+)\)\s*$/.exec(rest)?.[1];
	return note ? { at, from, to, kind: 'live', note } : { at, from, to, kind: 'live' };
}

/** Returns the lines under `heading`, up to the next `## ` heading or end of file. */
export function sectionLines(body: string, heading: string): string[] {
	const lines = body.split('\n');
	const start = lines.findIndex((l) => l.trim() === heading);
	if (start === -1) return [];
	const out: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i] ?? '';
		if (/^##\s/.test(l)) break;
		out.push(l);
	}
	return out;
}

export function parseHistory(body: string): Transition[] {
	return sectionLines(body, HISTORY_HEADING)
		.map(parseTransition)
		.filter((t): t is Transition => t !== null)
		.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Appends `line` to the end of the `heading` section (creating the section at the end
 * of the file if missing). Never rewrites or removes existing lines.
 */
export function appendToSection(content: string, heading: string, line: string): string {
	const lines = content.split('\n');
	const start = lines.findIndex((l) => l.trim() === heading);
	if (start === -1) {
		const trimmed = content.replace(/\s+$/, '');
		return `${trimmed}\n\n${heading}\n\n${line}\n`;
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i] ?? '')) {
			end = i;
			break;
		}
	}
	// Insert after the last non-blank line of the section.
	let insertAt = end;
	while (insertAt > start + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt--;
	if (insertAt === start + 1) {
		// Empty section: keep one blank line under the heading.
		lines.splice(start + 1, 0, '', line);
	} else {
		lines.splice(insertAt, 0, line);
	}
	return lines.join('\n');
}

export function formatContextLine(at: Date, who: string, text: string): string {
	const single = text.trim().replace(/\s*\n\s*/g, ' ');
	return `- **${toLocalIso(at)} — ${who}:** ${single}`;
}

// ---------- Time buckets ----------

function parseHm(hm: string): [number, number] {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
	if (!m) return [0, 0];
	return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

function atTime(day: Date, hm: string): Date {
	const [h, mi] = parseHm(hm);
	return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi, 0, 0);
}

function overlapMs(a0: number, a1: number, b0: number, b1: number): number {
	return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Splits [start, end) into working / overnight / weekend minutes.
 * Saturday and Sunday are always weekend. Mon–Fri time inside that day's
 * start–end window is working; the rest is overnight.
 * The three buckets always add up to minutesBetween(start, end).
 */
export function splitBuckets(start: Date, end: Date, schedule: WeekSchedule): Buckets {
	const ms: Buckets = { working: 0, overnight: 0, weekend: 0 };
	if (end.getTime() <= start.getTime()) return { working: 0, overnight: 0, weekend: 0 };
	let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
	const s = start.getTime();
	const e = end.getTime();
	while (day.getTime() < e) {
		const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
		const d0 = Math.max(day.getTime(), s);
		const d1 = Math.min(next.getTime(), e);
		if (d1 > d0) {
			const dow = day.getDay();
			if (dow === 0 || dow === 6) {
				ms.weekend += d1 - d0;
			} else {
				const win = schedule[dow] ?? { start: '09:00', end: '17:00' };
				const w0 = atTime(day, win.start).getTime();
				const w1 = atTime(day, win.end).getTime();
				const working = w1 > w0 ? overlapMs(d0, d1, w0, w1) : 0;
				ms.working += working;
				ms.overnight += d1 - d0 - working;
			}
		}
		day = next;
	}
	const total = minutesBetween(start, end);
	const out: Buckets = {
		working: Math.round(ms.working / 60000),
		overnight: Math.round(ms.overnight / 60000),
		weekend: Math.round(ms.weekend / 60000),
	};
	// Absorb any rounding difference into the largest bucket so the three always sum to the total.
	const diff = total - out.working - out.overnight - out.weekend;
	if (diff !== 0) {
		const keys: (keyof Buckets)[] = ['working', 'overnight', 'weekend'];
		const largest = keys.reduce((a, b) => (ms[b] > ms[a] ? b : a));
		out[largest] += diff;
	}
	return out;
}

// ---------- Per-status durations ----------

export interface StatusDuration {
	status: string;
	minutes: number;
	buckets: Buckets;
}

export interface DurationReport {
	perStatus: StatusDuration[];
	/** Time that can't be attributed: ends in a change made while Obsidian was closed. */
	gapMinutes: number;
	/** True if there is no Status History at all. */
	untracked: boolean;
	/** The current (open-ended) status, if any. */
	current: string | null;
}

/**
 * Walks the Status History into segments. A segment ending in a `detected` transition
 * is counted as a gap, never attributed to a status (the real change time is unknown).
 * Time before the first recorded entry is not counted at all.
 */
export function computeDurations(history: Transition[], now: Date, schedule: WeekSchedule): DurationReport {
	const perStatus = new Map<string, StatusDuration>();
	let gapMinutes = 0;
	const add = (status: string, a: Date, b: Date): void => {
		const cur = perStatus.get(status) ?? {
			status,
			minutes: 0,
			buckets: { working: 0, overnight: 0, weekend: 0 },
		};
		const bk = splitBuckets(a, b, schedule);
		cur.minutes += minutesBetween(a, b);
		cur.buckets.working += bk.working;
		cur.buckets.overnight += bk.overnight;
		cur.buckets.weekend += bk.weekend;
		perStatus.set(status, cur);
	};
	for (let i = 0; i < history.length; i++) {
		const t = history[i];
		if (!t) continue;
		const next = history[i + 1];
		const segEnd = next ? next.at : now;
		if (segEnd.getTime() <= t.at.getTime()) continue;
		if (next && next.kind === 'detected') {
			gapMinutes += minutesBetween(t.at, segEnd);
		} else {
			add(t.to, t.at, segEnd);
		}
	}
	const last = history[history.length - 1];
	return {
		perStatus: [...perStatus.values()],
		gapMinutes,
		untracked: history.length === 0,
		current: last ? last.to : null,
	};
}

export function formatMinutes(total: number): string {
	if (total < 60) return `${total}m`;
	const d = Math.floor(total / 1440);
	const h = Math.floor((total % 1440) / 60);
	const m = total % 60;
	return [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
}

// ---------- Lifecycle Summary (written into the note) ----------

export const SUMMARY_HEADING = '## Lifecycle Summary';

/**
 * Replaces the body of `heading` with `bodyLines` (creating the section at the end
 * if missing). Only ever used for the Summary, which is a derived snapshot;
 * Context and Status History stay append-only.
 */
export function replaceSection(content: string, heading: string, bodyLines: string[]): string {
	const lines = content.split('\n');
	const start = lines.findIndex((l) => l.trim() === heading);
	const block = [heading, '', ...bodyLines, ''];
	if (start === -1) {
		return `${content.replace(/\s+$/, '')}\n\n${block.join('\n')}`;
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i] ?? '')) {
			end = i;
			break;
		}
	}
	lines.splice(start, end - start, ...block);
	return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export interface SummaryInput {
	history: Transition[];
	/** Snapshot time. For a closed task: the close time, so the numbers stop there. */
	end: Date;
	writtenAt: Date;
	schedule: WeekSchedule;
	label: (status: string) => string;
	closure: {
		created: unknown;
		completed: unknown;
		closedBy: unknown;
		timeToClose: unknown;
		working: unknown;
		overnight: unknown;
		weekend: unknown;
		seenLive: boolean;
	};
}

const cell = (v: unknown): string => {
	if (v === undefined || v === null || v === '') return '—';
	const s = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
	return s.replace(/\|/g, '\\|');
};

export function buildSummary(inp: SummaryInput): string[] {
	const c = inp.closure;
	const out: string[] = [
		`*Snapshot as of ${toLocalIso(inp.writtenAt)}, written by Sheiko. Refreshed each time the task closes; Status History is the full record.*`,
		'',
		'**Closure**',
		'',
		'| Field | Value |',
		'|---|---|',
		`| Created | ${cell(c.created)} |`,
		`| Completed | ${cell(c.completed)} |`,
		`| Closed by | ${cell(c.closedBy)} |`,
	];
	if (typeof c.timeToClose === 'number') {
		out.push(
			`| Time to close | ${formatMinutes(c.timeToClose)} (${c.timeToClose} min) |`,
			`| – working | ${formatMinutes(Number(c.working ?? 0))} |`,
			`| – overnight | ${formatMinutes(Number(c.overnight ?? 0))} |`,
			`| – weekend | ${formatMinutes(Number(c.weekend ?? 0))} |`,
		);
	} else {
		out.push('| Time to close | — |');
	}
	out.push(
		`| Recorded by | ${c.seenLive ? 'Sheiko (seen live)' : c.completed ? 'Someone else, or by hand' : '—'} |`,
		'',
		'**Time per status**',
		'',
	);
	if (inp.history.length === 0) {
		out.push('No status changes recorded yet.');
		return out;
	}
	const rep = computeDurations(inp.history, inp.end, inp.schedule);
	out.push('| Status | Total | Working | Overnight | Weekend |', '|---|---|---|---|---|');
	for (const s of rep.perStatus) {
		// Hide only the status the task is in at the snapshot (e.g. Done at close = 0m).
		// A real earlier stage stays visible even if it rounds to 0m.
		if (s.minutes <= 0 && s.status === rep.current) continue;
		out.push(
			`| ${cell(inp.label(s.status))} | ${formatMinutes(s.minutes)} | ${formatMinutes(s.buckets.working)} | ` +
				`${formatMinutes(s.buckets.overnight)} | ${formatMinutes(s.buckets.weekend)} |`,
		);
	}
	if (rep.gapMinutes > 0) {
		out.push(`| Gap (changed while Obsidian was closed) | ${formatMinutes(rep.gapMinutes)} | — | — | — |`);
	}
	const first = inp.history[0];
	if (first && first.kind !== 'created') {
		out.push('', '*Time before the first recorded change isn’t counted.*');
	}
	return out;
}

// ---------- Phase 2: auto-stage triggers + daily cutoff ----------

/** A TaskNotes timer is running if any time entry has a start and no end. */
export function isTimerRunning(entries: unknown): boolean {
	if (!Array.isArray(entries)) return false;
	return entries.some((e: unknown) => {
		if (typeof e !== 'object' || e === null) return false;
		const r = e as Record<string, unknown>;
		return typeof r.startTime === 'string' && r.startTime.length > 0 && (r.endTime === undefined || r.endTime === null || r.endTime === '');
	});
}

/**
 * Checklist state of a note, from Obsidian's list cache (`task`: ' ' = unticked,
 * any other character = ticked, undefined = not a checkbox).
 * Returns null when the note has no checkboxes at all.
 */
export function checklistComplete(items: { task?: string }[] | undefined): boolean | null {
	const boxes = (items ?? []).filter((i) => typeof i.task === 'string');
	if (boxes.length === 0) return null;
	return boxes.every((i) => i.task !== ' ');
}

/** The most recent daily cutoff (that weekday's end time) at or before `now`. */
export function mostRecentCutoff(now: Date, schedule: WeekSchedule): Date {
	for (let back = 0; back < 8; back++) {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
		const win = schedule[day.getDay()] ?? { start: '09:00', end: '17:00' };
		const cut = atTime(day, win.end);
		if (cut.getTime() <= now.getTime()) return cut;
	}
	return atTime(now, '00:00');
}

/**
 * Decides whether a daily cutoff has passed since the last one acted on.
 * `record` is what to store as the new "last cutoff run". First run (no record)
 * only records, so installing the plugin doesn't fire anything.
 */
export function cutoffDue(now: Date, schedule: WeekSchedule, lastRun: string | null): { act: boolean; record: string | null } {
	const cut = mostRecentCutoff(now, schedule);
	const last = parseTimestamp(lastRun);
	if (last && cut.getTime() <= last.getTime()) return { act: false, record: null };
	return { act: last !== null, record: toLocalIso(cut) };
}

export const DEFAULT_WEEK: WeekSchedule = [
	{ start: '09:00', end: '17:00' }, // Sun (weekend bucket; end = roll cutoff)
	{ start: '09:00', end: '17:00' }, // Mon
	{ start: '09:00', end: '17:00' }, // Tue
	{ start: '09:00', end: '17:00' }, // Wed
	{ start: '09:00', end: '17:00' }, // Thu
	{ start: '09:00', end: '17:00' }, // Fri
	{ start: '09:00', end: '17:00' }, // Sat (weekend bucket; end = roll cutoff)
];
