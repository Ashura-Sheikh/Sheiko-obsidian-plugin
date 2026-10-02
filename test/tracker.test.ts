// Tracker: the code that writes Status History, closure fields and the Lifecycle
// Summary into task notes. Runs the real Tracker against the in-memory vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault, resetNotices, runTimers } from './fake-vault';
import { Notice } from './obsidian-mock';
import { DETECTED_SUFFIX, localDateString, parseTimestamp, minutesBetween } from '../src/lifecycle';
import { DEFAULT_SETTINGS } from '../src/settings';

const T = 'TaskNotes/Tasks/A.md';
const CREATED = '2026-09-28T09:00:00+01:00';

async function liveChange(v: FakeVault, path: string, changes: Record<string, unknown>): Promise<void> {
	v.edit(path, changes);
	v.plugin.tracker.onMetadataChanged(v.file(path));
	await runTimers();
}

function withTask(v: FakeVault): FakeVault {
	v.addTask(T, { status: 'in-progress', dateCreated: CREATED });
	return v;
}

async function started(v: FakeVault): Promise<FakeVault> {
	await v.start();
	await v.plugin.tracker.reconcile();
	return v;
}

test('defaults for new users: blank identity, no review status, auto-roll off', () => {
	assert.equal(DEFAULT_SETTINGS.identity, '');
	assert.equal(DEFAULT_SETTINGS.reviewStatus, '');
	assert.equal(DEFAULT_SETTINGS.autoRoll, false);
	assert.deepEqual(DEFAULT_SETTINGS.allowedVaults, []);
});

test('TaskNotes not installed: nothing is tracked or written', async () => {
	resetNotices();
	const v = new FakeVault({ taskNotesInstalled: false });
	v.addTask(T, { status: 'in-progress', dateCreated: CREATED });
	await started(v);
	assert.equal(v.plugin.taskNotes.found, false);
	assert.equal(v.plugin.tracker.isReady, false);
	await liveChange(v, T, { status: 'done' });
	assert.equal(v.fm(T).closedBy, undefined);
	assert.equal(v.body(T).includes('## Status History'), false);
	assert.equal(v.fm(T).closureSource, undefined);
});

test('TaskNotes installed but disabled: treated as not found', async () => {
	const v = new FakeVault({ taskNotesEnabled: false });
	await v.start();
	assert.equal(v.plugin.taskNotes.found, false);
	assert.match(v.plugin.tracker.blockedReason() ?? '', /TaskNotes/);
});

test('vault not allowed: nothing is written', async () => {
	const v = new FakeVault({ allowed: false });
	v.addTask(T, { status: 'in-progress', dateCreated: CREATED });
	await started(v);
	assert.equal(v.plugin.tracker.isReady, false);
	await liveChange(v, T, { status: 'done' });
	assert.equal(v.fm(T).completedDate, undefined);
	assert.equal(v.body(T).includes('## Status History'), false);
});

test('first sight records a baseline and writes nothing', async () => {
	const v = new FakeVault();
	v.addTask(T, { status: 'open' });
	const before = v.snapshot();
	await started(v);
	assert.deepEqual(v.snapshot(), before);
	assert.equal(v.data.lastStatus[T], 'open');
});

