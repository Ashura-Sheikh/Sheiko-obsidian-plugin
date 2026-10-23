// Reads TaskNotes' own configuration so Sheiko follows it instead of hardcoding
// status names or field names. Only reads; never writes TaskNotes' settings.

import { App, TFile, normalizePath } from 'obsidian';

export interface TaskNotesStatus {
	value: string;
	label: string;
	isCompleted: boolean;
	order: number;
}

/** 0.2.4: one of TaskNotes' priorities, for the pill on sign-off cards. */
export interface TaskNotesPriority {
	value: string;
	label: string;
	/** A #rgb / #rrggbb colour, or null if TaskNotes' value isn't one. */
	color: string | null;
	weight: number;
}

export interface TaskNotesConfig {
	found: boolean;
	version: string | null;
	identification: 'tag' | 'property';
	taskTag: string;
	taskPropertyName: string;
	taskPropertyValue: string;
	statuses: TaskNotesStatus[];
	/** 0.2.4: TaskNotes' priority list. Empty if it has none; then no pills are shown. */
	priorities: TaskNotesPriority[];
	field: {
		status: string;
		completedDate: string;
		dateCreated: string;
		scheduled: string;
		due: string;
		timeEntries: string;
		priority: string;
		title: string;
		recurrence: string;
		archiveTag: string;
	};
}

const FALLBACK: TaskNotesConfig = {
	found: false,
	version: null,
	identification: 'tag',
	taskTag: 'task',
	taskPropertyName: '',
	taskPropertyValue: '',
	statuses: [
		{ value: 'open', label: 'Open', isCompleted: false, order: 1 },
		{ value: 'in-progress', label: 'In progress', isCompleted: false, order: 2 },
		{ value: 'in-review', label: 'In Review', isCompleted: false, order: 3 },
		{ value: 'done', label: 'Done', isCompleted: true, order: 4 },
	],
	priorities: [],
	field: {
		status: 'status',
		completedDate: 'completedDate',
		dateCreated: 'dateCreated',
		scheduled: 'scheduled',
		due: 'due',
		timeEntries: 'timeEntries',
		priority: 'priority',
		title: 'title',
		recurrence: 'recurrence',
		archiveTag: 'archived',
	},
};

interface RawStatus {
	value?: unknown;
	label?: unknown;
	isCompleted?: unknown;
	order?: unknown;
}

interface RawTaskNotesData {
	taskIdentificationMethod?: unknown;
	taskTag?: unknown;
	taskPropertyName?: unknown;
	taskPropertyValue?: unknown;
	customStatuses?: RawStatus[];
	customPriorities?: { value?: unknown; label?: unknown; color?: unknown; weight?: unknown }[];
	fieldMapping?: Record<string, unknown>;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 0.2.4: TaskNotes' priorities, read-only. Colours that aren't plain hex are dropped, never passed to CSS as-is. */
export function readPriorities(raw: RawTaskNotesData['customPriorities']): TaskNotesPriority[] {
	return (Array.isArray(raw) ? raw : [])
		.filter((p) => typeof p?.value === 'string' && p.value.length > 0)
		.map((p, i) => ({
			value: p.value as string,
			label: str(p.label, p.value as string),
			color: typeof p.color === 'string' && HEX_COLOR.test(p.color.trim()) ? p.color.trim() : null,
			weight: typeof p.weight === 'number' ? p.weight : i,
		}));
}

/** The priority a task's field value names, or null (no value, or one TaskNotes doesn't list). */
export function priorityFor(cfg: TaskNotesConfig, value: unknown): TaskNotesPriority | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	return cfg.priorities.find((p) => p.value === value.trim()) ?? null;
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length > 0 ? v : fallback);

/**
 * Reads `.obsidian/plugins/tasknotes/{data,manifest}.json` from disk.
 * `found` is true only when TaskNotes is installed AND enabled (listed in
 * `community-plugins.json`). When it's false, Sheiko does nothing.
 */
