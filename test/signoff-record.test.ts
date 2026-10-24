// 0.2.4: sign-off without closing. The pure rule (signoff-record.ts), then the real
// Tracker writing sign-offs and annotating closes against the in-memory vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault, resetNotices, runTimers } from './fake-vault';
import { Notice } from './obsidian-mock';
import { formatContextLine, parseHistory } from '../src/lifecycle';
import {
	NO_IDENTITY_REASON,
	NO_REVIEW_ENTRY_REASON,
	NO_SIGNOFF_NOTE,
	SIGNOFF_PHRASE,
	WITHDRAW_PHRASE,
	closeNote,
	contextEvents,
	signoffBlocked,
	signoffState,
} from '../src/signoff-record';

const REVIEW = 'in-review';
const H = (lines: string[]): string => `Task.\n\n## Status History\n\n${lines.join('\n')}\n`;
const C = (lines: string[]): string => `\n## Context\n\n${lines.join('\n')}\n`;
const entered = '- 2026-10-23T10:00:00+01:00 — in-progress → in-review';
const sign = (t: string, who = 'sheikh', text = SIGNOFF_PHRASE): string => `- **2026-10-23T${t}+01:00 — ${who}:** ${text}`;

function state(content: string, fm: Record<string, unknown> = {}, identity = 'sheikh') {
	return signoffState({ history: parseHistory(content), content, fm, reviewStatus: REVIEW, field: 'signedOff', identity });
}

// ---------- the pure rule ----------

test('rule: a fixed-phrase Context line after entering review signs the task off', () => {
	const s = state(H([entered]) + C([sign('11:00:00')]));
	assert.equal(s.signedOff, true);
	assert.equal(s.event?.who, 'sheikh');
	assert.equal(closeNote(s), 'signed off by sheikh at 2026-10-23T11:00:00+01:00');
});

test('rule: free text never counts, nor a fixed phrase with no identity', () => {
	const free = state(H([entered]) + C([sign('11:00:00', 'sheikh', 'Reviewed - Signing off to go ahead and close')]));
	assert.equal(free.signedOff, false);
	const anon = state(H([entered]) + C(['- **2026-10-23T11:00:00+01:00:** ' + SIGNOFF_PHRASE]));
	assert.equal(anon.signedOff, false);
	assert.equal(closeNote(anon), NO_SIGNOFF_NOTE);
});

test('rule: a sign-off from before the task last entered review does not count (send back → review → sign again)', () => {
	const content =
		H([
			'- 2026-10-23T09:00:00+01:00 — in-progress → in-review',
			'- 2026-10-23T09:30:00+01:00 — in-review → in-progress (sent back at sign-off)',
			'- 2026-10-23T10:00:00+01:00 — in-progress → in-review',
		]) + C([sign('09:10:00')]);
	assert.equal(state(content).signedOff, false);
	const resigned =
		H([
			'- 2026-10-23T09:00:00+01:00 — in-progress → in-review',
			'- 2026-10-23T09:30:00+01:00 — in-review → in-progress (sent back at sign-off)',
			'- 2026-10-23T10:00:00+01:00 — in-progress → in-review',
		]) + C([sign('09:10:00'), sign('10:05:00')]);
	assert.equal(state(resigned).signedOff, true);
});

test('rule: no "entered review" line in the history = not signed off (notes from before install)', () => {
	assert.equal(state('Task.\n' + C([sign('11:00:00')])).signedOff, false);
	assert.equal(state(H(['- 2026-10-23T10:00:00+01:00 — open → in-progress']) + C([sign('11:00:00')])).signedOff, false);
});

test('rule: the task must still be in review; a later status change ends the sign-off', () => {
	const moved = H([entered, '- 2026-10-23T12:00:00+01:00 — in-review → in-progress']) + C([sign('11:00:00')]);
	assert.equal(state(moved).signedOff, false);
});

test('rule: a withdrawal after a sign-off wins; a new sign-off after it counts again; a tie reads as withdrawn', () => {
	assert.equal(state(H([entered]) + C([sign('11:00:00'), sign('11:05:00', 'sheikh', WITHDRAW_PHRASE)])).signedOff, false);
	assert.equal(
		state(H([entered]) + C([sign('11:00:00'), sign('11:05:00', 'sheikh', WITHDRAW_PHRASE), sign('11:10:00')])).signedOff,
		true,
	);
	assert.equal(state(H([entered]) + C([sign('11:00:00'), sign('11:00:00', 'sheikh', WITHDRAW_PHRASE)])).signedOff, false);
});

