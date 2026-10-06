import { Notice, Plugin, TFile } from 'obsidian';
import { cutoffDue, parseTimestamp } from './lifecycle';
import { Roller } from './roller';
import { kindIcon, kindLabel } from './slot-logic';
import { FocusSlots } from './slots';
import { DEFAULT_SETTINGS, PluginData, SheikoSettingTab, SheikoSettings } from './settings';
import { TaskNotesConfig, isTaskFile, loadTaskNotesConfig, statusOf } from './tasknotes';
import { Tracker } from './tracker';
import { LifecycleModal, UnwitnessedModal } from './ui/lifecycle-modal';
import { SignoffModal, SignoffReason } from './ui/signoff-modal';
import { EndSlotModal, StartSlotModal } from './ui/slot-modal';

export default class SheikoPlugin extends Plugin {
	data!: PluginData;
	/** Same object as data.settings (assigned once in loadPluginData; never replaced, only mutated). */
	settings!: SheikoSettings;
	taskNotes!: TaskNotesConfig;
	tracker!: Tracker;
	roller!: Roller;
	slots!: FocusSlots;
	private signoff: SignoffModal | null = null;
	private statusBarEl: HTMLElement | null = null;
	/** Context typed in the sign-off window but not yet added, by task path. Kept until Obsidian closes, never written on its own. */
	readonly signoffDrafts = new Map<string, string>();
	private statusBarTimer: number | null = null;
	private slotBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.taskNotes = await loadTaskNotesConfig(this.app);
		this.tracker = new Tracker(this);
		this.roller = new Roller(this);
		this.slots = new FocusSlots(this);
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
				else this.promptSignoff(files, 'manual');
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
		this.addCommand({
			id: 'start-slot',
			name: 'Start a break or deep-work slot',
			checkCallback: (checking) => {
				if (this.slots.isActive() || !this.taskNotes.found) return false;
				if (!checking) new StartSlotModal(this.app, this).open();
				return true;
			},
		});
		this.addCommand({
			id: 'end-slot',
			name: 'End the current break or deep-work slot now',
			checkCallback: (checking) => {
				if (!this.slots.isActive()) return false;
				if (!checking) void this.slots.finish(true);
				return true;
			},
		});
		this.addRibbonIcon('history', 'Sheiko: task lifecycle', () => {
			const file = this.activeTask();
			if (file) new LifecycleModal(this.app, this, file).open();
			else new Notice('Sheiko: open a TaskNotes task first.');
		});

		// Status bar: "⭐ N awaiting sign-off". Click to open the sign-off window (the way back to tasks left with "Later").
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('sheiko-statusbar', 'mod-clickable');
		this.statusBarEl.setAttr('aria-label', 'Sheiko: open tasks waiting for sign-off');
		this.statusBarEl.hide();
		this.registerDomEvent(this.statusBarEl, 'click', () => {
			const files = this.tasksAwaitingSignoff();
			if (files.length === 0) new Notice('Sheiko: nothing is waiting for sign-off.');
			else this.promptSignoff(files, 'manual');
		});

		// Status bar: the slot running now ("☕ Break until 13:00"), or a quiet 🎧 to start one.
		this.slotBarEl = this.addStatusBarItem();
		this.slotBarEl.addClass('sheiko-statusbar', 'mod-clickable');
		this.slotBarEl.hide();
		this.registerDomEvent(this.slotBarEl, 'click', () => {
			if (this.slots.isActive()) new EndSlotModal(this.app, this).open();
			else new StartSlotModal(this.app, this).open();
		});

