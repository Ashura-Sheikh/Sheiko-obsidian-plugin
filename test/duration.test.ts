// v0.2.3 (#4): durations shown to the second when it matters, and no misleading 0m.
// Cases built from the 2026-10-16 main-vault trial (Test 1: pill close; Test 2: closed by hand).
// Pure functions, no vault needed. Runs in Europe/Dublin (see run.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	DEFAULT_WEEK,
	buildSummary,
	closureTimes,
	computeDurations,
	formatDuration,
	formatSplit,
	parseHistory,
	roundToSum,
	splitBuckets,
} from '../src/lifecycle';

const at = (s: string): Date => new Date(s);
const label = (s: string): string => s;

test('formatDuration: seconds under a minute, m+s under an hour, as before from an hour', () => {
	assert.equal(formatDuration(0), '0s');
	assert.equal(formatDuration(9_000), '9s');
	assert.equal(formatDuration(59_000), '59s');
	assert.equal(formatDuration(59_600), '1m'); // rounds up to a whole minute, not "60s"
	assert.equal(formatDuration(60_000), '1m');
	assert.equal(formatDuration(388_000), '6m 28s');
	assert.equal(formatDuration(3_599_600), '1h'); // just under an hour: no "60m 0s"
	assert.equal(formatDuration(3_600_000), '1h');
	assert.equal(formatDuration(3_900_000 + 29_000), '1h 5m'); // seconds dropped from an hour up
	assert.equal(formatDuration(25 * 3_600_000), '1d 1h');
	assert.equal(formatDuration(-5), '0s');
});

test('roundToSum: the parts always add up to the rounded total', () => {
	for (const parts of [
		[400, 400, 400],
		[1_499, 1_499, 0],
		[59_700, 300, 0],
		[123_456, 7_890, 1_234],
		[0, 0, 0],
	]) {
		for (const unit of [1_000, 60_000]) {
			const [total, ...rest] = roundToSum(parts, unit);
			assert.equal(rest.reduce((a, b) => a + b, 0), total, `${parts.join(',')} @ ${unit}`);
			assert.equal(total, Math.round(parts.reduce((a, b) => a + b, 0) / unit));
		}
	}
});

test('formatSplit: one unit per row, chosen from the total', () => {
	assert.deepEqual(formatSplit({ working: 0, overnight: 388_000, weekend: 0 }), {
		total: '6m 28s',
		working: '0s',
		overnight: '6m 28s',
		weekend: '0s',
	});
	const long = formatSplit({ working: 2 * 3_600_000 + 30_000, overnight: 45_000, weekend: 0 });
	assert.equal(long.total, '2h 1m');
	// 2h 0m 30s working + 45s overnight = 2h 1m 15s → 2h 1m. The leftover minute goes to the
	// bigger remainder (overnight's 45s beats working's 30s), so the parts still add up.
	assert.equal(long.working, '2h');
	assert.equal(long.overnight, '1m');
});

test('splitBuckets (frontmatter, whole minutes) is unchanged', () => {
	// Friday 2026-10-16, default week 09:00–17:00: 16:50 → 17:20 is 10 working + 20 overnight.
	assert.deepEqual(splitBuckets(at('2026-10-16T16:50:00+01:00'), at('2026-10-16T17:20:00+01:00'), DEFAULT_WEEK), {
		working: 10,
		overnight: 20,
		weekend: 0,
	});
});

const TEST1_HISTORY = parseHistory(
	[
		'## Status History',
		'',
		'- 2026-10-16T18:11:23+01:00 — open → in-progress',
		'- 2026-10-16T18:11:32+01:00 — in-progress → in-review',
		'- 2026-10-16T18:11:49+01:00 — in-review → done',
	].join('\n'),
);

test('computeDurations: short stays keep their seconds (Test 1: 9s in progress, 17s in review)', () => {
	const rep = computeDurations(TEST1_HISTORY, at('2026-10-16T18:11:49+01:00'), DEFAULT_WEEK);
	const by = Object.fromEntries(rep.perStatus.map((s) => [s.status, s]));
	assert.equal(by['in-progress']?.ms, 9_000);
	assert.equal(by['in-review']?.ms, 17_000);
	assert.equal(formatDuration(by['in-progress']?.ms ?? -1), '9s');
	assert.equal(formatDuration(by['in-review']?.ms ?? -1), '17s');
	// Minutes are now rounded once from the exact time, and the buckets still sum to them.
	for (const s of rep.perStatus) {
		assert.equal(s.buckets.working + s.buckets.overnight + s.buckets.weekend, s.minutes);
		assert.equal(s.bucketsMs.working + s.bucketsMs.overnight + s.bucketsMs.weekend, s.ms);
	}
});