test('rule: the field form is read too, whatever the setting, and needs both time and identity', () => {
	const content = H([entered]);
	assert.equal(state(content, { signedOff: '2026-10-23T11:00:00+01:00', signedOffBy: 'sheikh' }).signedOff, true);
	assert.equal(state(content, { signedOff: '2026-10-23T11:00:00+01:00' }).signedOff, false);
	assert.equal(state(content, { signedOff: '2026-10-23T09:00:00+01:00', signedOffBy: 'sheikh' }).signedOff, false, 'older than the review entry');
	// A Context withdrawal after a field sign-off wins: both forms are one timeline.
	assert.equal(
		state(content + C([sign('11:05:00', 'sheikh', WITHDRAW_PHRASE)]), { signedOff: '2026-10-23T11:00:00+01:00', signedOffBy: 'sheikh' }).signedOff,
		false,
	);
});

test('contextEvents: only the Context section is read', () => {
	const content = `Notes\n${sign('11:00:00')}\n` + C([sign('11:05:00')]);
	assert.equal(contextEvents(content).length, 1);
});

// ---------- the real Tracker ----------

const T = 'TaskNotes/Tasks/A.md';

async function inReview(opts: ConstructorParameters<typeof FakeVault>[0] = {}): Promise<FakeVault> {
	const v = new FakeVault({ ...opts, settings: { reviewStatus: REVIEW, identity: 'sheikh', ...(opts.settings ?? {}) } });
	v.addTask(T, { status: 'in-progress', dateCreated: '2026-10-23T08:00:00+01:00' });
	await v.start();
	await v.plugin.tracker.reconcile();
	v.edit(T, { status: REVIEW });
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	return v;
}

async function closeByAgent(v: FakeVault): Promise<string> {
	v.edit(T, { status: 'done' });
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	const h = parseHistory(v.body(T));
	return h[h.length - 1]?.note ?? '';
}

test('tracker: "Sign off" writes the fixed Context line and leaves the task in review', async () => {
	const v = await inReview();
	assert.equal(await v.plugin.tracker.signOff(v.file(T)), true);
	assert.equal(v.fm(T).status, REVIEW);
	assert.match(v.body(T), new RegExp(`— sheikh:\\*\\* ${SIGNOFF_PHRASE.replace(/[()]/g, '\\$&')}`));
});

test('tracker: an agent close after a sign-off is annotated with who and when', async () => {
	const v = await inReview();
	await v.plugin.tracker.signOff(v.file(T));
	const note = await closeByAgent(v);
	assert.match(note, /^signed off by sheikh at 2026-\d\d-\d\dT/);
});

test('tracker: an agent close with no sign-off is marked "no sign-off recorded" (decision 3)', async () => {
	const v = await inReview();
	assert.equal(await closeByAgent(v), NO_SIGNOFF_NOTE);
});

test('tracker: a close after a withdrawn sign-off is marked "no sign-off recorded"', async () => {
	const v = await inReview();
	await v.plugin.tracker.signOff(v.file(T));
	await new Promise((r) => setTimeout(r, 1100)); // withdrawal must be a later second than the sign-off
	assert.equal(await v.plugin.tracker.withdrawSignOff(v.file(T)), true);
	assert.equal(await closeByAgent(v), NO_SIGNOFF_NOTE);
});

test('tracker: "Sign off and close" keeps its own note, not an annotation', async () => {
	const v = await inReview();
	await v.plugin.tracker.setStatus(v.file(T), 'done', 'signed off by sheikh');
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	const h = parseHistory(v.body(T));
	assert.equal(h[h.length - 1]?.note, 'signed off by sheikh');
});

test('tracker: field form writes signedOff + signedOffBy; withdraw clears them and logs a line', async () => {
	const v = await inReview({ settings: { signoffRecord: 'field' } });
	await v.plugin.tracker.signOff(v.file(T));
	assert.match(String(v.fm(T).signedOff), /^2026-\d\d-\d\dT/);
	assert.equal(v.fm(T).signedOffBy, 'sheikh');
	assert.equal(v.body(T).includes(SIGNOFF_PHRASE), false);
	await new Promise((r) => setTimeout(r, 1100));
	await v.plugin.tracker.withdrawSignOff(v.file(T));
	assert.equal(v.fm(T).signedOff, undefined);
	assert.equal(v.fm(T).signedOffBy, undefined);
	assert.equal(v.body(T).includes(WITHDRAW_PHRASE), true);
});

test('tracker: no identity = no sign-off written (decision 4)', async () => {
	resetNotices();
	const v = await inReview({ settings: { identity: '' } });
	const before = v.snapshot().get(T);
	assert.equal(await v.plugin.tracker.signOff(v.file(T)), false);
	assert.equal(v.snapshot().get(T), before);
	assert.match(Notice.messages.join('\n'), /identity/);
});

