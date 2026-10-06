// v0.2.0: break / deep-work slots. Pure schedule/report logic, plus the real Tracker +
// FocusSlots against the in-memory vault: prompts held during a slot, events logged,
// report written to <report folder>/YYYY-MM-DD.md, held prompts shown at the end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault, runTimers } from './fake-vault';
import { FocusSlots } from '../src/slots';
import { TOUCHED_CAVEAT, ActiveSlot, buildSlotReport, normalizeActiveSlot, parseSlotSpec, plural, reportPath, scheduledSlotAt, touch } from '../src/slot-logic';

const WEEK = ['', '12:30-13:00 break, 14:00-15:30 deep work', '', '', '', '', ''];

test('slot schedule: parses break / deep work, rejects bad entries without guessing', () => {
	const r = parseSlotSpec('12:30-13:00 break, 14:00–15:30 Deep Work, 9:00-9:15, 25:00-26:00, 13:00-12:00, 10:00-11:00 nap');
	assert.deepEqual(r.slots, [
		{ start: '12:30', end: '13:00', kind: 'break' },
		{ start: '14:00', end: '15:30', kind: 'deep-work' },
		{ start: '9:00', end: '9:15', kind: 'break' },
	]);
	assert.deepEqual(r.errors, ['25:00-26:00', '13:00-12:00', '10:00-11:00 nap']);
	assert.deepEqual(parseSlotSpec('').slots, []);
});

test('scheduled slot: found only inside its window, on its weekday', () => {
	const mon = (h: number, m: number): Date => new Date(2026, 9, 5, h, m); // Mon 5 Oct 2026
	assert.equal(scheduledSlotAt(mon(12, 29), WEEK), null);
	assert.equal(scheduledSlotAt(mon(12, 30), WEEK)?.key, '2026-10-05 12:30-13:00');
	assert.equal(scheduledSlotAt(mon(13, 0), WEEK), null); // end is exclusive
	assert.equal(scheduledSlotAt(mon(15, 0), WEEK)?.spec.kind, 'deep-work');
	assert.equal(scheduledSlotAt(new Date(2026, 9, 6, 12, 45), WEEK), null); // Tuesday: none
});

test('touched files: modify counts, create/delete flags, rename carries history over', () => {
	const slot = { touched: {} } as ActiveSlot;
	touch(slot, 'a.md', 'create');
	touch(slot, 'a.md', 'modify');
	touch(slot, 'a.md', 'modify');
	touch(slot, 'b.md', 'rename', 'a.md');
	touch(slot, 'c.md', 'delete');
	assert.equal(slot.touched['a.md'], undefined);
	assert.deepEqual(slot.touched['b.md'], { path: 'b.md', created: true, deleted: false, modified: 2, renamedFrom: 'a.md' });
	assert.equal(slot.touched['c.md']?.deleted, true);
});

