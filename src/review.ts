// Pure logic for the sign-off window's per-task context: who worked on it, a short
// summary, and a facts line. No Obsidian imports, so it's unit-tested directly.
// Everything is computed locally from the note itself; nothing is sent anywhere.

import {
	HISTORY_HEADING,
	CONTEXT_HEADING,
	SUMMARY_HEADING,
	Transition,
	WeekSchedule,
	computeDurations,
	isContextEntry,
	isHistoryEntry,
} from './lifecycle';

// ---------- Worker ----------

export type WorkerKind = 'ai' | 'human' | 'mixed' | 'unknown';

export interface Worker {
	kind: WorkerKind;
	/** Names as found in the worker field, wikilink brackets removed. */
	names: string[];
}

/** Strips `[[…]]`, `[[target|alias]]` and a leading `@`; keeps the visible name. */
function cleanName(raw: string): string {
	let s = raw.trim();
	const wl = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(s);
	if (wl) s = (wl[2] ?? wl[1] ?? '').trim();
	return s.replace(/^@/, '').trim();
}

/**
 * Classifies the task's worker from its worker field (e.g. `assignedTo`).
 * A name on `agentNames` (case-insensitive) is an AI agent; any other name is a human.
 * No field, or an empty one, is `unknown`: never guessed from the title, tags or Context.
 */
export function classifyWorker(value: unknown, agentNames: string[]): Worker {
	const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	const names = raw
		.filter((x): x is string => typeof x === 'string')
		.map(cleanName)
		.filter((x) => x.length > 0);
	if (names.length === 0) return { kind: 'unknown', names: [] };
	const agents = new Set(agentNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
	const ai = names.filter((n) => agents.has(n.toLowerCase())).length;
	const kind: WorkerKind = ai === names.length ? 'ai' : ai === 0 ? 'human' : 'mixed';
	return { kind, names };
}

export function workerLabel(w: Worker): string {
	if (w.kind === 'unknown') return 'Worker: not recorded';
	const who = w.names.join(', ');
	if (w.kind === 'ai') return `AI agent: ${who}`;
	if (w.kind === 'human') return `Human: ${who}`;
	return `AI + human: ${who}`;
}

// ---------- Summary ----------

const SHEIKO_HEADINGS = new Set([HISTORY_HEADING, CONTEXT_HEADING]);

/**
 * 0.2.3 (#6): a template-only line, such as a Meta Bind inline field
 * (`` `INPUT[…]` `` / `` `VIEW[…]` ``), with or without a label like `**Status:**` in front.
 * These say nothing about the task, so they're never shown as its description.
 */
export function isTemplateLine(line: string): boolean {
	return /`(?:INPUT|VIEW)\[/.test(line);
}

/** Opening fence of a Meta Bind code block (```meta-bind, ```meta-bind-button, …). */
const TEMPLATE_FENCE = /^(`{3,}|~{3,})\s*meta-bind/;

function stripFrontmatter(content: string): string {
	const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
	return fm ? content.slice(fm[0].length) : content;
}

/** About this many characters of description show before "Show more" (0.2.3, #6). */
export const DESCRIPTION_SHORT = 300;

/**
 * 0.2.3 (#6): the task's first real section, as Markdown, for the sign-off window.
 * Starts at the first line that isn't a heading, template line, checkbox or Sheiko entry,
 * and stops at the next heading. Line breaks and formatting are kept for rendering.
 */
export function taskDescription(content: string): string {
	const out: string[] = [];
	let started = false;
	let inSummary = false;
	let fence: string | null = null;
	for (const raw of stripFrontmatter(content).split('\n')) {
		const l = raw.trim();
		if (fence !== null) {
			if (l.startsWith(fence)) fence = null;
			continue;
		}
		const tf = TEMPLATE_FENCE.exec(l);
		if (tf) {
			fence = tf[1] ?? '```';
			continue;
		}
		if (/^#{1,6}\s/.test(l)) {
			if (started) break;
			inSummary = l === SUMMARY_HEADING;
			continue;
		}
		if (inSummary) continue;
		if (l === '') {
			if (started && out[out.length - 1] !== '') out.push('');
			continue;
		}
		if (SHEIKO_HEADINGS.has(l) || isHistoryEntry(l) || isContextEntry(l) || isTemplateLine(l)) continue;
		if (/^[-*+]\s+\[.\]/.test(l)) continue; // checkbox: counted in the facts line instead
		started = true;
		out.push(raw.replace(/\s+$/, ''));
	}
	while (out.length && out[out.length - 1] === '') out.pop();
	return out.join('\n');
}

/** Rough visible length of Markdown text: link targets, markup and extra spaces left out. */
export function plainLength(markdown: string): number {
	return markdown
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
		.replace(/\[\[([^\]]+)\]\]/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`~>#]/g, '')
		.replace(/\s+/g, ' ')
		.trim().length;
}

/**
 * The task's own description: its body text with frontmatter, headings, checkboxes,
 * Sheiko's entries and the Lifecycle Summary removed, joined into one line and cut
 * to `max` characters. Text typed inside a Sheiko section (not an entry) is kept.
 */
export function describeTask(content: string, max = 140): string {
	const body = stripFrontmatter(content);
	const words: string[] = [];
	let inSummary = false;
	let fence: string | null = null;
	for (const raw of body.split('\n')) {
		const l = raw.trim();
		if (fence !== null) {
			if (l.startsWith(fence)) fence = null;
			continue;
		}
		const tf = TEMPLATE_FENCE.exec(l);
		if (tf) {
			fence = tf[1] ?? '```';
			continue;
		}
		if (isTemplateLine(l)) continue;
		if (/^#{1,6}\s/.test(l)) {
			inSummary = l === SUMMARY_HEADING;
			continue;
		}
		if (inSummary || l === '') continue;
		if (SHEIKO_HEADINGS.has(l) || isHistoryEntry(l) || isContextEntry(l)) continue;
		if (/^[-*+]\s+\[.\]/.test(l)) continue; // checkbox: counted in the facts line instead
		words.push(l.replace(/^[-*+]\s+/, ''));
	}
	const text = words.join(' ').replace(/\s+/g, ' ').trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface ContextEntry {
	at: string;
	who: string;
	text: string;
}