test('tracker: dry run writes no sign-off, in either form', async () => {
	for (const form of ['context', 'field'] as const) {
		const v = await inReview({ settings: { dryRun: false, signoffRecord: form } });
		v.data.settings.dryRun = true;
		const before = v.snapshot().get(T);
		assert.equal(await v.plugin.tracker.signOff(v.file(T)), false);
		assert.equal(v.snapshot().get(T), before, form);
	}
});

// ---------- 0.2.5 (#21): "Sign off" off when the sign-off could never count ----------

const blocked = (content: string, identity = 'sheikh') => signoffBlocked(parseHistory(content), REVIEW, identity);

test('#21 blocked: no Status History at all = Sign off off, with the reason', () => {
	assert.equal(blocked('Task with no history.\n'), NO_REVIEW_ENTRY_REASON);
});

test('#21 blocked: history that does not end with the move into review = off', () => {
	assert.equal(blocked(H(['- 2026-10-23T09:00:00+01:00 — open → in-progress'])), NO_REVIEW_ENTRY_REASON);
	assert.equal(blocked(H([entered, '- 2026-10-23T12:00:00+01:00 — in-review → in-progress'])), NO_REVIEW_ENTRY_REASON);
});

test('#21 blocked: a live or "detected at startup" move into review = on', () => {
	assert.equal(blocked(H([entered])), null);
	const detected = '- 2026-10-23T10:00:00+01:00 — in-progress → in-review (detected at startup — actual change time unknown)';
	assert.equal(parseHistory(H([detected]))[0]?.kind, 'detected');
	assert.equal(blocked(H([detected])), null);
});

test('#21 blocked: no identity still wins, with its own reason (decision 4)', () => {
	assert.equal(blocked(H([entered]), ''), NO_IDENTITY_REASON);
	assert.equal(blocked('No history.\n', '  '), NO_IDENTITY_REASON);
});

test('#21 rule unchanged: sign-off lines already on a task with no history still never count', () => {
	const s = state('Task.\n' + C([sign('11:00:00'), sign('11:05:00'), sign('11:10:00')]));
	assert.equal(s.signedOff, false);
	assert.equal(s.reviewSince, null);
	assert.equal(closeNote(s), NO_SIGNOFF_NOTE);
});

test('#21 tracker: Sign off on a task in review with no history writes nothing, in either form, and says why', async () => {
	for (const form of ['context', 'field'] as const) {
		resetNotices();
		const v = new FakeVault({ settings: { reviewStatus: REVIEW, identity: 'sheikh', signoffRecord: form } });
		v.addTask(T, { status: REVIEW, dateCreated: '2026-09-19T08:00:00+01:00' }); // went to review before Sheiko tracked it
		await v.start();
		await v.plugin.tracker.reconcile();
		assert.equal(v.body(T).includes('## Status History'), false, `${form}: first sight writes no history`);
		const before = v.snapshot().get(T);
		assert.equal(await v.plugin.tracker.signOff(v.file(T)), false, form);
		assert.equal(v.snapshot().get(T), before, `${form}: note unchanged`);
		assert.match(Notice.messages.join('\n'), /No recorded move into review/, form);
	}
});

test('#21 tracker: once the task is moved out of review and back, Sign off works again', async () => {
	const v = new FakeVault({ settings: { reviewStatus: REVIEW, identity: 'sheikh' } });
	v.addTask(T, { status: REVIEW, dateCreated: '2026-09-19T08:00:00+01:00' });
	await v.start();
	await v.plugin.tracker.reconcile();
	for (const status of ['in-progress', REVIEW]) {
		v.edit(T, { status });
		v.plugin.tracker.onMetadataChanged(v.file(T));
		await runTimers();
	}
	assert.equal(await v.plugin.tracker.signOff(v.file(T)), true);
	const idx = v.plugin.signoffIndex;
	await idx.refresh(v.file(T));
	assert.deepEqual(idx.signed().map((f) => f.path), [T]);
});

// ---------- the signed-off index (signoff-index.ts), run for real ----------

test('index: a signed-off task leaves the sign-off list and joins the waiting-to-close list', async () => {
	const v = await inReview();
	const idx = v.plugin.signoffIndex;
	await idx.rebuild();
	assert.deepEqual(idx.awaiting().map((f) => f.path), [T]);
	assert.deepEqual(idx.signed(), []);
	await v.plugin.tracker.signOff(v.file(T));
	assert.equal(await idx.refresh(v.file(T)), true, 'refresh reports the change');
	assert.deepEqual(idx.awaiting(), []);
	assert.deepEqual(idx.signed().map((f) => f.path), [T]);
	assert.equal(idx.map.get(T)?.who, 'sheikh');
});