test('report block: sections, "None" when empty, gaps and the open-only caveat line', () => {
	const slot: ActiveSlot = {
		kind: 'deep-work',
		start: '2026-10-05T14:00:00+01:00',
		end: '2026-10-05T15:30:00+01:00',
		source: 'manual',
		events: [{ at: '2026-10-05T14:10:00+01:00', path: 'T/A.md', kind: 'review', from: 'in-progress', to: 'in-review', worker: 'AI agent: test-agent-alpha' }],
		touched: { 'T/A.md': { path: 'T/A.md', created: false, deleted: false, modified: 2 } },
		held: ['T/A.md'],
		heartbeat: '2026-10-05T15:00:00+01:00',
		gaps: [{ from: '2026-10-05T14:20:00+01:00', to: '2026-10-05T14:40:00+01:00' }],
	};
	const out = buildSlotReport({ slot, endedAt: new Date('2026-10-05T15:00:00+01:00'), endedEarly: true, cameDue: [] }).join('\n');
	assert.match(out, /^## 🎧 Deep work — 14:00–15:00 \(manual\)/);
	assert.match(out, /ended early \(planned until 15:30\)/);
	assert.match(out, /Obsidian was closed 14:20–14:40/);
	assert.match(out, /- 14:10 · in-progress → in-review · AI agent: test-agent-alpha · \[\[T\/A\|A\]\]/);
	assert.match(out, /\*\*Closed\*\*\n\n- None/);
	assert.match(out, /Markdown files touched \(1\)\*\*\n\n- modified ×2 · \[\[T\/A\|A\]\]/);
	assert.ok(out.endsWith(TOUCHED_CAVEAT));
	assert.match(out, /1 sign-off prompt was held until it ended\./);
	assert.doesNotMatch(out, /Sign-off prompts were held/);
	assert.equal(reportPath('Sheiko Reports/', new Date(2026, 9, 5)), 'Sheiko Reports/2026-10-05.md');
});

const T = 'TaskNotes/Tasks/A.md';

async function vaultWithSlot(): Promise<FakeVault> {
	const v = new FakeVault({ settings: { reviewStatus: 'in-review', agentNames: ['test-agent-alpha'], slotSchedule: ['', '', '', '', '', '', ''] } });
	v.addTask(T, { status: 'in-progress', dateCreated: '2026-09-28T09:00:00+01:00', assignedTo: 'test-agent-alpha' });
	await v.start();
	await v.plugin.tracker.reconcile();
	return v;
}

test('during a slot: the review prompt is held and logged; ending writes the report and shows held prompts', async () => {
	const v = await vaultWithSlot();
	const now = new Date();
	assert.ok(v.plugin.slots.start('break', new Date(now.getTime() + 30 * 60 * 1000), 'manual', now));
	v.edit(T, { status: 'in-review' });
	v.plugin.tracker.onMetadataChanged(v.file(T));
	v.plugin.slots.onFileEvent('modify', v.file(T));
	await runTimers();
	assert.deepEqual(v.prompts, []); // held, not shown
	assert.deepEqual(v.data.activeSlot?.held, [T]);
	assert.equal(v.data.activeSlot?.events[0]?.worker, 'AI agent: test-agent-alpha');

	await v.plugin.slots.finish(true);
	assert.equal(v.data.activeSlot, null);
	const report = [...v.notes.entries()].find(([p]) => p.startsWith('Sheiko Reports/'));
	assert.ok(report, 'report note written');
	assert.match(report[1], /^## ☕ Break/); // no extra heading: the file name is the title
	assert.match(report[1], /☕ Break/);
	assert.match(report[1], /Moved to review \(sign-off held\)\*\*\n\n- \d\d:\d\d · in-progress → in-review · AI agent: test-agent-alpha · \[\[TaskNotes\/Tasks\/A\|A\]\]/);
	assert.match(report[1], /Markdown files touched \(1\)/);
	assert.deepEqual(v.prompts, [{ paths: [T], reason: 'manual' }]); // shown once the slot ended
});

test('a second slot the same day adds a block; the first is never changed', async () => {
	const v = await vaultWithSlot();
	const now = new Date();
	v.plugin.slots.start('break', new Date(now.getTime() + 60000), 'manual', now);
	await v.plugin.slots.finish(true);
	const path = [...v.notes.keys()].find((p) => p.startsWith('Sheiko Reports/')) ?? '';
	const first = v.notes.get(path) ?? '';
	v.plugin.slots.start('deep-work', new Date(now.getTime() + 60000), 'manual', now);
	await v.plugin.slots.finish(true);
	const both = v.notes.get(path) ?? '';
	assert.ok(both.startsWith(first.trimEnd()));
	assert.match(both, /🎧 Deep work/);
});

test('no slot running: prompts show as before; files touched are not logged', async () => {
	const v = await vaultWithSlot();
	v.plugin.slots.onFileEvent('modify', v.file(T));
	v.edit(T, { status: 'in-review' });
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	assert.deepEqual(v.prompts, [{ paths: [T], reason: 'review' }]);
	assert.equal(v.data.activeSlot, null);
});

test('scheduled slot starts once per day+slot, and not when writes are blocked', async () => {
	const v = await vaultWithSlot();
	const today = new Date();
	const hh = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	const start = new Date(today.getTime() - 60000);
	const end = new Date(today.getTime() + 10 * 60000);
	if (start.getDate() !== end.getDate()) return; // runs within a minute of midnight: skip rather than fake the clock
	v.data.settings.slotSchedule[today.getDay()] = `${hh(start)}-${hh(end)} deep work`;
	await v.plugin.slots.tick(today);
	assert.equal(v.data.activeSlot?.source, 'scheduled');
	await v.plugin.slots.finish(true, today);
	await v.plugin.slots.tick(today); // same window, ended early: not restarted
	assert.equal(v.data.activeSlot, null);

	const blocked = new FakeVault({ allowed: false, settings: { slotSchedule: [...v.data.settings.slotSchedule] } });
	await blocked.start();
	await blocked.plugin.tracker.reconcile();
	await blocked.plugin.slots.tick(today);
	assert.equal(blocked.data.activeSlot, null);
});

test('hold rule: a prompt you ask for during a slot is shown, not held', async () => {
	const v = await vaultWithSlot();
	const now = new Date();
	v.plugin.slots.start('deep-work', new Date(now.getTime() + 30 * 60 * 1000), 'manual', now);
	v.plugin.promptSignoff([v.file(T)], 'manual');
	v.plugin.promptSignoff([v.file(T)], 'cutoff');
	assert.deepEqual(v.prompts, [{ paths: [T], reason: 'manual' }]);
	assert.deepEqual(v.data.activeSlot?.held, [T]);
});

test('end-slot counts: singular for 1, plural otherwise', () => {
	assert.equal(plural(1, 'file', 'files'), '1 file');
	assert.equal(plural(0, 'file', 'files'), '0 files');
	assert.equal(plural(2, 'status change', 'status changes'), '2 status changes');
});

test('saved slot data: missing lists filled in, unusable slots dropped', () => {
	const ok = normalizeActiveSlot({ kind: 'break', start: '2026-10-06T12:00:00+02:00', end: '2026-10-06T12:30:00+02:00' });
	assert.ok(ok);
	assert.deepEqual([ok.events, ok.touched, ok.held, ok.gaps], [[], {}, [], []]);
	assert.equal(ok.heartbeat, ok.start);
	assert.equal(ok.source, 'manual');
	assert.equal(normalizeActiveSlot({ kind: 'nap', start: '2026-10-06T12:00:00+02:00', end: '2026-10-06T12:30:00+02:00' }), null);
	assert.equal(normalizeActiveSlot({ kind: 'break', start: 'soon', end: '2026-10-06T12:30:00+02:00' }), null);
	assert.equal(normalizeActiveSlot(null), null);
});

test('slot logging failing never stops tracking: the close is still recorded', async () => {
	const v = await vaultWithSlot();
	const now = new Date();
	v.plugin.slots.start('break', new Date(now.getTime() + 30 * 60 * 1000), 'manual', now);
	v.plugin.slots.onTransition = () => {
		throw new Error('broken slot data');
	};
	const origError = console.error;
	console.error = () => undefined;
	try {
		v.edit(T, { status: 'done' });
		v.plugin.tracker.onMetadataChanged(v.file(T));
		await runTimers();
	} finally {
		console.error = origError;
	}
	assert.ok(v.fm(T).completedDate, 'closure fields written despite the slot error');
});

test('unload: a slot save waiting on the debounce is written, not dropped', async () => {
	const v = await vaultWithSlot();
	const now = new Date();
	v.plugin.slots.start('break', new Date(now.getTime() + 30 * 60 * 1000), 'manual', now);
	let saves = 0;
	v.plugin.saveData = () => {
		saves++;
		return Promise.resolve();
	};
	v.plugin.slots.onFileEvent('modify', v.file(T)); // queues a debounced save
	v.plugin.slots.stop();
	assert.equal(saves, 1);
	v.plugin.slots.stop(); // nothing pending: no extra save
	assert.equal(saves, 1);
});

test('report wording: a slot with no held prompts says so, not "were held"', () => {
	const slot: ActiveSlot = {
		kind: 'break', start: '2026-10-06T12:49:00+02:00', end: '2026-10-06T13:49:00+02:00', source: 'manual',
		events: [], touched: {}, held: [], heartbeat: '2026-10-06T12:52:00+02:00', gaps: [],
	};
	const out = buildSlotReport({ slot, endedAt: new Date('2026-10-06T12:52:00+02:00'), endedEarly: true, cameDue: [] }).join('\n');
	assert.match(out, /No sign-off prompts came up during this slot\./);
	assert.doesNotMatch(out, /were held/);
	const two = buildSlotReport({ slot: { ...slot, held: ['a.md', 'b.md'] }, endedAt: new Date('2026-10-06T12:52:00+02:00'), endedEarly: true, cameDue: [] }).join('\n');
	assert.match(two, /2 sign-off prompts were held until it ended\./);
});

test('startup: file events before the layout is ready (vault loading) are not logged', async () => {
	const v = await vaultWithSlot();
	const slots = new FocusSlots(v.plugin); // a fresh instance, as at Obsidian startup: not ready yet
	const now = new Date();
	slots.start('deep-work', new Date(now.getTime() + 30 * 60 * 1000), 'manual', now);
	slots.onFileEvent('create', v.file(T)); // Obsidian announcing an existing file while loading
	assert.deepEqual(v.data.activeSlot?.touched, {});
	slots.markReady();
	slots.onFileEvent('modify', v.file(T)); // a real edit after layout ready
	assert.equal(v.data.activeSlot?.touched[T]?.modified, 1);
	assert.equal(v.data.activeSlot?.touched[T]?.created, false);
	slots.stop();
});