export async function loadTaskNotesConfig(app: App): Promise<TaskNotesConfig> {
	const dir = normalizePath(`${app.vault.configDir}/plugins/tasknotes`);
	const adapter = app.vault.adapter;
	try {
		if (!(await adapter.exists(`${dir}/data.json`))) return FALLBACK;
		const enabledPath = normalizePath(`${app.vault.configDir}/community-plugins.json`);
		if (!(await adapter.exists(enabledPath))) return FALLBACK;
		const enabled: unknown = JSON.parse(await adapter.read(enabledPath));
		if (!Array.isArray(enabled) || !enabled.includes('tasknotes')) return FALLBACK;
		const raw = JSON.parse(await adapter.read(`${dir}/data.json`)) as RawTaskNotesData;
		let version: string | null = null;
		if (await adapter.exists(`${dir}/manifest.json`)) {
			const man = JSON.parse(await adapter.read(`${dir}/manifest.json`)) as { version?: unknown };
			version = typeof man.version === 'string' ? man.version : null;
		}
		const fm = raw.fieldMapping ?? {};
		const statuses: TaskNotesStatus[] = (raw.customStatuses ?? [])
			.filter((s) => typeof s.value === 'string')
			.map((s, i) => ({
				value: s.value as string,
				label: str(s.label, s.value as string),
				isCompleted: s.isCompleted === true,
				order: typeof s.order === 'number' ? s.order : i,
			}));
		return {
			found: true,
			version,
			identification: raw.taskIdentificationMethod === 'property' ? 'property' : 'tag',
			taskTag: str(raw.taskTag, 'task'),
			taskPropertyName: str(raw.taskPropertyName, ''),
			taskPropertyValue: str(raw.taskPropertyValue, ''),
			statuses: statuses.length ? statuses : FALLBACK.statuses,
			priorities: readPriorities(raw.customPriorities),
			field: {
				status: str(fm.status, 'status'),
				completedDate: str(fm.completedDate, 'completedDate'),
				dateCreated: str(fm.dateCreated, 'dateCreated'),
				scheduled: str(fm.scheduled, 'scheduled'),
				due: str(fm.due, 'due'),
				timeEntries: str(fm.timeEntries, 'timeEntries'),
				priority: str(fm.priority, 'priority'),
				title: str(fm.title, 'title'),
				recurrence: str(fm.recurrence, 'recurrence'),
				archiveTag: str(fm.archiveTag, 'archived'),
			},
		};
	} catch (e) {
		console.error('[Sheiko] Could not read TaskNotes config, using defaults', e);
		return FALLBACK;
	}
}

export function tagList(fm: Record<string, unknown>): string[] {
	const t = fm.tags;
	const arr = Array.isArray(t) ? t : typeof t === 'string' ? t.split(/[,\s]+/) : [];
	return arr.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/^#/, '').trim());
}

export function isTaskFile(app: App, file: TFile, cfg: TaskNotesConfig): boolean {
	if (file.extension !== 'md') return false;
	const fm: Record<string, unknown> | undefined = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return false;
	if (cfg.identification === 'property') {
		if (!cfg.taskPropertyName) return false;
		const v = fm[cfg.taskPropertyName];
		return cfg.taskPropertyValue ? String(v) === cfg.taskPropertyValue : v !== undefined && v !== null;
	}
	return tagList(fm).includes(cfg.taskTag);
}

export function statusOf(app: App, file: TFile, cfg: TaskNotesConfig): string | null {
	const fm: Record<string, unknown> | undefined = app.metadataCache.getFileCache(file)?.frontmatter;
	const v = fm?.[cfg.field.status];
	return typeof v === 'string' && v.length ? v : null;
}

export function isCompletedStatus(cfg: TaskNotesConfig, status: string | null): boolean {
	return status !== null && cfg.statuses.some((s) => s.value === status && s.isCompleted);
}

export function labelFor(cfg: TaskNotesConfig, status: string): string {
	return cfg.statuses.find((s) => s.value === status)?.label ?? status;
}

export function hasStatus(cfg: TaskNotesConfig, status: string): boolean {
	return cfg.statuses.some((s) => s.value === status);
}

export function orderOf(cfg: TaskNotesConfig, status: string | null): number {
	return cfg.statuses.find((s) => s.value === status)?.order ?? -1;
}
