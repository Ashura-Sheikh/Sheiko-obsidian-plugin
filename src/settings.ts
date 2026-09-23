import { App, FileSystemAdapter, PluginSettingTab, Setting } from 'obsidian';
import type SheikoPlugin from './main';
import { DEFAULT_WEEK, WeekSchedule } from './lifecycle';

export interface SheikoSettings {
	/** Written as `closedBy` and in Context entries. */
	identity: string;
	/** Per weekday (0 = Sunday), start/end of working hours. End is also the roll cutoff (Phase 3). */
	week: WeekSchedule;
	/** Absolute vault paths Sheiko is allowed to write in. Empty = writes disabled everywhere. */
	allowedVaults: string[];
	/** Log intended writes instead of making them. */
	dryRun: boolean;
	/** Cap on files edited by one batch run (startup reconcile, and auto-roll later). */
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
}

export const DEFAULT_SETTINGS: SheikoSettings = {
	identity: 'sheikh',
	week: DEFAULT_WEEK.map((d) => ({ ...d })),
	allowedVaults: [],
	dryRun: false,
	maxEditsPerRun: 25,
	progressStatus: 'in-progress',
	reviewStatus: 'in-review',
	doneStatus: 'done',
	autoStageTimer: true,
	autoStageChecklist: true,
	promptOnReview: true,
	promptAtCutoff: true,
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

export class SheikoSettingTab extends PluginSettingTab {
	plugin: SheikoPlugin;

	constructor(app: App, plugin: SheikoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		// ---- Safety ----
		new Setting(containerEl).setName('Safety').setHeading();
		const base = vaultBasePath(this.app);
		const allowed = base !== null && s.allowedVaults.includes(base);
		new Setting(containerEl)
			.setName('Allow writes in this vault')
			.setDesc(
				`${base ?? '(unknown path)'}: ${allowed ? 'allowed' : 'not allowed. Sheiko is read-only here'}. ` +
					'Sheiko only changes notes in vaults on this list.',
			)
			.addToggle((t) =>
				t.setValue(allowed).onChange(async (v) => {
					if (base === null) return;
					s.allowedVaults = v
						? [...new Set([...s.allowedVaults, base])]
						: s.allowedVaults.filter((p) => p !== base);
					await this.plugin.saveSettings();
					// Turning writes on/off restarts tracking with a fresh baseline check.
					await this.plugin.tracker.reconcile();
					this.display();
				}),
			);
		new Setting(containerEl)
			.setName('Dry run')
			.setDesc('Log what Sheiko would change to the developer console, without changing any note.')
			.addToggle((t) =>
				t.setValue(s.dryRun).onChange(async (v) => {
					s.dryRun = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName('Max edits per run')
			.setDesc('Batch runs (the startup catch-up, and auto-roll later) stop after this many notes.')
			.addText((t) =>
				t.setValue(String(s.maxEditsPerRun)).onChange(async (v) => {
					const n = Number(v);
					if (Number.isInteger(n) && n > 0) {
						s.maxEditsPerRun = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		// ---- Identity ----
		new Setting(containerEl).setName('You').setHeading();
		new Setting(containerEl)
			.setName('Your identity')
			.setDesc('Written as closedBy and on Context entries you add.')
			.addText((t) =>
				t.setValue(s.identity).onChange(async (v) => {
					if (v.trim()) {
						s.identity = v.trim();
						await this.plugin.saveSettings();
					}
				}),
			);

		// ---- Stages & sign-off (Phase 2) ----
		new Setting(containerEl).setName('Stages and sign-off').setHeading();
		const statuses = this.plugin.taskNotes.statuses;
		const pick = (name: string, desc: string, key: 'progressStatus' | 'reviewStatus' | 'doneStatus', onlyCompleted: boolean): void => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addDropdown((d) => {
					for (const st of statuses) if (st.isCompleted === onlyCompleted) d.addOption(st.value, st.label);
					if (!statuses.some((st) => st.value === s[key])) d.addOption(s[key], `${s[key]} (not in TaskNotes)`);
					d.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await this.plugin.saveSettings();
					});
				});
		};
		pick('Working status', 'Where a task moves when its timer starts.', 'progressStatus', false);
		pick('Review status', 'Where a task moves when every checkbox is ticked. Tasks here wait for sign-off.', 'reviewStatus', false);
		pick('Done status', 'What "Approve and close" in the sign-off prompt sets.', 'doneStatus', true);
		const toggle = (name: string, desc: string, key: 'autoStageTimer' | 'autoStageChecklist' | 'promptOnReview' | 'promptAtCutoff'): void => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await this.plugin.saveSettings();
					}),
				);
		};
		toggle('Timer start moves task to working', 'Only moves it forward, from a status before the working status.', 'autoStageTimer');
		toggle('All boxes ticked moves task to review', 'Fires when the last unticked box is ticked, not on tasks that were already fully ticked.', 'autoStageChecklist');
		toggle('Prompt for sign-off on review', 'Ask to approve and close as soon as a task enters review.', 'promptOnReview');
		toggle('Prompt for sign-off at the daily cutoff', 'At each day\'s end time, ask about every task still waiting in review.', 'promptAtCutoff');

		// ---- Working hours ----
		new Setting(containerEl).setName('Working hours').setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Mon–Fri time inside these hours counts as working, and the rest as overnight. Saturday and Sunday always count as weekend. ' +
				'The end time is also the daily cutoff for rolling unfinished tasks to the next day (coming in Phase 3). Format HH:mm.',
		});
		DAYS.forEach((name, i) => {
			const day = s.week[i];
			if (!day) return;
			new Setting(containerEl)
				.setName(name)
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
		});
	}
}