		// Slot logging: Markdown files touched while Obsidian is open.
		this.registerEvent(this.app.vault.on('create', (f) => this.slots.onFileEvent('create', f)));
		this.registerEvent(this.app.vault.on('modify', (f) => this.slots.onFileEvent('modify', f)));

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				this.tracker.onMetadataChanged(file);
				this.scheduleStatusBar();
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				this.tracker.onRename(file, oldPath);
				this.slots.onFileEvent('rename', file, oldPath);
				this.scheduleStatusBar();
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.tracker.onDelete(file);
				this.slots.onFileEvent('delete', file);
				this.scheduleStatusBar();
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			if (!this.taskNotes.found) {
				// Without TaskNotes, Sheiko does nothing: no tracking, no auto-roll, no prompts.
				new Notice('Sheiko: TaskNotes isn\'t installed and enabled, so Sheiko is doing nothing. Reload Obsidian after enabling it.');
				return;
			}
			this.refreshStatusBar();
			void this.tracker.reconcile().then(async () => {
				await this.slots.tick();
				await this.checkCutoff();
			});
		});
		// Every minute: slots (start / end / gaps), then the daily cutoff. Also runs once at startup, above.
		this.registerInterval(
			window.setInterval(() => {
				if (!this.taskNotes.found) return;
				void this.slots.tick().then(() => this.checkCutoff());
			}, 60 * 1000),
		);
	}

	onunload(): void {
		this.tracker?.stop();
		this.slots?.stop();
		if (this.statusBarTimer !== null) window.clearTimeout(this.statusBarTimer);
	}

	// ---------- Status bar ----------

	/** Debounced: metadata 'changed' fires once per edited file, and the count scans every task. */
	private scheduleStatusBar(): void {
		if (this.statusBarTimer !== null) window.clearTimeout(this.statusBarTimer);
		this.statusBarTimer = window.setTimeout(() => {
			this.statusBarTimer = null;
			this.refreshStatusBar();
		}, 500);
	}

	refreshStatusBar(): void {
		this.refreshSlotBar();
		const el = this.statusBarEl;
		if (!el) return;
		const n = this.settings.statusBarCount ? this.tasksAwaitingSignoff().length : 0;
		if (n === 0) {
			el.hide();
			return;
		}
		el.setText(`⭐ ${n} awaiting sign-off`);
		el.show();
	}

	private refreshSlotBar(): void {
		const el = this.slotBarEl;
		if (!el) return;
		if (!this.taskNotes?.found) {
			el.hide();
			return;
		}
		const slot = this.slots.active;
		if (slot) {
			el.setText(`${kindIcon(slot.kind)} ${kindLabel(slot.kind)} until ${slot.end.slice(11, 16)}`);
			el.setAttr('aria-label', 'Sheiko: sign-off prompts are held. Click to end the slot now.');
		} else {
			el.setText('🎧');
			el.setAttr('aria-label', 'Sheiko: start a break or deep-work slot');
		}
		el.show();
	}

	// ---------- Phase 2: sign-off ----------

	/**
	 * Shows the sign-off window. While a break / deep-work slot runs, automatic prompts
	 * (on review, at the cutoff) are held and shown when it ends; asking for the window
	 * yourself ('manual') always opens it.
	 */
	promptSignoff(files: TFile[], reason: SignoffReason): void {
		if (files.length === 0) return;
		if (this.slots.holdsPrompt(files, reason)) return;
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
		if (!review || !this.taskNotes.found) return [];
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
		settings.agentNames = [...(raw.settings?.agentNames ?? [])];
		// Edited in place by index, so it must never share the DEFAULT_SETTINGS array.
		settings.slotSchedule = DEFAULT_SETTINGS.slotSchedule.map((d, i) => {
			const v = raw.settings?.slotSchedule?.[i];
			return typeof v === 'string' ? v : d;
		});
		this.data = {
			settings,
			lastStatus: { ...(raw.lastStatus ?? {}) },
			unwitnessedCloses: [...(raw.unwitnessedCloses ?? [])],
			lastCutoffRun: typeof raw.lastCutoffRun === 'string' ? raw.lastCutoffRun : null,
			activeSlot: raw.activeSlot && typeof raw.activeSlot === 'object' ? { ...raw.activeSlot, gaps: [...(raw.activeSlot.gaps ?? [])] } : null,
			lastScheduledSlot: typeof raw.lastScheduledSlot === 'string' ? raw.lastScheduledSlot : null,
		};
		this.settings = this.data.settings;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.data);
	}
}
