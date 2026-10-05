// Pure logic for break / deep-work slots: parsing the per-weekday schedule, finding the
// slot that's active now, and building the report block. No Obsidian imports.
//
// During a slot, sign-off prompts are held and what happens is logged; at the end a
// report block is written to that day's report note. Breaks and deep work behave the
// same (Sheikh, 2026-10-05); the kind is only a label. Time tracking is unchanged.

import { localDateString, toLocalIso } from './lifecycle';

export type SlotKind = 'break' | 'deep-work';

export interface SlotSpec {
	start: string; // HH:mm
	end: string; // HH:mm
	kind: SlotKind;
}

export interface SlotEvent {
	at: string; // local ISO
	path: string;
	kind: 'review' | 'closed' | 'status';
	from: string | null;
	to: string;
	/** Worker label at the time, for review events. */
	worker?: string;
}

export interface TouchedFile {
	path: string;
	created: boolean;
	deleted: boolean;
	modified: number;
	renamedFrom?: string;
}

export interface ActiveSlot {
	kind: SlotKind;
	start: string; // local ISO
	end: string; // local ISO (planned end)
	source: 'scheduled' | 'manual';
	events: SlotEvent[];
	touched: Record<string, TouchedFile>;
	/** Paths whose sign-off prompt was held. */
	held: string[];
	/** Last time Obsidian was seen running during the slot (updated each minute). */
	heartbeat: string;
	/** Stretches of the slot when Obsidian was closed, so nothing was captured. */
	gaps: { from: string; to: string }[];
}

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Parses one weekday's slots: comma-separated `HH:mm-HH:mm` entries, each optionally
 * followed by `break` or `deep work` (default: break). Invalid entries are reported,
 * never guessed. Example: `12:30-13:00 break, 14:00-15:30 deep work`.
 */
export function parseSlotSpec(text: string): { slots: SlotSpec[]; errors: string[] } {
	const slots: SlotSpec[] = [];
	const errors: string[] = [];
	for (const raw of text.split(',')) {
		const part = raw.trim();
		if (!part) continue;
		const m = /^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*(.*)$/.exec(part);
		const label = (m?.[3] ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
		if (!m || !HM.test(m[1] ?? '') || !HM.test(m[2] ?? '') || (label !== '' && label !== 'break' && label !== 'deep-work')) {
			errors.push(part);
			continue;
		}
		const start = m[1] ?? '';
		const end = m[2] ?? '';
		if (toMin(end) <= toMin(start)) {
			errors.push(part);
			continue;
		}
		slots.push({ start, end, kind: label === 'deep-work' ? 'deep-work' : 'break' });
	}
	return { slots, errors };
}

function toMin(hm: string): number {
	const m = HM.exec(hm);
	return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function at(day: Date, hm: string): Date {
	const mins = toMin(hm);
	return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60), mins % 60, 0, 0);
}

/** The scheduled slot covering `now`, with its absolute times and a key unique to that day + slot. */
export function scheduledSlotAt(now: Date, week: string[]): { spec: SlotSpec; start: Date; end: Date; key: string } | null {
	const { slots } = parseSlotSpec(week[now.getDay()] ?? '');
	for (const spec of slots) {
		const start = at(now, spec.start);
		const end = at(now, spec.end);
		if (now >= start && now < end) return { spec, start, end, key: `${localDateString(now)} ${spec.start}-${spec.end}` };
	}
	return null;
}

export function kindLabel(kind: SlotKind): string {
	return kind === 'deep-work' ? 'Deep work' : 'Break';
}

export function kindIcon(kind: SlotKind): string {
	return kind === 'deep-work' ? '🎧' : '☕';
}

const hm = (iso: string): string => iso.slice(11, 16);
const link = (path: string): string => `[[${path.replace(/\.md$/, '')}|${(path.split('/').pop() ?? path).replace(/\.md$/, '')}]]`;

