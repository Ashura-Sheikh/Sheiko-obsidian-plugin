// 0.2.4: the checklist pop-out. Section parsing and protection (pure), then the real
// Tracker's guarded line edit: stale lines refused, no auto-stage from window ticks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault, runTimers } from './fake-vault';
import { DEFAULT_SETTINGS } from '../src/settings';
import { boxNoteText, checklistSections, parseBox, shortBox, tickContextText, toggledLine } from '../src/checklist';

const WORDS = DEFAULT_SETTINGS.protectedHeadings;

const NOTE = [
	'---',
	'status: in-review',
	'tags:',
	'  - task',
	'---',
	'- [ ] box above any heading',
	'',
	'## Why',
	'',
	'No boxes here.',
	'',
	'## What\'s being asked of you',
	'',
	'Intro text.',
	'1. [x] numbered and ticked',
	'- [ ] plain',
	'    - [/] nested, in progress',
	'```',
	'- [ ] inside a code fence',
	'```',
	'## Pre-Handoff Checklist — hard gate, see [[29-Pre-Handoff-Checklist]]',
	'- [x] 1. Verify, don\'t recall',
	'### Sub-part',
	'- [ ] under a protected heading',
	'## Outcome',
	'- [ ] Outcome box',
	'## project-manager sign-off',
	'- [ ] gate box',
	'## Status History',
	'- [ ] not a real box, Sheiko section',
	'## Context',
	'- [ ] nor this',
].join('\n');

test('sections: every section with a box, in full order, Sheiko sections and code fences left out', () => {
	const s = checklistSections(NOTE, WORDS);
	assert.deepEqual(
		s.map((x) => [x.heading, x.items.map((i) => i.text)]),
		[
			[null, ['box above any heading']],
			["## What's being asked of you", ['numbered and ticked', 'plain', 'nested, in progress']],
			['## Pre-Handoff Checklist — hard gate, see [[29-Pre-Handoff-Checklist]]', ["1. Verify, don't recall"]],
			['### Sub-part', ['under a protected heading']],
			['## Outcome', ['Outcome box']],
			['## project-manager sign-off', ['gate box']],
		],
	);
});

test('sections: line numbers count from the top of the file, frontmatter included', () => {
	const lines = NOTE.split('\n');
	for (const sec of checklistSections(NOTE, WORDS)) for (const it of sec.items) assert.equal(lines[it.line], it.raw);
});

test('protection: Pre-Handoff, its sub-heading and "sign-off" headings are view-only; others are not', () => {
	const prot = Object.fromEntries(checklistSections(NOTE, WORDS).map((x) => [x.heading ?? '(top)', x.protected]));
	assert.equal(prot['(top)'], false);
	assert.equal(prot["## What's being asked of you"], false);
	assert.equal(prot['## Pre-Handoff Checklist — hard gate, see [[29-Pre-Handoff-Checklist]]'], true);
	assert.equal(prot['### Sub-part'], true, 'inherits from its parent heading');
	assert.equal(prot['## Outcome'], false, 'a sibling heading ends the inheritance');
	assert.equal(prot['## project-manager sign-off'], true);
	assert.equal(checklistSections(NOTE, []).some((x) => x.protected), false, 'empty list: nothing protected');
});

test('boxes: ticked is any character but a space; indent and text read', () => {
	assert.deepEqual(parseBox('    - [/] nested'), { indent: 4, checked: true, text: 'nested' });
	assert.deepEqual(parseBox('- [ ] '), { indent: 0, checked: false, text: '' });
	assert.equal(parseBox('- not a box'), null);
	assert.equal(toggledLine('    - [/] nested', false), '    - [ ] nested');
	assert.equal(toggledLine('1. [ ] a [ ] b', true), '1. [x] a [ ] b', 'only the box itself changes');
});

test('context text: one line, box text shortened, comment optional', () => {
	assert.equal(tickContextText('Verify it', true), 'Ticked "Verify it" from the checklist window');
	assert.equal(tickContextText('Verify it', false, 'not yet\nchecked'), 'Unticked "Verify it" from the checklist window: not yet checked');
	assert.equal(boxNoteText('x', ' done  twice '), 'Note on "x": done twice');
	assert.equal(shortBox('a'.repeat(80)).length, 60);
});

// ---------- the real Tracker ----------

const T = 'TaskNotes/Tasks/C.md';
const BODY = 'Task.\n\n## Steps\n\n- [x] one\n- [ ] two\n';

async function setup(): Promise<FakeVault> {
	const v = new FakeVault({ settings: { reviewStatus: 'in-review', identity: 'sheikh' } });
	v.addTask(T, { status: 'in-progress', dateCreated: '2026-10-23T08:00:00+01:00' }, BODY);
	await v.start();
	await v.plugin.tracker.reconcile();
	return v;
}

function lineOf(v: FakeVault, text: string): { index: number; raw: string } {
	const lines = (v.notes.get(T) ?? '').split('\n');
	const index = lines.findIndex((l) => l.includes(text));
	return { index, raw: lines[index] ?? '' };
}

test('editLine: ticks the exact line, and a window tick never moves the task (no auto-stage)', async () => {
	const v = await setup();
	const { index, raw } = lineOf(v, '- [ ] two');
	assert.equal(await v.plugin.tracker.editLine(v.file(T), index, raw, toggledLine(raw, true)), 'ok');
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	assert.equal(lineOf(v, 'two').raw, '- [x] two');
	assert.equal(v.fm(T).status, 'in-progress', 'all boxes ticked from the window: still in progress');
});

test('control: the same last tick made in the note itself does move the task to review', async () => {
	const v = await setup();
	v.notes.set(T, (v.notes.get(T) ?? '').replace('- [ ] two', '- [x] two'));
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	assert.equal(v.fm(T).status, 'in-review');
});

test('editLine: a line that changed since the window drew it is never overwritten', async () => {
	const v = await setup();
	const { index, raw } = lineOf(v, '- [ ] two');
	v.notes.set(T, (v.notes.get(T) ?? '').replace('- [ ] two', '- [ ] two, edited meanwhile'));
	const before = v.notes.get(T);
	assert.equal(await v.plugin.tracker.editLine(v.file(T), index, raw, toggledLine(raw, true)), 'stale');
	assert.equal(v.notes.get(T), before);
});

test('editLine: dry run and a vault without writes allowed change nothing', async () => {
	const v = await setup();
	const { index, raw } = lineOf(v, '- [ ] two');
	v.data.settings.dryRun = true;
	const before = v.notes.get(T);
	assert.equal(await v.plugin.tracker.editLine(v.file(T), index, raw, toggledLine(raw, true)), 'blocked');
	v.data.settings.dryRun = false;
	v.data.settings.allowedVaults = [];
	assert.equal(await v.plugin.tracker.editLine(v.file(T), index, raw, toggledLine(raw, true)), 'blocked');
	assert.equal(v.notes.get(T), before);
});

test('editLine: a stale window edit does not suppress a later real tick', async () => {
	const v = await setup();
	const { index, raw } = lineOf(v, '- [ ] two');
	v.notes.set(T, (v.notes.get(T) ?? '').replace('- [ ] two', '- [ ] two!'));
	assert.equal(await v.plugin.tracker.editLine(v.file(T), index, raw, toggledLine(raw, true)), 'stale');
	v.notes.set(T, (v.notes.get(T) ?? '').replace('- [ ] two!', '- [x] two!'));
	v.plugin.tracker.onMetadataChanged(v.file(T));
	await runTimers();
	assert.equal(v.fm(T).status, 'in-review', 'the hand tick still fires auto-stage');
});
