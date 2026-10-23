import { TaskNotesConfig, priorityFor } from '../tasknotes';

/**
 * 0.2.4: the task's priority as a small pill, in TaskNotes' own label and colour.
 * Nothing is shown when the task has no priority or one TaskNotes doesn't list.
 */
export function renderPriorityPill(parent: HTMLElement, cfg: TaskNotesConfig, value: unknown): void {
	const p = priorityFor(cfg, value);
	if (!p) return;
	const pill = parent.createSpan({ cls: 'sheiko-priority', text: p.label, attr: { title: `Priority: ${p.label}` } });
	if (p.color) pill.setCssProps({ '--sheiko-priority-color': p.color });
}
