import { App, FileSystemAdapter, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type SheikoPlugin from './main';
import { DEFAULT_WEEK, WeekSchedule } from './lifecycle';

export interface SheikoSettings {
	/** Written as `closedBy` and in Context entries. Blank = no `closedBy` is written. */
	identity: string;
	/** Per weekday (0 = Sunday), start/end of working hours. End is also the roll cutoff (Phase 3). */
	week: WeekSchedule;
	/** Absolute vault paths Sheiko is allowed to write in. Empty = writes disabled everywhere. */
	allowedVaults: string[];
	/** Log intended writes instead of making them. */
	dryRun: boolean;
	/** Cap on files edited by one batch run (startup catch-up and auto-roll). */
	maxEditsPerRun: number;
	// ---- Phase 2 ----
	/** TaskNotes status values Sheiko moves tasks to / prompts on. */
	progressStatus: string;
	reviewStatus: string;
	doneStatus: string;
	/** Timer started → move to progressStatus (only from an earlier status). */
	autoStageTimer: boolean;
	/** All checkboxes ticked → move to reviewStatus. */
	autoStageChecklist: boolean;
	/** Prompt for sign-off when a task enters reviewStatus. */
	promptOnReview: boolean;
	/** Prompt at the daily cutoff for everything still in reviewStatus. */
	promptAtCutoff: boolean;
	/** Frontmatter field naming who worked on a task, shown in the sign-off window. */
	workerField: string;
	/** Names in workerField that are AI agents (case-insensitive). Any other name shows as human. */
	agentNames: string[];
	/** Show "N awaiting sign-off" in the status bar. */
	statusBarCount: boolean;
	// ---- Phase 3 ----
	/** At each day's end time, roll unfinished tasks' `scheduled` to the next day. */
	autoRoll: boolean;
}

export const DEFAULT_SETTINGS: SheikoSettings = {
	identity: '',
	week: DEFAULT_WEEK.map((d) => ({ ...d })),
	allowedVaults: [],
	dryRun: false,
	maxEditsPerRun: 25,
	progressStatus: 'in-progress',
	reviewStatus: '',
	doneStatus: 'done',
	autoStageTimer: true,
	autoStageChecklist: true,
	promptOnReview: true,
	promptAtCutoff: true,
	workerField: 'assignedTo',
	agentNames: [],
	statusBarCount: true,
	autoRoll: false,
};

export interface PluginData {
	settings: SheikoSettings;
	/** Last status Sheiko saw for each task, by vault path. */
	lastStatus: Record<string, string>;
	/** Closes found at startup that Sheiko didn't see happen (decision 2a): flagged, never filled in. */
	unwitnessedCloses: { path: string; detectedAt: string }[];
	/** ISO time of the last daily cutoff Sheiko acted on (sign-off prompt now, auto-roll in Phase 3). */
	lastCutoffRun: string | null;
}

export function vaultBasePath(app: App): string | null {
	const a = app.vault.adapter;
	return a instanceof FileSystemAdapter ? a.getBasePath() : null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** One settings row: its name/description (also used by Obsidian 1.13's settings search) and how to fill it in. */
interface Row {
	name: string;
	desc: () => string;
	/** Adds the control(s) to the row. Absent for text-only rows. */
	render?: (setting: Setting) => void;
}

interface Section {
	heading: string;
	rows: Row[];
}

/**
 * The settings are defined once (sections()) and shown two ways:
 * - Obsidian 1.13+: getSettingDefinitions(), so they appear in Obsidian's settings search.
 * - Older versions: display(), which 1.13+ no longer calls once definitions are returned.
 */
export class SheikoSettingTab extends PluginSettingTab {
	plugin: SheikoPlugin;

	constructor(app: App, plugin: SheikoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((sec) => ({
			type: 'group' as const,
			heading: sec.heading,
			items: sec.rows.map((row) => ({
				name: row.name,
				desc: row.desc(),
				render: (setting: Setting) => this.fill(setting, row),
			})),
		}));
	}

	/** Fallback for Obsidian versions before 1.13. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const sec of this.sections()) {
			new Setting(containerEl).setName(sec.heading).setHeading();
			for (const row of sec.rows) this.fill(new Setting(containerEl), row);
		}
	}

	private fill(setting: Setting, row: Row): void {
		setting.setName(row.name).setDesc(row.desc());
		row.render?.(setting);
	}

	private sections(): Section[] {
		const s = this.plugin.settings;
		const base = vaultBasePath(this.app);
		const allowedDesc = (): string => {
			const allowed = base !== null && s.allowedVaults.includes(base);
			return (
				`${base ?? '(unknown path)'}: ${allowed ? 'allowed' : 'not allowed. Sheiko is read-only here'}. ` +
				'Sheiko only changes notes in vaults on this list.'
			);
		};
		const toggle = (key: 'dryRun' | 'autoStageTimer' | 'autoStageChecklist' | 'promptOnReview' | 'promptAtCutoff' | 'autoRoll') =>
			(setting: Setting): void => {
				setting.addToggle((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await this.plugin.saveSettings();
					}),
				);
			};
		const statuses = this.plugin.taskNotes.statuses;
		const pick = (key: 'progressStatus' | 'reviewStatus' | 'doneStatus', onlyCompleted: boolean, allowNone = false) =>
			(setting: Setting): void => {
				setting.addDropdown((d) => {
					if (allowNone) d.addOption('', 'Not set (sign-off off)');
					for (const st of statuses) if (st.isCompleted === onlyCompleted) d.addOption(st.value, st.label);
					if (s[key] && !statuses.some((st) => st.value === s[key])) d.addOption(s[key], `${s[key]} (not in TaskNotes)`);
					d.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await this.plugin.saveSettings();
					});
				});
			};
		const hours = (i: number) =>
			(setting: Setting): void => {
				const day = s.week[i];
				if (!day) return;
				setting
					.addText((t) =>
						t
							.setPlaceholder('09:00')
							.setValue(day.start)
							.onChange(async (v) => {
								if (HM.test(v)) {
									day.start = v;
									await this.plugin.saveSettings();
								}
							}),
					)
					.addText((t) =>
						t
							.setPlaceholder('17:00')
							.setValue(day.end)
							.onChange(async (v) => {
								if (HM.test(v)) {
									day.end = v;
									await this.plugin.saveSettings();
								}
							}),
					);
			};

		return [
			{
				heading: 'Safety',
				rows: [
					{
						name: 'Allow writes in this vault',
						desc: allowedDesc,
						render: (setting) => {
							setting.addToggle((t) =>
								t.setValue(base !== null && s.allowedVaults.includes(base)).onChange(async (v) => {
									if (base === null) return;
									s.allowedVaults = v
										? [...new Set([...s.allowedVaults, base])]
										: s.allowedVaults.filter((p) => p !== base);
									await this.plugin.saveSettings();
									// Turning writes on/off restarts tracking with a fresh baseline check.
									await this.plugin.tracker.reconcile();
									setting.setDesc(allowedDesc());
								}),
							);
						},
					},
					{
						name: 'Dry run',
						desc: () => 'Log what Sheiko would change to the developer console, without changing any note.',
						render: toggle('dryRun'),
					},
					{
						name: 'Max edits per run',
						desc: () => 'Batch runs (the startup catch-up and auto-roll) stop after this many notes. The rest are picked up on the next run.',
						render: (setting) => {
							setting.addText((t) =>
								t.setValue(String(s.maxEditsPerRun)).onChange(async (v) => {
									const n = Number(v);
									if (Number.isInteger(n) && n > 0) {
										s.maxEditsPerRun = n;
										await this.plugin.saveSettings();
									}
								}),
							);
						},
					},
				],
			},
			{
				heading: 'You',
				rows: [
					{
						name: 'Your identity',
						desc: () =>
							"Written as closedBy when Sheiko records a close, and on context entries you add. Leave blank and closedBy isn't written.",
						render: (setting) => {
							setting.addText((t) =>
								t
									.setPlaceholder('Your name')
									.setValue(s.identity)
									.onChange(async (v) => {
										s.identity = v.trim();
										await this.plugin.saveSettings();
									}),
							);
						},
					},
				],
			},
			{
				heading: 'Stages and sign-off',
				rows: [
					{ name: 'Working status', desc: () => 'Where a task moves when its timer starts.', render: pick('progressStatus', false) },
					{
						name: 'Review status',
						desc: () =>
							"Where a task moves when every checkbox is ticked. Tasks here wait for sign-off. While this isn't set, the checkbox move and both sign-off prompts are off.",
						render: pick('reviewStatus', false, true),
					},
					{ name: 'Done status', desc: () => 'What "Approve and close" in the sign-off prompt sets.', render: pick('doneStatus', true) },
					{
						name: 'Timer start moves task to working',
						desc: () => 'Only moves it forward, from a status before the working status.',
						render: toggle('autoStageTimer'),
					},
					{
						name: 'All boxes ticked moves task to review',
						desc: () => 'Fires when the last unticked box is ticked, not on tasks that were already fully ticked.',
						render: toggle('autoStageChecklist'),
					},
					{
						name: 'Prompt for sign-off on review',
						desc: () => 'Ask to approve and close as soon as a task enters review.',
						render: toggle('promptOnReview'),
					},
					{
						name: 'Prompt for sign-off at the daily cutoff',
						desc: () => "At each day's end time, ask about every task still waiting in review.",
						render: toggle('promptAtCutoff'),
					},
					{
						name: 'Show sign-off count in the status bar',
						desc: () => 'Shows how many tasks are waiting in review. Click it to open the sign-off window. Hidden when nothing is waiting.',
						render: (setting) => {
							setting.addToggle((t) =>
								t.setValue(s.statusBarCount).onChange(async (v) => {
									s.statusBarCount = v;
									await this.plugin.saveSettings();
									this.plugin.refreshStatusBar();
								}),
							);
						},
					},
				],
			},
			{
				heading: 'Who worked on it',
				rows: [
					{
						name: 'Worker field',
						desc: () =>
							'Frontmatter field naming who worked on a task, shown in the sign-off window. A task with nothing in this field shows "Worker: not recorded".',
						render: (setting) => {
							setting.addText((t) =>
								t
									.setPlaceholder('assignedTo')
									.setValue(s.workerField)
									.onChange(async (v) => {
										s.workerField = v.trim() || DEFAULT_SETTINGS.workerField;
										await this.plugin.saveSettings();
									}),
							);
						},
					},
					{
						name: 'AI agent names',
						desc: () =>
							'Comma-separated. A worker with one of these names shows as an AI agent; any other name shows as human. Not case-sensitive.',
						render: (setting) => {
							setting.addTextArea((t) =>
								t
									.setPlaceholder('Agent names, separated by commas')
									.setValue(s.agentNames.join(', '))
									.onChange(async (v) => {
										s.agentNames = v
											.split(',')
											.map((x) => x.trim())
											.filter(Boolean);
										await this.plugin.saveSettings();
									}),
							);
						},
					},
				],
			},
			{
				heading: 'Auto-roll',
				rows: [
					{
						name: 'Roll unfinished tasks at the end of each day',
						desc: () =>
							"At each day's end time (weekends included), unfinished tasks scheduled for that day or earlier move to the next day. " +
							"Only the scheduled date moves; due never changes. Each roll is noted in the task and in that day's daily note. Off by default: try dry run first.",
						render: toggle('autoRoll'),
					},
				],
			},
			{
				heading: 'Working hours',
				rows: [
					{
						name: 'How working hours are used',
						desc: () =>
							'Mon–Fri time inside these hours counts as working, and the rest as overnight. Saturday and Sunday always count as weekend. ' +
							'The end time is also the daily cutoff: when unfinished tasks roll and the end-of-day sign-off prompt appears. Format HH:mm.',
					},
					...DAYS.map((name, i) => ({ name, desc: () => `${name}: start and end time.`, render: hours(i) })),
				],
			},
		];
	}
}
