// 0.2.4: the checklist pop-out window's logic. Pure, no Obsidian imports, tested directly.
//
// - Every section of a note that holds a checkbox is shown in full (heading, text, boxes).
//   Sheiko's own sections (Status History, Context, Lifecycle Summary) are left out.
// - A section is protected when its heading, or a heading above it, contains one of the
//   protected words (any case). Its boxes can't be ticked from the window (Sheikh's 2a,
//   2026-10-23): a tick there would look the same as the owning agent's own tick.
// - Line numbers count from the top of the file, frontmatter included, so an edit can
//   check the exact line it is about to change.

import { CONTEXT_HEADING, HISTORY_HEADING, SUMMARY_HEADING } from './lifecycle';

export interface ChecklistItem {
	/** 0-based line in the whole file. */
	line: number;
	raw: string;
	indent: number;
	checked: boolean;
	text: string;
}

export interface ChecklistSection {
	/** The heading line as written, or null for boxes above the first heading. */
	heading: string | null;
	level: number;
	/** First line of the section (the heading, or the first line after frontmatter). */
	startLine: number;
	/** Line after the section's last line. */
	endLine: number;
	items: ChecklistItem[];
	protected: boolean;
}

const BOX = /^(\s*)(?:[-*+]|\d+[.)])\s+\[(.)\](?:\s+(.*))?$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const SHEIKO = new Set([HISTORY_HEADING, CONTEXT_HEADING, SUMMARY_HEADING]);

export function parseBox(raw: string): { indent: number; checked: boolean; text: string } | null {
	const m = BOX.exec(raw);
	if (!m) return null;
	return { indent: (m[1] ?? '').replace(/\t/g, '    ').length, checked: (m[2] ?? ' ') !== ' ', text: (m[3] ?? '').trim() };
}

function isProtected(headingText: string, words: string[]): boolean {
	const h = headingText.toLowerCase();
	return words.some((w) => w.trim() && h.includes(w.trim().toLowerCase()));
}

export function checklistSections(content: string, protectedWords: string[]): ChecklistSection[] {
	const lines = content.split('\n');
	let i = 0;
	if (lines[0] === '---') {
		const end = lines.indexOf('---', 1);
		if (end !== -1) i = end + 1;
	}
	const sections: ChecklistSection[] = [];
	/** Headings above the current line, for protection inherited from a parent heading. */
	const stack: { level: number; prot: boolean }[] = [];
	let cur: ChecklistSection = { heading: null, level: 0, startLine: i, endLine: i, items: [], protected: false };
	let skip = false; // inside a Sheiko section
	let fence: string | null = null;
	const close = (at: number): void => {
		cur.endLine = at;
		if (!skip && cur.items.length > 0) sections.push(cur);
	};
	for (; i < lines.length; i++) {
		const raw = lines[i] ?? '';
		const f = FENCE.exec(raw);
		if (fence !== null) {
			if (f && (f[1] ?? '').startsWith(fence[0] ?? '`') && (f[1] ?? '').length >= fence.length) fence = null;
			continue;
		}
		if (f) {
			fence = f[1] ?? '```';
			continue;
		}
		const h = HEADING.exec(raw);
		if (h) {
			close(i);
			const level = (h[1] ?? '#').length;
			while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
			const prot = isProtected(h[2] ?? '', protectedWords) || stack.some((s) => s.prot);
			stack.push({ level, prot });
			skip = SHEIKO.has(raw.trim());
			cur = { heading: raw, level, startLine: i, endLine: i, items: [], protected: prot };
			continue;
		}
		const box = parseBox(raw);
		if (box) cur.items.push({ line: i, raw, ...box });
	}
	close(lines.length);
	return sections;
}

/** The same line with its box ticked or unticked. Only the box character changes. */
export function toggledLine(raw: string, tick: boolean): string {
	return raw.replace(/\[(.)\]/, tick ? '[x]' : '[ ]');
}

/** Box text cut for a one-line Context entry. */
export function shortBox(text: string, max = 60): string {
	const t = text.replace(/\s+/g, ' ').trim();
	return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Context text for a tick from the window, with the optional comment. */
export function tickContextText(boxText: string, tick: boolean, comment = ''): string {
	const c = comment.replace(/\s+/g, ' ').trim();
	return `${tick ? 'Ticked' : 'Unticked'} "${shortBox(boxText)}" from the checklist window${c ? `: ${c}` : ''}`;
}

/** Context text for a note added later to a ticked box. */
export function boxNoteText(boxText: string, comment: string): string {
	return `Note on "${shortBox(boxText)}": ${comment.replace(/\s+/g, ' ').trim()}`;
}
