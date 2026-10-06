// Break / deep-work slots (v0.2.0, Sheikh 2026-10-05).
// While a slot runs: sign-off prompts (on review, at the cutoff) are held, and status
// changes plus Markdown files touched are logged. When it ends, one report block is
// appended to `<report folder>/YYYY-MM-DD.md` and the held prompts are shown.
// Slots come from the per-weekday schedule or are started on demand. Time tracking
// (working / overnight / weekend) is unchanged.

import { Notice, TAbstractFile, TFile, normalizePath } from 'obsidian';
import type SheikoPlugin from './main';
import { Transition, parseTimestamp, toLocalIso } from './lifecycle';
import { classifyWorker, workerLabel } from './review';
import { ActiveSlot, SlotKind, buildSlotReport, reportPath, scheduledSlotAt, touch } from './slot-logic';
import { isCompletedStatus, isTaskFile } from './tasknotes';

/** A heartbeat older than this means Obsidian was closed for part of the slot. */
const GAP_MS = 2 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

export class FocusSlots {
	private plugin: SheikoPlugin;
	private saveTimer: number | null = null;
	private finishing = false;

	constructor(plugin: SheikoPlugin) {
		this.plugin = plugin;
	}

	get active(): ActiveSlot | null {
		return this.plugin.data.activeSlot ?? null;
	}

	isActive(): boolean {
		return this.active !== null;
	}

	/** On unload: a save still waiting on the debounce is written now, not dropped. */
	stop(): void {
		if (this.saveTimer === null) return;
		window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		void this.plugin.saveData(this.plugin.data);
	}

	/** Starts a slot now. Refuses if one is already running. */
	start(kind: SlotKind, end: Date, source: 'scheduled' | 'manual', now = new Date()): boolean {
		if (this.active) {
			new Notice('Sheiko: a slot is already running. End it first.');
			return false;
		}
		if (end.getTime() <= now.getTime()) return false;
		this.plugin.data.activeSlot = {
			kind,
			start: toLocalIso(now),
			end: toLocalIso(end),
			source,
			events: [],
			touched: {},
			held: [],
			heartbeat: toLocalIso(now),
			gaps: [],
		};
		void this.plugin.saveData(this.plugin.data);
		this.plugin.refreshStatusBar();
		return true;
	}

	/**
	 * Called every minute and once at startup: records gaps, ends a slot whose time is up,
	 * and starts a scheduled slot (once per day + slot, so ending one early doesn't restart it).
	 */
	async tick(now = new Date()): Promise<void> {
		// Same gate as tracking: no TaskNotes, or writes not allowed in this vault → slots do nothing.
		if (!this.plugin.tracker.isReady) return;
		const slot = this.active;
		if (slot) {
			const beat = parseTimestamp(slot.heartbeat);
			const end = parseTimestamp(slot.end);
			if (beat && now.getTime() - beat.getTime() > GAP_MS) {
				const to = end && end.getTime() < now.getTime() ? end : now;
				slot.gaps.push({ from: slot.heartbeat, to: toLocalIso(to) });
			}
			slot.heartbeat = toLocalIso(now);
			if (end && now.getTime() >= end.getTime()) await this.finish(false, end);
			else this.scheduleSave();
			return;
		}
		const sched = scheduledSlotAt(now, this.plugin.settings.slotSchedule);
		if (sched && this.plugin.data.lastScheduledSlot !== sched.key) {
			this.plugin.data.lastScheduledSlot = sched.key;
			this.start(sched.spec.kind, sched.end, 'scheduled', now);
		}
	}

	/** Ends the slot, writes its report block, then shows any held sign-off prompts. */
	async finish(early: boolean, endedAt = new Date()): Promise<void> {
		const slot = this.active;
		if (!slot || this.finishing) return;
		this.finishing = true;
		try {
			const lines = buildSlotReport({ slot, endedAt, endedEarly: early, cameDue: this.cameDue(slot, endedAt) });
			const written = await this.writeReport(endedAt, lines);
			this.plugin.data.activeSlot = null;
			await this.plugin.saveData(this.plugin.data);
			this.plugin.refreshStatusBar();
			if (written) new Notice(`Sheiko: slot ended. Report added to ${written}.`);
			if (slot.held.length) {
				const waiting = this.plugin.tasksAwaitingSignoff();
				if (waiting.length) this.plugin.promptSignoff(waiting, 'manual');
			}
		} finally {
			this.finishing = false;
		}
	}

