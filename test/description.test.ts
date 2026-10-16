// v0.2.3 (#6): the sign-off window's description skips template lines, keeps its
// Markdown, and is measured for "Show more". Pure functions, no vault needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESCRIPTION_SHORT, describeTask, isTemplateLine, plainLength, taskDescription } from '../src/review';

// The shape that showed the bug: a template status field first, then the real description.
const HANDOFF_SHAPE = [
	'---',
	'status: in-review',
	'tags: [task]',
	'---',
	'',
	'**Status:** `INPUT[inlineSelect(option(open, Open), option(in-progress, In Progress), option(in-review, In Review)):status]` *(flips via the pill for Done)*',
	'',
	'## Why this is going to you',
	'',
	'The team agreed the **new layout** today; see [[Design notes|the notes]].',
	'',
	'A second paragraph of the same section.',
	'',
	'## Context',
	'',
	'- not part of the first section',
].join('\n');

test('template lines: Meta Bind INPUT/VIEW fields, with or without a label', () => {
	assert.ok(isTemplateLine('**Status:** `INPUT[inlineSelect(option(a)):status]` *(note)*'));
	assert.ok(isTemplateLine('`INPUT[text:title]`'));
	assert.ok(isTemplateLine('Due: `VIEW[{due}]`'));
	assert.ok(!isTemplateLine('Use the INPUT field on the form.'));
	assert.ok(!isTemplateLine('Ordinary `code` in a sentence.'));
});

test('taskDescription: starts at the first real section, keeps Markdown, stops at the next heading', () => {
	assert.equal(
		taskDescription(HANDOFF_SHAPE),
		'The team agreed the **new layout** today; see [[Design notes|the notes]].\n\nA second paragraph of the same section.',
	);
});

test('taskDescription: meta-bind code blocks, checkboxes and Sheiko entries are skipped', () => {
	const note = [
		'---',
		'status: in-review',
		'---',
		'```meta-bind-button',
		'label: Done',
		'```',
		'- [x] a checkbox',
		'## Status History',
		'',
		'- 2026-10-16T18:11:23+01:00 — open → in-progress',
		'',
		'Typed under the history heading, still the description.',
		'## Context',
		'- **2026-10-16T18:11:46+01:00:** a context entry',
	].join('\n');
	assert.equal(taskDescription(note), 'Typed under the history heading, still the description.');
});

test('taskDescription: empty when the note has no description', () => {
	assert.equal(taskDescription('---\na: 1\n---\n'), '');
	assert.equal(taskDescription('---\na: 1\n---\n**Status:** `INPUT[text:x]`\n## Heading\n'), '');
});

test('describeTask (plain one-liner) skips template lines too', () => {
	assert.equal(
		describeTask(HANDOFF_SHAPE, 300),
		'The team agreed the **new layout** today; see [[Design notes|the notes]]. A second paragraph of the same section. not part of the first section',
	);
	assert.ok(!describeTask(HANDOFF_SHAPE).includes('INPUT['));
});

test('plainLength: counts what the reader sees, for the Show more cut-off', () => {
	assert.equal(plainLength('[[Note|Alias]] **x**'), 'Alias x'.length);
	assert.equal(plainLength('[[Note]] and [text](https://example.com)'), 'Note and text'.length);
	assert.equal(plainLength('a\n\n  b'), 'a b'.length);
	assert.equal(DESCRIPTION_SHORT, 300);
	assert.ok(!(plainLength('x'.repeat(300)) > DESCRIPTION_SHORT), 'exactly 300: no Show more');
	assert.ok(plainLength('x'.repeat(301)) > DESCRIPTION_SHORT, '301: Show more');
});
