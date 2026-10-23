// 0.2.4: sign-off without closing. The pure rule (signoff-record.ts), then the real
// Tracker writing sign-offs and annotating closes against the in-memory vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault, resetNotices, runTimers } from './fake-vault';
import { Notice } from './obsidian-mock';
import { parseHistory } from '../src/lifecycle';
import {
	NO_SIGNOFF_NOTE,
	SIGNOFF_PHRASE,
	WITHDRAW_PHRASE,
	closeNote,
	contextEvents,
	signoffState,
} from '../src/signoff-record';

const REVIEW = 'in-review';
const H = (lines: string[]): string => `Task.\n\n## Status History\n\n${lines.join('\n')}\n`;
const C = (lines: string[]): string => `\n## Context\n\n${lines.join('\n')}\n`;
const entered = '- 2026-10-23T10:00:00+01:00 — in-progress → in-review';
const sign = (t: string, who = 'sheikh', text = SIGNOFF_PHRASE): string => `- **2026-10-23T${t}+01:00 — ${who}:** ${text}`;

function state(content: string, fm: Record<string, unknown> = {}) {
	return signoffState({ history: parseHistory(content), content, fm, reviewStatus: REVIEW, field: 'signedOff' });
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