/** The most recent Context entry, or null. */
export function latestContext(content: string): ContextEntry | null {
	const lines = content.split('\n');
	const start = lines.findIndex((l) => l.trim() === CONTEXT_HEADING);
	if (start === -1) return null;
	let last: ContextEntry | null = null;
	for (let i = start + 1; i < lines.length; i++) {
		const l = (lines[i] ?? '').trim();
		if (/^##\s/.test(l)) break;
		const m = /^- \*\*(\d{4}-\d{2}-\d{2}T[^\s*]+?)(?: — ([^*]+?))?:\*\* (.*)$/.exec(l);
		if (m) last = { at: m[1] ?? '', who: (m[2] ?? '').trim(), text: (m[3] ?? '').trim() };
	}
	return last;
}

// ---------- Facts ----------

export interface FactsInput {
	history: Transition[];
	now: Date;
	schedule: WeekSchedule;
	progressStatus: string;
	reviewStatus: string;
	/** Checklist counts from the note, or null when it has no checkboxes. */
	checklist: { done: number; total: number } | null;
	/** Raw `due` value (date-only or full ISO), if any. */
	due: unknown;
}

export interface Facts {
	/** Minutes spent in the working status, from Status History. Null if never recorded there. */
	progressMinutes: number | null;
	/** The same time in progress, in milliseconds, for display to the second (0.2.3). */
	progressMs: number | null;
	/** When the task last entered review, from Status History. */
	inReviewSince: Date | null;
	/** Times sent back from the sign-off window. */
	sentBack: number;
	checklist: { done: number; total: number } | null;
	due: string | null;
	overdue: boolean;
}

export const SENT_BACK_NOTE = 'sent back at sign-off';

export function computeFacts(inp: FactsInput): Facts {
	const rep = computeDurations(inp.history, inp.now, inp.schedule);
	const prog = rep.perStatus.find((s) => s.status === inp.progressStatus);
	let inReviewSince: Date | null = null;
	for (const t of inp.history) if (t.to === inp.reviewStatus) inReviewSince = t.at;
	const sentBack = inp.history.filter((t) => t.kind === 'live' && t.note === SENT_BACK_NOTE).length;
	let due: string | null = null;
	let overdue = false;
	if (typeof inp.due === 'string' && inp.due.trim()) {
		due = inp.due.trim();
		const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due);
		// A date-only due is overdue from the start of the next day; a timed one from that time.
		const at = dateOnly ? new Date(`${due}T23:59:59`) : new Date(due);
		overdue = !isNaN(at.getTime()) && at.getTime() < inp.now.getTime();
	}
	return {
		progressMinutes: prog ? prog.minutes : null,
		progressMs: prog ? prog.ms : null,
		inReviewSince,
		sentBack,
		checklist: inp.checklist,
		due,
		overdue,
	};
}