test('live close writes closure fields, buckets that add up, history and summary', async () => {
	const v = await started(withTask(new FakeVault({ settings: { identity: 'tester' } })));
	await liveChange(v, T, { status: 'done' });
	const fm = v.fm(T);
	const completed = parseTimestamp(fm.completedDate);
	assert.ok(completed, `completedDate should be full ISO, got ${String(fm.completedDate)}`);
	assert.equal(fm.closedBy, 'tester');
	assert.equal(fm.closureSource, 'sheiko');
	const created = parseTimestamp(CREATED);
	assert.ok(created);
	assert.equal(fm.timeToCloseMinutes, minutesBetween(created, completed));
	assert.equal(
		Number(fm.timeWorkingMinutes) + Number(fm.timeOvernightMinutes) + Number(fm.timeWeekendMinutes),
		fm.timeToCloseMinutes,
	);
	const body = v.body(T);
	assert.match(body, /## Status History\n\n- \S+ — in-progress → done\n/);
	assert.match(body, /## Lifecycle Summary/);
});

test('blank identity: closedBy is not written, the rest of the closure is', async () => {
	const v = await started(withTask(new FakeVault()));
	await liveChange(v, T, { status: 'done' });
	const fm = v.fm(T);
	assert.equal(fm.closedBy, undefined);
	assert.ok(parseTimestamp(fm.completedDate));
	assert.equal(fm.closureSource, 'sheiko');
});

test("TaskNotes' date-only completedDate for the same close is upgraded to full ISO", async () => {
	const v = await started(withTask(new FakeVault()));
	await liveChange(v, T, { status: 'done', completedDate: localDateString(new Date()) });
	assert.ok(parseTimestamp(v.fm(T).completedDate));
});

test('date-only dateCreated: no time-to-close is guessed', async () => {
	const v = new FakeVault();
	v.addTask(T, { status: 'in-progress', dateCreated: '2026-09-28' });
	await started(v);
	await liveChange(v, T, { status: 'done' });
	const fm = v.fm(T);
	assert.ok(parseTimestamp(fm.completedDate));
	assert.equal(fm.timeToCloseMinutes, undefined);
	assert.equal(fm.timeWorkingMinutes, undefined);
});

test("reopening Sheiko's own close clears the closure fields it wrote", async () => {
	const v = await started(withTask(new FakeVault({ settings: { identity: 'tester' } })));
	await liveChange(v, T, { status: 'done' });
	await liveChange(v, T, { status: 'open' });
	const fm = v.fm(T);
	for (const k of ['completedDate', 'closedBy', 'timeToCloseMinutes', 'timeWorkingMinutes', 'closureSource']) {
		assert.equal(fm[k], undefined, `${k} should be cleared`);
	}
});

test("a close written by someone else is never overwritten or cleared", async () => {
	const v = new FakeVault({ settings: { identity: 'tester' } });
	v.addTask(T, { status: 'done', dateCreated: CREATED, completedDate: '2026-09-20', closedBy: 'agent', timeToCloseMinutes: 99 });
	await started(v);
	await liveChange(v, T, { status: 'open' });
	let fm = v.fm(T);
	assert.equal(fm.closedBy, 'agent');
	assert.equal(fm.timeToCloseMinutes, 99);
	assert.equal(fm.completedDate, '2026-09-20');
	await liveChange(v, T, { status: 'done' });
	fm = v.fm(T);
	assert.equal(fm.closedBy, 'agent');
	assert.equal(fm.timeToCloseMinutes, 99);
});

test('changes made while Obsidian was closed: logged as detected, unseen close flagged, never filled in', async () => {
	const v = await started(withTask(new FakeVault({ settings: { identity: 'tester' } })));
	v.edit(T, { status: 'done' }); // no event: Obsidian "closed"
	await v.plugin.tracker.reconcile(); // next startup
	const body = v.body(T);
	assert.ok(body.includes(`in-progress → done ${DETECTED_SUFFIX}`));
	const fm = v.fm(T);
	assert.equal(fm.closedBy, undefined);
	assert.equal(fm.closureSource, undefined);
	assert.equal(fm.timeToCloseMinutes, undefined);
	assert.deepEqual(
		v.data.unwitnessedCloses.map((u) => u.path),
		[T],
	);
});

test('startup catch-up stops at the edit limit and picks the rest up next time', async () => {
	resetNotices();
	const v = new FakeVault({ settings: { maxEditsPerRun: 1 } });
	v.addTask('TaskNotes/Tasks/A.md', { status: 'open' });
	v.addTask('TaskNotes/Tasks/B.md', { status: 'open' });
	await started(v);
	v.edit('TaskNotes/Tasks/A.md', { status: 'in-progress' });
	v.edit('TaskNotes/Tasks/B.md', { status: 'in-progress' });
	await v.plugin.tracker.reconcile();
	const written = ['A', 'B'].filter((n) => v.body(`TaskNotes/Tasks/${n}.md`).includes('## Status History'));
	assert.equal(written.length, 1);
	assert.ok(Notice.messages.some((m) => m.includes('1 more skipped')));
	await v.plugin.tracker.reconcile();
	const after = ['A', 'B'].filter((n) => v.body(`TaskNotes/Tasks/${n}.md`).includes('## Status History'));
	assert.equal(after.length, 2);
});

test('dry run: a live close changes nothing in the note', async () => {
	const v = withTask(new FakeVault({ settings: { dryRun: true, identity: 'tester' } }));
	await started(v);
	v.edit(T, { status: 'done' });
	const before = v.snapshot();
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	assert.deepEqual(v.snapshot(), before);
});

test('no review status set: ticking every box does not move the task or prompt', async () => {
	const v = new FakeVault();
	v.addTask(T, { status: 'in-progress', dateCreated: CREATED }, '- [ ] one\n- [ ] two\n');
	await started(v);
	v.notes.set(T, (v.notes.get(T) ?? '').replace('- [ ] one', '- [x] one').replace('- [ ] two', '- [x] two'));
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	assert.equal(v.fm(T).status, 'in-progress');
	assert.equal(v.prompts.length, 0);
});

test('review status set: ticking the last box moves to review and prompts for sign-off', async () => {
	const v = new FakeVault({ settings: { reviewStatus: 'in-review' } });
	v.addTask(T, { status: 'in-progress', dateCreated: CREATED }, '- [x] one\n- [ ] two\n');
	await started(v);
	v.notes.set(T, (v.notes.get(T) ?? '').replace('- [ ] two', '- [x] two'));
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	assert.equal(v.fm(T).status, 'in-review');
	v.plugin.tracker.onMetadataChanged(v.file(T)); // the status write itself is the next change event
	await runTimers();
	assert.deepEqual(v.prompts.map((p) => p.reason), ['review']);
	assert.match(v.body(T), /in-progress → in-review \(auto: all boxes ticked\)/);
});
