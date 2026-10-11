// v0.2.2: sign-off window routing (the missed-prompt fix) and card fold state across redraws.
// Routing runs through the real Tracker + FocusSlots in the in-memory vault; the fake vault's
// promptSignoff calls the same signoffRoute rule main.ts calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault, runTimers } from './fake-vault';
import { isCardOpen, pruneCardStates, recordCardToggle, signoffRoute, signoffRouteLog } from '../src/signoff-logic';

const T = 'TaskNotes/Tasks/A.md';
const U = 'TaskNotes/Tasks/B.md';
const CREATED = '2026-09-28T09:00:00+01:00';

async function vault(): Promise<FakeVault> {
	const v = new FakeVault({ settings: { reviewStatus: 'in-review', slotSchedule: ['', '', '', '', '', '', ''] } });
	v.addTask(T, { status: 'in-progress', dateCreated: CREATED });
	v.addTask(U, { status: 'in-progress', dateCreated: CREATED });
	await v.start();
	await v.plugin.tracker.reconcile();
	return v;
}

async function moveToReview(v: FakeVault, path: string): Promise<void> {
	v.edit(path, { status: 'in-review' });
	v.plugin.tracker.onMetadataChanged(v.file(path));
	await runTimers();
}

test('routing: held by a slot, added to a window on screen, otherwise a new window opens', () => {
	assert.equal(signoffRoute(true, true), 'held');
	assert.equal(signoffRoute(true, null), 'held');
	assert.equal(signoffRoute(false, true), 'add');
	assert.equal(signoffRoute(false, null), 'open');
	assert.equal(signoffRoute(false, false), 'open'); // the 0.2.2 fix: a gone window isn't reused
});

test('missed prompt (0.2.1 bug): a review move while a closed window is still referenced opens a new window', async () => {
	const v = await vault();
	v.signoffWindow = { shown: false }; // closed or hidden, but the plugin still holds a reference
	await moveToReview(v, T);
	assert.deepEqual(v.routes, ['open']);
	assert.deepEqual(v.prompts, [{ paths: [T], reason: 'review' }]);
	assert.deepEqual(v.signoffWindow, { shown: true });
});

test('a second review move while the window is on screen is added to it, not a second window', async () => {
	const v = await vault();
	await moveToReview(v, T);
	await moveToReview(v, U);
	assert.deepEqual(v.routes, ['open', 'add']);
});

test('console lines name the path taken, including a dropped stale window', () => {
	assert.match(signoffRouteLog('held', 'review', 1, false), /^\[Sheiko\] Sign-off prompt held .*1 task\)/);
	assert.match(signoffRouteLog('add', 'cutoff', 2, false), /added to the open window \(cutoff, 2 tasks\)/);
	assert.match(signoffRouteLog('open', 'review', 1, true), /previous window was no longer on screen/);
	assert.doesNotMatch(signoffRouteLog('open', 'review', 1, false), /no longer on screen/);
});

test('card fold state: a card the user opened stays open across redraws; defaults record nothing', () => {
	const states = new Map<string, boolean>();
	// 4+ tasks: cards start folded.
	assert.equal(isCardOpen(T, true, states), false);
	recordCardToggle(T, true, true, states); // user unfolds T
	assert.equal(isCardOpen(T, true, states), true); // a redraw keeps it open
	assert.equal(isCardOpen(U, true, states), false); // others stay folded
	// A redraw setting the default fires `toggle` too; it must not be recorded as a choice.
	recordCardToggle(U, false, true, states);
	assert.equal(states.has(U), false);
	// User folds T again: back to default, nothing kept.
	recordCardToggle(T, false, true, states);
	assert.equal(states.size, 0);
});

test('card fold state: an explicit choice survives the default changing; finished tasks are dropped', () => {
	const states = new Map<string, boolean>();
	recordCardToggle(T, true, true, states); // opened while folded by default
	assert.equal(isCardOpen(T, false, states), true); // 3 or fewer tasks now: still open
	assert.equal(isCardOpen(T, true, states), true); // back above 3: still open
	recordCardToggle(U, false, false, states); // folded while open by default
	assert.equal(isCardOpen(U, false, states), false);
	pruneCardStates([U], states); // T approved, gone from the window
	assert.deepEqual([...states.keys()], [U]);
});