test('index: withdraw, send back and close all take a task off the waiting-to-close list', async () => {
	for (const step of ['withdraw', 'send back', 'close'] as const) {
		const v = await inReview();
		const idx = v.plugin.signoffIndex;
		await v.plugin.tracker.signOff(v.file(T));
		await idx.refresh(v.file(T));
		await new Promise((r) => setTimeout(r, 1100));
		if (step === 'withdraw') await v.plugin.tracker.withdrawSignOff(v.file(T));
		else {
			v.edit(T, { status: step === 'close' ? 'done' : 'in-progress' });
			v.plugin.tracker.onMetadataChanged(v.file(T));
			await runTimers();
		}
		await idx.refresh(v.file(T));
		assert.deepEqual(idx.signed(), [], step);
		assert.deepEqual(idx.awaiting().map((f) => f.path), step === 'withdraw' ? [T] : [], step);
	}
});

test('index: rebuild finds sign-offs in either form; rename keeps the entry', async () => {
	const v = await inReview({ settings: { signoffRecord: 'field' } });
	await v.plugin.tracker.signOff(v.file(T));
	const idx = v.plugin.signoffIndex;
	await idx.rebuild();
	assert.deepEqual(idx.signed().map((f) => f.path), [T]);
	assert.equal(idx.map.get(T)?.source, 'field');
	idx.rename(T, 'TaskNotes/Tasks/B.md');
	assert.equal(idx.map.has(T), false);
	assert.equal(idx.map.has('TaskNotes/Tasks/B.md'), true);
});

test('index: a note that is not a task is never listed, even with a sign-off line', async () => {
	const v = await inReview();
	v.notes.set('Notes/plain.md', `---\nstatus: in-review\n---\n${C([sign('11:00:00')])}`);
	const idx = v.plugin.signoffIndex;
	await idx.rebuild();
	assert.equal(idx.signed().some((f) => f.path === 'Notes/plain.md'), false);
	assert.equal(idx.awaiting().some((f) => f.path === 'Notes/plain.md'), false);
});

// ---------- 0.2.4 gate (project-manager, item 2): only the user's own identity counts ----------

test('identity: a sign-off under another name (e.g. an agent) does not count, in either form', () => {
	assert.equal(state(H([entered]) + C([sign('11:00:00', 'technical-lead')])).signedOff, false);
	assert.equal(state(H([entered]), { signedOff: '2026-10-23T11:00:00+01:00', signedOffBy: 'project-manager' }).signedOff, false);
	assert.equal(closeNote(state(H([entered]) + C([sign('11:00:00', 'technical-lead')]))), NO_SIGNOFF_NOTE);
});

test('identity: the user\'s own sign-off counts, case and spaces ignored, in either form', () => {
	assert.equal(state(H([entered]) + C([sign('11:00:00', 'Sheikh')]), {}, ' sheikh ').signedOff, true);
	assert.equal(state(H([entered]), { signedOff: '2026-10-23T11:00:00+01:00', signedOffBy: 'SHEIKH' }).signedOff, true);
});

test('identity: another name\'s withdrawal does not cancel the user\'s sign-off', () => {
	const s = state(H([entered]) + C([sign('11:00:00'), sign('11:05:00', 'technical-lead', WITHDRAW_PHRASE)]));
	assert.equal(s.signedOff, true);
	assert.equal(s.event?.who, 'sheikh');
	// and the user's own withdrawal still does
	assert.equal(state(H([entered]) + C([sign('11:00:00'), sign('11:05:00', 'sheikh', WITHDRAW_PHRASE)])).signedOff, false);
});

test('identity: an agent sign-off after the user\'s does not replace it as the one that counts', () => {
	const s = state(H([entered]) + C([sign('11:00:00'), sign('11:05:00', 'technical-lead')]));
	assert.equal(s.event?.at.toISOString(), '2026-10-23T10:00:00.000Z');
});

test('identity: with no identity set, nothing counts', () => {
	assert.equal(state(H([entered]) + C([sign('11:00:00')]), {}, '').signedOff, false);
	assert.equal(state(H([entered]), { signedOff: '2026-10-23T11:00:00+01:00', signedOffBy: 'sheikh' }, '  ').signedOff, false);
});

test('identity, real tracker and index: an agent-written sign-off line neither lists the task nor marks its close as signed off', async () => {
	const v = await inReview();
	const now = new Date();
	await v.plugin.tracker.addContext(v.file(T), formatContextLine(now, 'technical-lead', SIGNOFF_PHRASE));
	const idx = v.plugin.signoffIndex;
	await idx.refresh(v.file(T));
	assert.deepEqual(idx.signed(), []);
	assert.deepEqual(idx.awaiting().map((f) => f.path), [T]);
	assert.equal(await closeByAgent(v), NO_SIGNOFF_NOTE);
});
