// Roller: the code that moves `scheduled` forward, bumps rollCount, appends a
// Context line and writes the Rolled Over block into the daily note.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault } from './fake-vault';
import { ROLLED_HEADING } from '../src/roller';

const D = 'TaskNotes/Tasks/';
const CUT = new Date(2026, 8, 30, 17, 0, 0); // 2026-09-30 17:00 local
const NOTE = 'Daily-Notes/2026-09-30.md';

function seed(v: FakeVault): void {
	v.addTask(`${D}A.md`, { status: 'open', scheduled: '2026-09-29', due: '2026-09-30' });
	v.addTask(`${D}B.md`, { status: 'in-progress', scheduled: '2026-09-30T14:00' });
	v.addTask(`${D}Done.md`, { status: 'done', scheduled: '2026-09-29' });
	v.addTask(`${D}Future.md`, { status: 'open', scheduled: '2026-10-05' });
	v.addTask(`${D}Recurring.md`, { status: 'open', scheduled: '2026-09-29', recurrence: 'FREQ=DAILY' });
	v.addTask(`${D}Archived.md`, { status: 'open', scheduled: '2026-09-29', tags: ['task', 'archived'] });
	v.addTask(`${D}NoDate.md`, { status: 'open' });
	v.notes.set('Notes/Not a task.md', '---\nscheduled: 2026-09-29\n---\nPlain note.\n');
}

async function ready(opts: ConstructorParameters<typeof FakeVault>[0] = {}): Promise<FakeVault> {
	const v = new FakeVault(opts);
	seed(v);
	await v.start();
	return v;
}

test('rolls overdue tasks to the day after the cutoff; due never moves', async () => {
	const v = await ready();
	const r = await v.plugin.roller.run(CUT, false);
	assert.ok(r);
	assert.equal(v.fm(`${D}A.md`).scheduled, '2026-10-01');
	assert.equal(v.fm(`${D}A.md`).due, '2026-09-30');
	assert.equal(v.fm(`${D}A.md`).rollCount, 1);
	assert.equal(v.fm(`${D}B.md`).scheduled, '2026-10-01T14:00', 'time of day is kept');
	assert.match(v.body(`${D}A.md`), /## Context\n\n- \*\*\S+ — sheiko:\*\* Rolled 2026-09-29 → 2026-10-01/);
});

test('does not roll completed, future, recurring, archived or non-task notes', async () => {
	const v = await ready();
	const before = v.snapshot();
	await v.plugin.roller.run(CUT, false);
	for (const p of [`${D}Done.md`, `${D}Future.md`, `${D}Recurring.md`, `${D}Archived.md`, 'Notes/Not a task.md']) {
		assert.equal(v.notes.get(p), before.get(p), `${p} should be untouched`);
	}
});

test('tasks with no date are listed, not rolled; the daily note gets one block', async () => {
	const v = await ready();
	const r = await v.plugin.roller.run(CUT, false);
	assert.deepEqual(r?.noDate.map((n) => n.name), ['NoDate']);
	assert.equal(v.fm(`${D}NoDate.md`).scheduled, undefined);
	const note = v.notes.get(NOTE) ?? '';
	assert.ok(note.includes(ROLLED_HEADING));
	assert.ok(note.includes('NoDate'));
	assert.equal(note.match(/^### /gm)?.length, 1);
	assert.ok(v.folders.has('Daily-Notes'));
});

test('a second run adds a second block and never overwrites the first', async () => {
	const v = await ready();
	await v.plugin.roller.run(CUT, true);
	const first = v.notes.get(NOTE) ?? '';
	await v.plugin.roller.run(CUT, true); // A and B now scheduled after the cutoff; NoDate still listed
	const second = v.notes.get(NOTE) ?? '';
	assert.ok(second.startsWith(first.trimEnd()));
	assert.equal(second.match(/^### /gm)?.length, 2);
});

test('rolling again on a later cutoff counts up', async () => {
	const v = await ready();
	await v.plugin.roller.run(CUT, false);
	await v.plugin.roller.run(new Date(2026, 9, 1, 17, 0, 0), false);
	assert.equal(v.fm(`${D}A.md`).scheduled, '2026-10-02');
	assert.equal(v.fm(`${D}A.md`).rollCount, 2);
	assert.ok(v.notes.has('Daily-Notes/2026-10-01.md'));
});

test('edit limit: the rest are held back and listed', async () => {
	const v = await ready({ settings: { maxEditsPerRun: 1 } });
	const r = await v.plugin.roller.run(CUT, false);
	assert.equal(r?.rolled.length, 1);
	assert.equal(r?.capped.length, 1);
	const held = r?.capped[0]?.path ?? '';
	assert.equal(v.fm(held).rollCount, undefined);
	assert.ok((v.notes.get(NOTE) ?? '').includes(r?.capped[0]?.name ?? '?'));
});

test('dry run: nothing written, no daily note', async () => {
	const v = await ready({ settings: { dryRun: true } });
	const before = v.snapshot();
	await v.plugin.roller.run(CUT, false);
	assert.deepEqual(v.snapshot(), before);
});

test('vault not allowed: no roll', async () => {
	const v = await ready({ allowed: false });
	const before = v.snapshot();
	assert.equal(await v.plugin.roller.run(CUT, false), null);
	assert.deepEqual(v.snapshot(), before);
});

test('TaskNotes not installed: no roll', async () => {
	const v = await ready({ taskNotesInstalled: false });
	const before = v.snapshot();
	assert.equal(await v.plugin.roller.run(CUT, false), null);
	assert.deepEqual(v.snapshot(), before);
});