export const TOUCHED_CAVEAT =
	"*Only edits made while Obsidian was open are listed. Changes made while it was closed (for example by an agent editing files directly) aren't captured.*";

export interface ReportInput {
	slot: ActiveSlot;
	endedAt: Date;
	endedEarly: boolean;
	/** Tasks whose due fell inside the slot: path + raw due value. */
	cameDue: { path: string; due: string }[];
}

/** One report block, appended to the day's report note. Never overwrites earlier blocks. */
export function buildSlotReport(inp: ReportInput): string[] {
	const s = inp.slot;
	const endIso = toLocalIso(inp.endedAt);
	const out: string[] = [
		`## ${kindIcon(s.kind)} ${kindLabel(s.kind)} — ${hm(s.start)}–${hm(endIso)} (${s.source})`,
		'',
		`*Written by Sheiko at ${hm(endIso)}${inp.endedEarly ? `, ended early (planned until ${hm(s.end)})` : ''}. Sign-off prompts were held during this slot.*`,
	];
	for (const g of s.gaps) {
		out.push('', `*Obsidian was closed ${hm(g.from)}–${hm(g.to)}, so nothing in that stretch was captured.*`);
	}
	const section = (title: string, lines: string[], empty: string): void => {
		out.push('', `**${title}**`, '');
		if (lines.length) out.push(...lines);
		else out.push(`- ${empty}`);
	};
	const review = s.events.filter((e) => e.kind === 'review');
	section(
		'Moved to review (sign-off held)',
		review.map((e) => `- ${hm(e.at)} ${link(e.path)}${e.worker ? ` — ${e.worker}` : ''}`),
		'None',
	);
	section('Closed', s.events.filter((e) => e.kind === 'closed').map((e) => `- ${hm(e.at)} ${link(e.path)} (${e.from ?? '?'} → ${e.to})`), 'None');
	section('Other status changes', s.events.filter((e) => e.kind === 'status').map((e) => `- ${hm(e.at)} ${link(e.path)} ${e.from ?? '?'} → ${e.to}`), 'None');
	section('Came due during the slot', inp.cameDue.map((d) => `- ${link(d.path)} — due ${d.due.replace('T', ' ')}`), 'None');
	const touched = Object.values(s.touched).sort((a, b) => a.path.localeCompare(b.path));
	section(
		`Markdown files touched (${touched.length})`,
		touched.map((t) => {
			const what: string[] = [];
			if (t.created) what.push('created');
			if (t.renamedFrom) what.push(`renamed from ${t.renamedFrom}`);
			if (t.modified) what.push(`modified ×${t.modified}`);
			if (t.deleted) what.push('deleted');
			return `- ${t.deleted ? t.path : link(t.path)} — ${what.join(', ')}`;
		}),
		'None',
	);
	out.push('', TOUCHED_CAVEAT);
	return out;
}

/** Report note path for a day: `<folder>/YYYY-MM-DD.md`. */
export function reportPath(folder: string, day: Date): string {
	const f = folder.trim().replace(/^\/+|\/+$/g, '');
	return f ? `${f}/${localDateString(day)}.md` : `${localDateString(day)}.md`;
}

/** Records a file event into the slot's touched list. */
export function touch(slot: ActiveSlot, path: string, kind: 'create' | 'modify' | 'delete' | 'rename', renamedFrom?: string): void {
	const t = slot.touched[path] ?? { path, created: false, deleted: false, modified: 0 };
	if (kind === 'create') t.created = true;
	else if (kind === 'delete') t.deleted = true;
	else if (kind === 'modify') t.modified++;
	if (renamedFrom) {
		const prev = slot.touched[renamedFrom];
		if (prev) {
			delete slot.touched[renamedFrom];
			t.created ||= prev.created;
			t.modified += prev.modified;
			t.renamedFrom = prev.renamedFrom ?? renamedFrom;
		} else t.renamedFrom = renamedFrom;
	}
	slot.touched[path] = t;
}
