// 0.2.4: priority pills read TaskNotes' own priority list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault } from './fake-vault';
import { priorityFor, readPriorities } from '../src/tasknotes';

const RAW = [
	{ value: 'none', label: 'None', color: '#cccccc', weight: 0 },
	{ value: 'low', label: 'Low', color: '#00aa00', weight: 1 },
	{ value: 'high', label: 'High', color: '#ff0000', weight: 3 },
];

test('priorities: read from TaskNotes, labels and hex colours kept', () => {
	const p = readPriorities(RAW);
	assert.deepEqual(p.map((x) => [x.value, x.label, x.color]), [
		['none', 'None', '#cccccc'],
		['low', 'Low', '#00aa00'],
		['high', 'High', '#ff0000'],
	]);
});

test('priorities: a colour that is not plain hex is dropped, never passed to CSS', () => {
	const p = readPriorities([
		{ value: 'a', label: 'A', color: 'red; background: url(x)' },
		{ value: 'b', label: 'B', color: '#12345' },
		{ value: 'c', color: '#abc' },
		{ label: 'no value' },
	]);
	assert.deepEqual(p.map((x) => [x.value, x.label, x.color]), [
		['a', 'A', null],
		['b', 'B', null],
		['c', 'c', '#abc'],
	]);
	assert.deepEqual(readPriorities(undefined), []);
});

test('priorityFor: a listed value gets its pill; missing or unknown values get none', async () => {
	const v = new FakeVault();
	v.config.set('.obsidian/plugins/tasknotes/data.json', JSON.stringify({ customStatuses: [{ value: 'open', label: 'Open', order: 1 }], customPriorities: RAW }));
	await v.start();
	const cfg = v.plugin.taskNotes;
	assert.equal(priorityFor(cfg, 'high')?.label, 'High');
	assert.equal(priorityFor(cfg, ' low ')?.label, 'Low');
	assert.equal(priorityFor(cfg, 'urgent'), null);
	assert.equal(priorityFor(cfg, undefined), null);
	assert.equal(priorityFor(cfg, ''), null);
});

test('priorityFor: TaskNotes with no priority list = no pills', async () => {
	const v = new FakeVault();
	await v.start();
	assert.deepEqual(v.plugin.taskNotes.priorities, []);
	assert.equal(priorityFor(v.plugin.taskNotes, 'high'), null);
});
