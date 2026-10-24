// 0.2.4: sign-off without closing. Pure logic, no Obsidian imports, so the tests run
// the same rule the plugin does.
//
// A sign-off is recorded in one of two forms (setting "Sign-off record"):
//   (a) a Context line with a fixed phrase:  - **<time> — <identity>:** Signed off (not closed)
//   (b) frontmatter fields:                   signedOff: <time>, signedOffBy: <identity>
// Both forms are ALWAYS read, whichever one is set for writing, so switching the
// setting never hides an earlier sign-off.
//
// The rule: a task is signed off when the latest sign-off event (sign-off or
// withdrawal) under the user's own identity, after it last entered review, is a
// sign-off, and it is still in review
// (no change since that entry). A task with no "entered review" line in its history
// (e.g. from before Sheiko was installed) is never treated as signed off.
//
// 0.2.5 (#21): "Sign off" is off on such a task, with the reason shown (signoffBlocked),
// so it can't write a sign-off that would never count. The rule itself is unchanged:
// sign-off lines already written on such a task keep not counting.

import { CONTEXT_HEADING, Transition, parseTimestamp, sectionLines, toLocalIso } from './lifecycle';

export const SIGNOFF_PHRASE = 'Signed off (not closed)';
export const WITHDRAW_PHRASE = 'Sign-off withdrawn';
/** History note when a task closes with no valid sign-off (Sheikh's decision 3, 2026-10-23). */
export const NO_SIGNOFF_NOTE = 'no sign-off recorded';

export type SignoffForm = 'context' | 'field';

export interface SignoffEvent {
	at: Date;
	who: string;
	kind: 'signoff' | 'withdraw';
	source: 'context' | 'field';
}

export interface SignoffState {
	/** True when the latest event since the task last entered review is a sign-off. */
	signedOff: boolean;
	/** The sign-off that counts, when signedOff. */
	event: SignoffEvent | null;
	/** When the task last entered review, or null if the history doesn't say. */
	reviewSince: Date | null;
}

/** Name of the "by" field that goes with the sign-off field, e.g. signedOff → signedOffBy. */
export function byField(field: string): string {
	return `${field}By`;
}

const CONTEXT_EVENT = /^- \*\*(\d{4}-\d{2}-\d{2}T[^\s*]+?) — ([^*]+?):\*\* (.*)$/;

/**
 * Sign-off events written as Context lines. Only the exact phrases count, and only
 * with an identity: free text such as "Reviewed - signing off" is never read as one.
 */
export function contextEvents(content: string): SignoffEvent[] {
	const out: SignoffEvent[] = [];
	for (const raw of sectionLines(content, CONTEXT_HEADING)) {
		const m = CONTEXT_EVENT.exec(raw.trim());
		if (!m) continue;
		const at = parseTimestamp(m[1]);
		const who = (m[2] ?? '').trim();
		const text = (m[3] ?? '').trim();
		if (!at || !who) continue;
		if (text === SIGNOFF_PHRASE) out.push({ at, who, kind: 'signoff', source: 'context' });
		else if (text === WITHDRAW_PHRASE) out.push({ at, who, kind: 'withdraw', source: 'context' });
	}
	return out;
}

/** The sign-off held in frontmatter fields, if any. A withdrawal clears the fields. */
export function fieldEvent(fm: Record<string, unknown>, field: string): SignoffEvent | null {
	const at = parseTimestamp(fm[field]);
	const whoRaw = fm[byField(field)];
	const who = typeof whoRaw === 'string' ? whoRaw.trim() : '';
	if (!at || !who) return null;
	return { at, who, kind: 'signoff', source: 'field' };
}

/** When the task entered review, if that is the last thing its history records; else null. */
export function reviewEntry(history: Transition[], reviewStatus: string): Date | null {
	if (!reviewStatus) return null;
	const last = history[history.length - 1];
	return last && last.to === reviewStatus ? last.at : null;
}

/** Why "Sign off" is off: no identity set (decision 4). */
export const NO_IDENTITY_REASON = 'Set your identity in Sheiko settings to sign off.';
/** Why "Sign off" is off: the history doesn't end with a move into review (#21). */
export const NO_REVIEW_ENTRY_REASON =
	"No recorded move into review, so a sign-off can't count. Use Sign off and close, or move the task out of review and back.";

/**
 * Why "Sign off" can't record a sign-off that counts on this task, or null when it can.
 * Uses the same reviewEntry test as signoffState, so the button and the rule always agree.
 */
export function signoffBlocked(history: Transition[], reviewStatus: string, identity: string): string | null {
	if (!identity.trim()) return NO_IDENTITY_REASON;
	if (!reviewEntry(history, reviewStatus)) return NO_REVIEW_ENTRY_REASON;
	return null;
}

/** Identities compare without regard to case or surrounding spaces. */
export function sameIdentity(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function signoffState(inp: {
	history: Transition[];
	content: string;
	fm: Record<string, unknown>;
	reviewStatus: string;
	field: string;
	/**
	 * Whose sign-offs count: the user's identity from settings. Events under any other name
	 * (e.g. an AI agent writing a Context line by hand) are ignored, sign-offs and withdrawals
	 * alike. Blank = nothing counts. (0.2.4 gate, project-manager's read; Sheikh's go-ahead.)
	 */
	identity: string;
}): SignoffState {
	const reviewSince = reviewEntry(inp.history, inp.reviewStatus);
	if (!reviewSince || !inp.identity.trim()) return { signedOff: false, event: null, reviewSince };
	const events = contextEvents(inp.content);
	const fe = fieldEvent(inp.fm, inp.field);
	if (fe) events.push(fe);
	let latest: SignoffEvent | null = null;
	for (const e of events) {
		if (!sameIdentity(e.who, inp.identity)) continue;
		if (e.at.getTime() < reviewSince.getTime()) continue;
		// Later wins; on a tie a withdrawal wins, so a tie never reads as signed off.
		if (!latest || e.at.getTime() > latest.at.getTime() || (e.at.getTime() === latest.at.getTime() && e.kind === 'withdraw')) {
			latest = e;
		}
	}
	const signedOff = latest !== null && latest.kind === 'signoff';
	return { signedOff, event: signedOff ? latest : null, reviewSince };
}

/** The history note for a close: who signed off and when, or that nobody did. */
export function closeNote(state: SignoffState): string {
	if (!state.signedOff || !state.event) return NO_SIGNOFF_NOTE;
	return `signed off by ${state.event.who} at ${toLocalIso(state.event.at)}`;
}
