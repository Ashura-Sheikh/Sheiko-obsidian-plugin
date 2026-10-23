// 0.2.4: age bands in the sign-off window. Separate bands, clock time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageBands, parseBandHours, reviewSince } from '../src/age-bands';

const NOW = new Date('2026-10-23T20:00:00+01:00');
const ago = (h: number): Date => new Date(NOW.getTime() - h * 3600 * 1000);

test('bands are separate: each task in exactly one band, the last band open-ended', () => {
	const items = [
		{ path: 'a', since: ago(1) }, // under 3h: no band
		{ path: 'b', since: ago(3) }, // exactly 3h: first band
		{ path: 'c', since: ago(5.99) },
		{ path: 'd', since: ago(6) }, // exactly 6h: second band, not the first
		{ path: 'e', since: ago(11) },
		{ path: 'f', since: ago(30) },
		{ path: 'g', since: ago(200) },
		{ path: 'h', since: null }, // no review time: no band
	];
	const b = ageBands(items, NOW, [3, 6, 12, 24]);
	assert.deepEqual(b.map((x) => x.label), ['>3h', '>6h', '>12h', '>24h']);
	assert.deepEqual(b.map((x) => x.paths), [['b', 'c'], ['d', 'e'], [], ['f', 'g']]);
	assert.deepEqual(b.map((x) => x.range), ['3–6 hours', '6–12 hours', '12–24 hours', 'over 24 hours']);
});

test('clock time: nights and weekends count in full', () => {
	const fridayEvening = new Date('2026-10-23T17:00:00+01:00');
	const mondayMorning = new Date('2026-10-26T09:00:00Z');
	const b = ageBands([{ path: 'x', since: fridayEvening }], mondayMorning, [3, 6, 12, 24]);
	assert.deepEqual(b[3]?.paths, ['x']);
});

test('band hours from settings text: rising positive numbers only', () => {
	assert.deepEqual(parseBandHours('3, 6, 12, 24'), [3, 6, 12, 24]);
	assert.deepEqual(parseBandHours(' 1,2.5 ,48'), [1, 2.5, 48]);
	assert.equal(parseBandHours(''), null);
	assert.equal(parseBandHours('3, 3, 6'), null);
	assert.equal(parseBandHours('6, 3'), null);
	assert.equal(parseBandHours('0, 3'), null);
	assert.equal(parseBandHours('3, six'), null);
});

test('reviewSince: the last time the task entered review', () => {
	const h = [
		{ at: new Date('2026-10-23T09:00:00+01:00'), to: 'in-review' },
		{ at: new Date('2026-10-23T10:00:00+01:00'), to: 'in-progress' },
		{ at: new Date('2026-10-23T11:00:00+01:00'), to: 'in-review' },
	];
	assert.equal(reviewSince(h, 'in-review')?.toISOString(), '2026-10-23T10:00:00.000Z');
	assert.equal(reviewSince(h, ''), null);
	assert.equal(reviewSince([], 'in-review'), null);
});
