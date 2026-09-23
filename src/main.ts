import { Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, PluginData, SheikoSettingTab, SheikoSettings } from './settings';
import { TaskNotesConfig, isTaskFile, loadTaskNotesConfig } from './tasknotes';
import { Tracker } from './tracker';
import { LifecycleModal, UnwitnessedModal } from './ui/lifecycle-modal';

export default class SheikoPlugin extends Plugin {
	data!: PluginData;
	taskNotes!: TaskNotesConfig;
	tracker!: Tracker;

	get settings(): SheikoSettings {
		return this.data.settings;
	}

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.taskNotes = await loadTaskNotesConfig(this.app);
		this.tracker = new Tracker(this);
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
			void this.tracker.reconcile();
		});
	}

	onunload(): void {
		this.tracker?.stop();
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
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.data);
	}
}