	/** Returns the report path if written, or null (writes blocked or dry run, reason shown). */
	private async writeReport(day: Date, lines: string[]): Promise<string | null> {
		const { app } = this.plugin;
		const path = normalizePath(reportPath(this.plugin.settings.reportFolder, day));
		const blocked = this.plugin.tracker.blockedReason();
		if (blocked) {
			new Notice(`${blocked} The slot report wasn't written; it's in the developer console.`);
			console.debug('[Sheiko] Slot report (not written)', lines);
			return null;
		}
		if (this.plugin.settings.dryRun) {
			console.debug(`[Sheiko dry run] slot report → ${path}`, lines);
			new Notice('Sheiko dry run: slot report not written (see console).');
			return null;
		}
		let file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
			if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
			// No heading: the file name (the date) is already the note's title.
			file = await app.vault.create(path, '');
		}
		if (!(file instanceof TFile)) return null;
		const block = lines.join('\n');
		await app.vault.process(file, (c) => {
			const before = c.replace(/\s+$/, '');
			return before ? `${before}\n\n${block}\n` : `${block}\n`;
		});
		return path;
	}

	/** Tasks with a timed `due` inside the slot. Date-only dues have no time, so they're not counted. */
	private cameDue(slot: ActiveSlot, endedAt: Date): { path: string; due: string }[] {
		const { app } = this.plugin;
		const cfg = this.plugin.taskNotes;
		const start = parseTimestamp(slot.start);
		if (!start) return [];
		const out: { path: string; due: string }[] = [];
		for (const f of app.vault.getMarkdownFiles()) {
			if (!isTaskFile(app, f, cfg)) continue;
			const due: unknown = app.metadataCache.getFileCache(f)?.frontmatter?.[cfg.field.due];
			const at = parseTimestamp(due);
			if (at && at >= start && at <= endedAt && typeof due === 'string') out.push({ path: f.path, due });
		}
		return out;
	}

	// ---------- Logging (only while a slot is active) ----------

	/**
	 * The hold rule, used by the plugin's promptSignoff and by the tests: automatic prompts
	 * (on review, at the cutoff) are held while a slot runs; a prompt you asked for ('manual')
	 * is never held. Returns true if the prompt was held.
	 */
	holdsPrompt(files: TFile[], reason: 'review' | 'cutoff' | 'manual'): boolean {
		return reason !== 'manual' && this.hold(files);
	}

	/** Prompts held instead of shown. Returns true if held. */
	hold(files: TFile[]): boolean {
		const slot = this.active;
		if (!slot) return false;
		for (const f of files) if (!slot.held.includes(f.path)) slot.held.push(f.path);
		this.scheduleSave();
		return true;
	}

	onTransition(file: TFile, t: Transition): void {
		const slot = this.active;
		if (!slot || t.kind !== 'live') return;
		const s = this.plugin.settings;
		const cfg = this.plugin.taskNotes;
		let kind: 'review' | 'closed' | 'status' = 'status';
		let worker: string | undefined;
		if (s.reviewStatus && t.to === s.reviewStatus) {
			kind = 'review';
			const fm: Record<string, unknown> = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
			worker = workerLabel(classifyWorker(fm[s.workerField], s.agentNames));
		} else if (!isCompletedStatus(cfg, t.from) && isCompletedStatus(cfg, t.to)) kind = 'closed';
		slot.events.push({ at: toLocalIso(t.at), path: file.path, kind, from: t.from, to: t.to, ...(worker ? { worker } : {}) });
		this.scheduleSave();
	}

	onFileEvent(kind: 'create' | 'modify' | 'delete' | 'rename', file: TAbstractFile, oldPath?: string): void {
		const slot = this.active;
		if (!slot || !(file instanceof TFile) || file.extension !== 'md') return;
		if (this.isReportFile(file.path)) return; // Sheiko's own report note isn't "work done"
		touch(slot, file.path, kind, kind === 'rename' ? oldPath : undefined);
		this.scheduleSave();
	}

	private isReportFile(path: string): boolean {
		const folder = this.plugin.settings.reportFolder.trim().replace(/^\/+|\/+$/g, '');
		return folder ? path.startsWith(`${folder}/`) : false;
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.saveData(this.plugin.data);
		}, SAVE_DEBOUNCE_MS);
	}
}
