// Reads TaskNotes' own configuration so Sheiko follows it instead of hardcoding
// status names or field names. Only reads; never writes TaskNotes' settings.

import { App, TFile, normalizePath } from 'obsidian';

export interface TaskNotesStatus {
	value: string;
	label: string;
	isCompleted: boolean;
	order: number;
}

export interface TaskNotesConfig {
	found: boolean;
	version: string | null;
	identification: 'tag' | 'property';
	taskTag: string;
	taskPropertyName: string;
	taskPropertyValue: string;
	statuses: TaskNotesStatus[];
	field: {
		status: string;
		completedDate: string;
		dateCreated: string;
		scheduled: string;
		due: string;
		timeEntries: string;
		priority: string;
		title: string;
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
	field: {
		status: 'status',
		completedDate: 'completedDate',
		dateCreated: 'dateCreated',
		scheduled: 'scheduled',
		due: 'due',
		timeEntries: 'timeEntries',
		priority: 'priority',
		title: 'title',
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
	fieldMapping?: Record<string, unknown>;
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length > 0 ? v : fallback);

/** Reads `.obsidian/plugins/tasknotes/{data,manifest}.json` from disk. */
export async function loadTaskNotesConfig(app: App): Promise<TaskNotesConfig> {
	const dir = normalizePath(`${app.vault.configDir}/plugins/tasknotes`);
	const adapter = app.vault.adapter;
	try {
		if (!(await adapter.exists(`${dir}/data.json`))) return FALLBACK;
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
			field: {
				status: str(fm.status, 'status'),
				completedDate: str(fm.completedDate, 'completedDate'),
				dateCreated: str(fm.dateCreated, 'dateCreated'),
				scheduled: str(fm.scheduled, 'scheduled'),
				due: str(fm.due, 'due'),
				timeEntries: str(fm.timeEntries, 'timeEntries'),
				priority: str(fm.priority, 'priority'),
				title: str(fm.title, 'title'),
			},
		};
	} catch (e) {
		console.error('[Sheiko] Could not read TaskNotes config, using defaults', e);
		return FALLBACK;
	}
}

function tagList(fm: Record<string, unknown>): string[] {
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
