// v0.2.0: history/context placement fix, and the sign-off window's per-task context
// (worker, summary, facts). Pure functions, no vault needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	CONTEXT_HEADING,
	DEFAULT_WEEK,
	HISTORY_HEADING,
	appendToSection,
	isContextEntry,
	isHistoryEntry,
	parseHistory,
} from '../src/lifecycle';
import { SENT_BACK_NOTE, classifyWorker, computeFacts, describeTask, latestContext, workerLabel } from '../src/review';

// The real shape found 2026-10-05: a description typed under `## Status History` on a new task.
const TYPED_UNDER_HISTORY = [
	'---',
	'status: in-progress',
	'---',
	'',
	'## Status History',
	'',
	'- 2026-10-05T11:18:59+01:00 — created → open',
	'',
	'',
	'Need to work on a few things and test through',
	'- 2026-10-05T11:21:19+01:00 — open → in-progress',
	'',
].join('\n');

test('history line goes after the last entry, not after text typed in the section', () => {
	const out = appendToSection(TYPED_UNDER_HISTORY, HISTORY_HEADING, '- 2026-10-05T11:23:33+01:00 — in-progress → in-review', isHistoryEntry);
	const lines = out.split('\n');
	const i = lines.indexOf('- 2026-10-05T11:21:19+01:00 — open → in-progress');
	assert.equal(lines[i + 1], '- 2026-10-05T11:23:33+01:00 — in-progress → in-review');
	assert.equal(parseHistory(out).length, 3);
});

test('history on a section with only user text: entry goes directly under the heading, text kept below', () => {
	const content = '## Status History\n\nMy description\n';
	const out = appendToSection(content, HISTORY_HEADING, '- 2026-10-05T11:18:59+01:00 — created → open', isHistoryEntry);
	assert.equal(out, '## Status History\n\n- 2026-10-05T11:18:59+01:00 — created → open\n\nMy description\n');
	const again = appendToSection(out, HISTORY_HEADING, '- 2026-10-05T11:21:19+01:00 — open → in-progress', isHistoryEntry);
	assert.ok(again.indexOf('open → in-progress') < again.indexOf('My description'));
});

test('empty or missing section: unchanged behaviour', () => {
	assert.equal(appendToSection('Body', HISTORY_HEADING, '- x', isHistoryEntry), 'Body\n\n## Status History\n\n- x\n');
	assert.equal(appendToSection('## Status History\n', HISTORY_HEADING, '- x', isHistoryEntry), '## Status History\n\n- x\n');
});

test('context entries: same placement rule, and multi-paragraph sections stop at the next heading', () => {
	const content = `${CONTEXT_HEADING}\n\n- **2026-10-05T11:23:02+01:00 — sheikh:** first\nnotes typed here\n\n## Other\n`;
	const out = appendToSection(content, CONTEXT_HEADING, '- **2026-10-05T12:00:00+01:00 — sheikh:** second', isContextEntry);
	assert.ok(out.indexOf('second') < out.indexOf('notes typed here'));
	assert.ok(out.indexOf('second') < out.indexOf('## Other'));
});

test('worker: names on the agent list are AI, others human, missing is not recorded', () => {
	const agents = ['test-agent-alpha', 'Test-Agent-Beta'];
	assert.deepEqual(classifyWorker('test-agent-alpha', agents), { kind: 'ai', names: ['test-agent-alpha'] });
	assert.equal(classifyWorker('test-agent-beta', agents).kind, 'ai'); // case-insensitive
	assert.equal(classifyWorker('sheikh', agents).kind, 'human');
	assert.equal(classifyWorker(['[[test-agent-alpha]]', 'sheikh'], agents).kind, 'mixed');
	assert.equal(classifyWorker('[[People/Sam|Sam]]', agents).names[0], 'Sam');
	assert.equal(classifyWorker(undefined, agents).kind, 'unknown');
	assert.equal(classifyWorker('', agents).kind, 'unknown');
	assert.equal(classifyWorker('test-agent-alpha', []).kind, 'human'); // empty list: nobody is assumed to be AI
	assert.equal(workerLabel(classifyWorker(undefined, agents)), 'Worker: not recorded');
	assert.equal(workerLabel(classifyWorker('test-agent-alpha', agents)), 'AI agent: test-agent-alpha');
});

test('summary: body text only, Sheiko entries, headings, checkboxes and Lifecycle Summary removed', () => {
	assert.equal(describeTask(TYPED_UNDER_HISTORY), 'Need to work on a few things and test through');
	const note = [
		'---',
		'status: in-review',
		'---',
		'# Title',
		'Write the intro.',
		'- [x] draft',
		'- [ ] polish',
		'- a plain bullet',
		'## Lifecycle Summary',
		'| Field | Value |',
		'## Context',
		'- **2026-10-05T11:23:02+01:00 — sheikh:** not part of the description',
	].join('\n');
	assert.equal(describeTask(note), 'Write the intro. a plain bullet');
	assert.equal(describeTask('---\na: 1\n---\n'), '');
	const long = describeTask(`---\na: 1\n---\n${'word '.repeat(60)}`, 20);
	assert.equal(long.length, 20);
	assert.ok(long.endsWith('…'));
});

test('latest context: the last entry, with or without an author', () => {
	const c = `${CONTEXT_HEADING}\n\n- **2026-10-05T11:00:00+01:00 — sheikh:** first\n- **2026-10-05T12:00:00+01:00:** second, no author\n`;
	assert.deepEqual(latestContext(c), { at: '2026-10-05T12:00:00+01:00', who: '', text: 'second, no author' });
	assert.equal(latestContext('no context'), null);
});

test('facts: time in progress, review start, sent back count, overdue', () => {
	const history = parseHistory(
		[
			'## Status History',
			'- 2026-10-05T09:00:00+01:00 — created → open',
			'- 2026-10-05T09:30:00+01:00 — open → in-progress',
			'- 2026-10-05T10:00:00+01:00 — in-progress → in-review',
			`- 2026-10-05T10:10:00+01:00 — in-review → in-progress (${SENT_BACK_NOTE})`,
			'- 2026-10-05T10:40:00+01:00 — in-progress → in-review',
		].join('\n'),
	);
	const f = computeFacts({
		history,
		now: new Date('2026-10-05T12:00:00+01:00'),
		schedule: DEFAULT_WEEK,
		progressStatus: 'in-progress',
		reviewStatus: 'in-review',
		checklist: { done: 2, total: 3 },
		due: '2026-10-05T11:00',
	});
	assert.equal(f.progressMinutes, 60);
	assert.equal(f.inReviewSince?.toISOString(), new Date('2026-10-05T10:40:00+01:00').toISOString());
	assert.equal(f.sentBack, 1);
	assert.equal(f.overdue, true);
	const dateOnly = computeFacts({ history: [], now: new Date('2026-10-05T23:00:00+01:00'), schedule: DEFAULT_WEEK, progressStatus: 'in-progress', reviewStatus: 'in-review', checklist: null, due: '2026-10-05' });
	assert.equal(dateOnly.overdue, false); // due today, not yet past
	assert.equal(dateOnly.progressMinutes, null);
});