test('summary, closed by Sheiko (Test 1): exact time to close, stored minutes kept in brackets, seconds per status', () => {
	const lines = buildSummary({
		history: TEST1_HISTORY,
		end: at('2026-10-16T18:11:49+01:00'),
		writtenAt: at('2026-10-16T18:11:49+01:00'),
		schedule: DEFAULT_WEEK,
		label,
		closure: {
			created: '2026-10-16T18:05:21+01:00',
			completed: '2026-10-16T18:11:49+01:00',
			closedBy: undefined,
			timeToClose: 6,
			working: 0,
			overnight: 6,
			weekend: 0,
			seenLive: true,
		},
	});
	assert.ok(lines.includes('| Time to close | 6m 28s (6 min) |'), lines.join('\n'));
	assert.ok(lines.includes('| – overnight | 6m 28s |'));
	assert.ok(lines.includes('| – working | 0s |'));
	assert.ok(!lines.some((l) => l.startsWith('| Split |')), 'split was recorded, so not marked as worked out');
	assert.ok(lines.includes('| in-progress | 9s | 0s | 9s | 0s |'), lines.join('\n'));
	assert.ok(lines.includes('| in-review | 17s | 0s | 17s | 0s |'));
	assert.ok(!lines.some((l) => / 0m /.test(l)), 'no misleading 0m anywhere');
});

test('summary, closed by hand (Test 2): split worked out and marked, never 0m/0m/0m', () => {
	const lines = buildSummary({
		history: [],
		end: at('2026-10-16T18:14:21+01:00'),
		writtenAt: at('2026-10-16T18:14:21+01:00'),
		schedule: DEFAULT_WEEK,
		label,
		closure: {
			created: '2026-10-16T18:05:21+01:00',
			completed: '2026-10-16T18:14:21+01:00',
			closedBy: 'technical-lead',
			timeToClose: 9,
			working: undefined,
			overnight: undefined,
			weekend: undefined,
			seenLive: false,
		},
	});
	assert.ok(lines.includes('| Time to close | 9m (9 min) |'), lines.join('\n'));
	assert.ok(lines.includes('| – overnight | 9m |'));
	assert.ok(lines.includes('| Split | Worked out from Created and Completed (not recorded at close) |'));
});

test('summary, date-only completedDate: "—", not 0m', () => {
	const base = {
		history: [],
		end: at('2026-10-16T18:14:21+01:00'),
		writtenAt: at('2026-10-16T18:14:21+01:00'),
		schedule: DEFAULT_WEEK,
		label,
	};
	const noSplit = buildSummary({
		...base,
		closure: {
			created: '2026-10-16T18:05:21+01:00',
			completed: '2026-10-16',
			closedBy: undefined,
			timeToClose: 9,
			working: undefined,
			overnight: undefined,
			weekend: undefined,
			seenLive: false,
		},
	});
	assert.ok(noSplit.includes('| Time to close | 9m (9 min) |'), noSplit.join('\n'));
	assert.ok(noSplit.includes('| – working / overnight / weekend | — |'));
	assert.ok(!noSplit.some((l) => /\| 0m \|/.test(l)));
	const nothing = buildSummary({
		...base,
		closure: {
			created: '2026-10-16',
			completed: '2026-10-16',
			closedBy: undefined,
			timeToClose: undefined,
			working: undefined,
			overnight: undefined,
			weekend: undefined,
			seenLive: false,
		},
	});
	assert.ok(nothing.includes('| Time to close | — |'));
});

test('closureTimes: stored minutes used only when the timestamps can’t be', () => {
	const stored = closureTimes('2026-10-16', '2026-10-16', { working: 60, overnight: 5, weekend: 0 }, DEFAULT_WEEK);
	assert.deepEqual(stored, {
		split: { total: '1h 5m', working: '1h', overnight: '5m', weekend: '0m' },
		workedOut: false,
	});
	assert.equal(closureTimes('2026-10-16', '2026-10-16', { working: 1, overnight: undefined, weekend: 0 }, DEFAULT_WEEK), null);
	// Completed before Created (bad data): fall back, don't show a negative time.
	assert.equal(
		closureTimes('2026-10-16T18:00:00+01:00', '2026-10-16T17:00:00+01:00', { working: undefined, overnight: undefined, weekend: undefined }, DEFAULT_WEEK),
		null,
	);
});
