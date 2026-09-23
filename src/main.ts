import { Notice, Plugin, TFile } from 'obsidian';
import { cutoffDue, parseTimestamp } from './lifecycle';
import { Roller } from './roller';
import { DEFAULT_SETTINGS, PluginData, SheikoSettingTab, SheikoSettings } from './settings';
import { TaskNotesConfig, isTaskFile, loadTaskNotesConfig, statusOf } from './tasknotes';
import { Tracker } from './tracker';
import { LifecycleModal, UnwitnessedModal } from './ui/lifecycle-modal';
import { SignoffModal, SignoffReason } from './ui/signoff-modal';

export default class SheikoPlugin extends Plugin {
	data!: PluginData;
	taskNotes!: TaskNotesConfig;
	tracker!: Tracker;
	roller!: Roller;
	private signoff: SignoffModal | null = null;

	get settings(): SheikoSettings {
		return this.data.settings;
	}

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.taskNotes = await loadTaskNotesConfig(this.app);
		this.tracker = new Tracker(this);
		this.roller = new Roller(this);
		this.addSettingTab(new SheikoSettingTab(this.app, this));

		this.addCommand({
			id: 'open-task-lifecycle',
			name: 'Open task lifecycle (context, closure, time per status)',
			checkCallback: (checking) => {
				const file = this.activeTask();
				if (!file) return false;
				if (!checking) new LifecycleModal(this.app, this, file).open();
				return true;
			},
		});
		this.addCommand({
			id: 'write-lifecycle-summary',
			name: 'Write lifecycle summary to this task',
			checkCallback: (checking) => {
				const file = this.activeTask();
				if (!file) return false;
				if (!checking) {
					void this.tracker.writeSummary(file).then((ok) => {
						if (ok) new Notice('Sheiko: summary written.');
					});
				}
				return true;
			},
		});
		this.addCommand({
			id: 'show-awaiting-signoff',
			name: 'Show tasks waiting for sign-off',
			callback: () => {
				const files = this.tasksAwaitingSignoff();
				if (files.length === 0) new Notice('Sheiko: nothing is waiting for sign-off.');
				else this.promptSignoff(files, 'review');
			},
		});
		this.addCommand({
			id: 'roll-now',
			name: 'Roll unfinished tasks now (scheduled today or earlier → tomorrow)',
			callback: () => void this.roller.run(new Date(), true),
		});
		this.addCommand({
			id: 'list-unwitnessed-closes',
			name: 'List tasks closed while Obsidian was shut',
			callback: () => new UnwitnessedModal(this.app, this).open(),
		});
		this.addRibbonIcon('history', 'Sheiko: task lifecycle', () => {
			const file = this.activeTask();
			if (file) new LifecycleModal(this.app, this, file).open();
			else new Notice('Sheiko: open a TaskNotes task first.');
		});

		this.registerEvent(this.app.metadataCache.on('changed', (file) => this.tracker.onMetadataChanged(file)));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.tracker.onRename(file, oldPath)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.tracker.onDelete(file)));

		this.app.workspace.onLayoutReady(() => {
			if (!this.taskNotes.found) {
				new Notice('Sheiko: TaskNotes settings not found. Using default statuses.');
			}
			void this.tracker.reconcile().then(() => this.checkCutoff());
		});
		// Daily cutoff check (each weekday's end time). Also runs once at startup, above.
		this.registerInterval(window.setInterval(() => void this.checkCutoff(), 60 * 1000));
	}

	onunload(): void {
		this.tracker?.stop();
	}

	// ---------- Phase 2: sign-off ----------

	promptSignoff(files: TFile[], reason: SignoffReason): void {
		if (files.length === 0) return;
		if (this.signoff) {
			this.signoff.add(files);
			return;
		}
		this.signoff = new SignoffModal(this.app, this, reason);
		this.signoff.add(files);
		this.signoff.open();
	}

	signoffClosed(modal: SignoffModal): void {
		if (this.signoff === modal) this.signoff = null;
	}

	tasksAwaitingSignoff(): TFile[] {
		const review = this.settings.reviewStatus;
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => isTaskFile(this.app, f, this.taskNotes) && statusOf(this.app, f, this.taskNotes) === review);
	}

	/**
	 * Acts once per daily cutoff (that weekday's end time). If Obsidian was closed
	 * over one or more cutoffs, it acts once when it next opens. The first run only
	 * records the latest cutoff, so installing the plugin doesn't trigger anything.
	 * Order: auto-roll first (Phase 3), then the sign-off prompt (Phase 2).
	 */
	async checkCutoff(): Promise<void> {
		if (!this.tracker.isReady) return;
		const { act, record } = cutoffDue(new Date(), this.settings.week, this.data.lastCutoffRun);
		if (record === null) return;
		this.data.lastCutoffRun = record;
		await this.saveData(this.data);
		if (!act) return;
		const cut = parseTimestamp(record);
		if (this.settings.autoRoll && cut) await this.roller.run(cut, false);
		if (this.settings.promptAtCutoff) this.promptSignoff(this.tasksAwaitingSignoff(), 'cutoff');
	}

	private activeTask(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file && isTaskFile(this.app, file, this.taskNotes) ? file : null;
	}

	private async loadPluginData(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		const settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings ?? {});
		settings.week = DEFAULT_SETTINGS.week.map((d, i) => ({ ...d, ...(raw.settings?.week?.[i] ?? {}) }));
		settings.allowedVaults = [...(raw.settings?.allowedVaults ?? [])];
		this.data = {
			settings,
			lastStatus: { ...(raw.lastStatus ?? {}) },
			unwitnessedCloses: [...(raw.unwitnessedCloses ?? [])],
			lastCutoffRun: typeof raw.lastCutoffRun === 'string' ? raw.lastCutoffRun : null,
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.data);
	}
}
