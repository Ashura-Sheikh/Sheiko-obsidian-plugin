// Watches TaskNotes status changes and records them.
//
// Rules (Build task, 2026-09-23):
// - Status History is append-only. Changes Sheiko sees live get the real time;
//   changes found at startup (made while Obsidian was closed) are stamped
//   "detected at startup", never given an invented change time.
// - Closure fields are written ONLY for a close Sheiko saw happen live (decision 2a),
//   and never overwrite a close written by an agent or by hand.
// - Reopening only clears closure fields Sheiko itself wrote (closureSource: sheiko).
// - Nothing is written unless this vault is on the allowed list; dry run logs instead.

import { Notice, TAbstractFile, TFile } from 'obsidian';
import type SheikoPlugin from './main';
import {
	CONTEXT_HEADING,
	HISTORY_HEADING,
	SUMMARY_HEADING,
	Transition,
	appendToSection,
	buildSummary,
	checklistComplete,
	formatContextLine,
	isContextEntry,
	isHistoryEntry,
	isTimerRunning,
	parseHistory,
	replaceSection,
	formatTransition,
	isDateOnly,
	localDateString,
	minutesBetween,
	parseTimestamp,
	splitBuckets,
	toLocalIso,
} from './lifecycle';
import { TaskNotesConfig, hasStatus, isCompletedStatus, isTaskFile, labelFor, orderOf, statusOf } from './tasknotes';
import { vaultBasePath } from './settings';
import { SIGNOFF_PHRASE, WITHDRAW_PHRASE, byField, closeNote, signoffState } from './signoff-record';

export const FIELD = {
	closedBy: 'closedBy',
	timeToClose: 'timeToCloseMinutes',
	working: 'timeWorkingMinutes',
	overnight: 'timeOvernightMinutes',
	weekend: 'timeWeekendMinutes',
	source: 'closureSource',
} as const;

/** Wait for TaskNotes to finish its own write (it sets completedDate on close) before we write. */
const SETTLE_MS = 600;
/** A task first seen within this long of its file being created is treated as newly created. */
const NEW_FILE_WINDOW_MS = 2 * 60 * 1000;
/** A checklist-window edit only suppresses auto-stage for a metadata change arriving within this long. */
const WINDOW_EDIT_MS = 10 * 1000;

type FM = Record<string, unknown>;

export class Tracker {
	private plugin: SheikoPlugin;
	private ready = false;
	private timers = new Map<string, number>();
	private queued = new Map<string, Transition[]>();
	/** Phase 2: last-seen timer / checklist state, to fire only on the edge (start / last box ticked). */
	private timerRunning = new Map<string, boolean>();
	private checklistDone = new Map<string, boolean | null>();
	/** Status writes Sheiko made itself, with the reason to put on the history line. */
	private pendingReason = new Map<string, { to: string; note: string }>();
	/**
	 * 0.2.4: boxes ticked from the checklist window, by path, with when. The next metadata
	 * change for that note re-baselines the checklist without firing auto-stage, so a
	 * window tick never moves a task (project-manager's read, Sheikh's 2a, 2026-10-23).
	 */
	private windowEdits = new Map<string, number>();

	constructor(plugin: SheikoPlugin) {
		this.plugin = plugin;
	}

	private get cfg(): TaskNotesConfig {
		return this.plugin.taskNotes;
	}

	/** Why Sheiko won't write right now, or null if it can. */
	blockedReason(): string | null {
		if (!this.cfg.found) return 'Sheiko: TaskNotes isn\'t installed and enabled, so Sheiko does nothing. Reload Obsidian after enabling it.';
		const base = vaultBasePath(this.plugin.app);
		if (base === null || !this.plugin.settings.allowedVaults.includes(base)) {
			return 'Sheiko: writes are not allowed in this vault (see Sheiko settings, Safety).';
		}
		return null;
	}

	writesAllowed(): boolean {
		return this.blockedReason() === null;
	}

	get isReady(): boolean {
		return this.ready;
	}

	stop(): void {
		this.ready = false;
		this.pendingReason.clear();
		this.timers.forEach((t) => window.clearTimeout(t));
		this.timers.clear();
		this.queued.clear();
	}

	// ---------- Startup catch-up ----------

	async reconcile(): Promise<void> {
		this.stop();
		if (!this.writesAllowed()) {
			console.debug(`[Sheiko] Tracking is off: ${this.blockedReason() ?? ''}`);
			return;
		}
		const { app } = this.plugin;
		const data = this.plugin.data;
		const cap = this.plugin.settings.maxEditsPerRun;
		const now = new Date();
		let edits = 0;
		let skipped = 0;
		const seen = new Set<string>();

		for (const file of app.vault.getMarkdownFiles()) {
			if (!isTaskFile(app, file, this.cfg)) continue;
			const status = statusOf(app, file, this.cfg);
			if (status === null) continue;
			seen.add(file.path);
			this.baselineTriggers(file);
			const prev = data.lastStatus[file.path];
			if (prev === undefined) {
				// First time Sheiko has seen this task: tracked from here forward, nothing written.
				data.lastStatus[file.path] = status;
				continue;
			}
			if (prev === status) continue;
			if (edits >= cap) {
				skipped++;
				continue; // lastStatus left as-is, so it's picked up next run.
			}
			const t: Transition = { at: now, from: prev, to: status, kind: 'detected' };
			await this.appendHistory(file, [t]);
			if (!isCompletedStatus(this.cfg, prev) && isCompletedStatus(this.cfg, status)) {
				// Decision 2a: flag it, never fill closure fields for an unseen close.
				data.unwitnessedCloses.push({ path: file.path, detectedAt: toLocalIso(now) });
			}
			data.lastStatus[file.path] = status;
			edits++;
		}
		for (const path of Object.keys(data.lastStatus)) {
			if (!seen.has(path)) delete data.lastStatus[path];
		}
		await this.plugin.saveData(this.plugin.data);
		this.ready = true;
		if (edits || skipped) {
			new Notice(
				`Sheiko: recorded ${edits} status change(s) made while Obsidian was closed.` +
					(skipped ? ` ${skipped} more skipped (max edits per run); they'll be picked up next time.` : ''),
			);
		}
	}

	// ---------- Live events ----------

	onMetadataChanged(file: TFile): void {
		if (!this.ready) return;
		const { app } = this.plugin;
		const data = this.plugin.data;
		if (!isTaskFile(app, file, this.cfg)) {
			if (data.lastStatus[file.path] !== undefined) {
				delete data.lastStatus[file.path];
				void this.plugin.saveData(data);
			}
			return;
		}
		const status = statusOf(app, file, this.cfg);
		if (status === null) return;
		const prev = data.lastStatus[file.path];
		if (prev !== status) {
			data.lastStatus[file.path] = status;
			void this.plugin.saveData(data);
			const now = new Date();
			if (prev === undefined) {
				this.baselineTriggers(file);
				if (now.getTime() - file.stat.ctime > NEW_FILE_WINDOW_MS) return; // existing note newly seen: baseline only
				const fm: FM | undefined = app.metadataCache.getFileCache(file)?.frontmatter;
				const created = parseTimestamp(fm?.[this.cfg.field.dateCreated]) ?? new Date(file.stat.ctime);
				this.enqueue(file, { at: created, from: null, to: status, kind: 'created' });
				return;
			}
			const pending = this.pendingReason.get(file.path);
			this.pendingReason.delete(file.path);
			const t: Transition = { at: now, from: prev, to: status, kind: 'live' };
			if (pending && pending.to === status) t.note = pending.note;
			this.enqueue(file, t);
		}
		this.checkAutoStage(file, status);
	}

	// ---------- Phase 2: auto-stage ----------

	private baselineTriggers(file: TFile): void {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		const fm: FM = cache?.frontmatter ?? {};
		this.timerRunning.set(file.path, isTimerRunning(fm[this.cfg.field.timeEntries]));
		this.checklistDone.set(file.path, checklistComplete(cache?.listItems));
	}

	/** Fires only on an edge: a timer that just started, or the last unticked box just ticked. Moves forward only. */
	private checkAutoStage(file: TFile, status: string): void {
		const s = this.plugin.settings;
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		const fm: FM = cache?.frontmatter ?? {};
		const runningNow = isTimerRunning(fm[this.cfg.field.timeEntries]);
		const wasRunning = this.timerRunning.get(file.path);
		this.timerRunning.set(file.path, runningNow);
		const doneNow = checklistComplete(cache?.listItems);
		const wasDone = this.checklistDone.get(file.path);
		this.checklistDone.set(file.path, doneNow);
		const windowEdit = this.windowEdits.get(file.path);
		if (windowEdit !== undefined) {
			this.windowEdits.delete(file.path);
			// A tick from the checklist window: baselines above are updated, nothing moves.
			if (Date.now() - windowEdit < WINDOW_EDIT_MS) return;
		}
		if (isCompletedStatus(this.cfg, status) || this.pendingReason.has(file.path)) return;
		const forward = (target: string): boolean =>
			hasStatus(this.cfg, target) && status !== target && orderOf(this.cfg, status) < orderOf(this.cfg, target);
		// Checklist first: if both happen at once, review wins.
		if (s.reviewStatus && s.autoStageChecklist && doneNow === true && wasDone === false && forward(s.reviewStatus)) {
			void this.setStatus(file, s.reviewStatus, 'auto: all boxes ticked');
			return;
		}
		if (s.autoStageTimer && runningNow && wasRunning === false && forward(s.progressStatus)) {
			void this.setStatus(file, s.progressStatus, 'auto: timer started');
		}
	}

	/**
	 * Sheiko changing a task's status itself (auto-stage, or a sign-off prompt button).
	 * The change then flows through the normal live-change path, so history, closure
	 * and summary behave exactly as if the user had changed it; `note` goes on the history line.
	 */
	async setStatus(file: TFile, to: string, note: string): Promise<boolean> {
		const blocked = this.blockedReason();
		if (blocked) {
			new Notice(blocked);
			return false;
		}
		if (this.plugin.settings.dryRun) {
			console.debug(`[Sheiko dry run] ${file.path}: set status → ${to} (${note})`);
			return false;
		}
		this.pendingReason.set(file.path, { to, note });
		await this.plugin.app.fileManager.processFrontMatter(file, (fm: FM) => {
			fm[this.cfg.field.status] = to;
		});
		return true;
	}

	onRename(file: TAbstractFile, oldPath: string): void {
		const data = this.plugin.data;
		const s = data.lastStatus[oldPath];
		if (s !== undefined) {
			data.lastStatus[file.path] = s;
			delete data.lastStatus[oldPath];
		}
		for (const u of data.unwitnessedCloses) if (u.path === oldPath) u.path = file.path;
		for (const m of [this.timerRunning, this.checklistDone, this.windowEdits] as Map<string, unknown>[]) {
			if (m.has(oldPath)) {
				m.set(file.path, m.get(oldPath));
				m.delete(oldPath);
			}
		}
		const q = this.queued.get(oldPath);
		if (q) {
			this.queued.set(file.path, q);
			this.queued.delete(oldPath);
		}
		void this.plugin.saveData(data);
	}

	onDelete(file: TAbstractFile): void {
		const data = this.plugin.data;
		delete data.lastStatus[file.path];
		this.timerRunning.delete(file.path);
		this.checklistDone.delete(file.path);
		this.windowEdits.delete(file.path);
		data.unwitnessedCloses = data.unwitnessedCloses.filter((u) => u.path !== file.path);
		void this.plugin.saveData(data);
	}

	private enqueue(file: TFile, t: Transition): void {
		const list = this.queued.get(file.path) ?? [];
		list.push(t);
		this.queued.set(file.path, list);
		const existing = this.timers.get(file.path);
		if (existing !== undefined) window.clearTimeout(existing);
		this.timers.set(
			file.path,
			window.setTimeout(() => void this.flush(file.path), SETTLE_MS),
		);
	}

	private async flush(path: string): Promise<void> {
		this.timers.delete(path);
		const list = this.queued.get(path) ?? [];
		this.queued.delete(path);
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || list.length === 0) return;
		await this.annotateCloses(file, list);
		await this.appendHistory(file, list);
		for (const t of list) {
			if (t.kind !== 'live' || t.from === null) continue;
			// Slot logging is a side record: if it fails, tracking (closure fields below) still runs.
			try {
				this.plugin.slots?.onTransition(file, t);
			} catch (e) {
				console.error('[Sheiko] Slot logging failed; tracking continues.', e);
			}
			const was = isCompletedStatus(this.cfg, t.from);
			const now = isCompletedStatus(this.cfg, t.to);
			if (!was && now) {
				const after = await this.applyClosure(file, t.at);
				await this.writeSummary(file, after);
			} else if (was && !now) await this.applyReopen(file);
			const review = this.plugin.settings.reviewStatus;
			if (review && t.to === review && this.plugin.settings.promptOnReview) {
				this.plugin.promptSignoff([file], 'review');
			}
		}
	}

	/**
	 * 0.2.4 (Sheikh's decision 3, 2026-10-23): a live close that Sheiko didn't make itself
	 * (no reason attached) gets "(signed off by <who> at <time>)" if the task had a valid
	 * sign-off, else "(no sign-off recorded)". The sign-off is judged on the history as it
	 * stood just before the close. Closes made with "Sign off and close" keep their own note.
	 */
	private async annotateCloses(file: TFile, list: Transition[]): Promise<void> {
		const review = this.plugin.settings.reviewStatus;
		if (!review) return;
		const needs = list.some((t) => t.kind === 'live' && !t.note && !isCompletedStatus(this.cfg, t.from) && isCompletedStatus(this.cfg, t.to));
		if (!needs) return;
		const content = await this.plugin.app.vault.read(file);
		const fm: FM = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const history = parseHistory(content);
		for (const t of list) {
			if (t.kind === 'live' && !t.note && !isCompletedStatus(this.cfg, t.from) && isCompletedStatus(this.cfg, t.to)) {
				t.note = closeNote(signoffState({ history, content, fm, reviewStatus: review, field: this.plugin.settings.signoffField, identity: this.plugin.settings.identity }));
			}
			history.push(t);
		}
	}

	// ---------- 0.2.4: sign-off without closing ----------

	/** Records a sign-off and leaves the task in review. Needs an identity (Sheikh's decision 4). */
	async signOff(file: TFile): Promise<boolean> {
		const who = this.plugin.settings.identity.trim();
		if (!who) {
			new Notice('Sheiko: set your identity in Sheiko settings to sign off.');
			return false;
		}
		const now = new Date();
		if (this.plugin.settings.signoffRecord === 'field') {
			if (!this.guard()) return false;
			const field = this.plugin.settings.signoffField;
			await this.plugin.app.fileManager.processFrontMatter(file, (fm: FM) => {
				fm[field] = toLocalIso(now);
				fm[byField(field)] = who;
			});
			return true;
		}
		return this.addContext(file, formatContextLine(now, who, SIGNOFF_PHRASE));
	}

	/**
	 * Withdraws a sign-off. Context form: adds a withdrawal line (nothing is removed).
	 * Field form: clears the fields. Both run, so a sign-off in either form is withdrawn.
	 */
	async withdrawSignOff(file: TFile): Promise<boolean> {
		const who = this.plugin.settings.identity.trim();
		if (!who) {
			new Notice('Sheiko: set your identity in Sheiko settings to withdraw a sign-off.');
			return false;
		}
		if (!this.guard()) return false;
		const field = this.plugin.settings.signoffField;
		const fm: FM = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		if (fm[field] !== undefined || fm[byField(field)] !== undefined) {
			await this.plugin.app.fileManager.processFrontMatter(file, (f: FM) => {
				delete f[field];
				delete f[byField(field)];
			});
		}
		return this.addContext(file, formatContextLine(new Date(), who, WITHDRAW_PHRASE));
	}

	/** The close note for "Close now" on a signed-off task, from the note as it is now. */
	async closeNoteFor(file: TFile): Promise<string> {
		const content = await this.plugin.app.vault.read(file);
		const fm: FM = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		return closeNote(
			signoffState({
				history: parseHistory(content),
				content,
				fm,
				reviewStatus: this.plugin.settings.reviewStatus,
				field: this.plugin.settings.signoffField,
				identity: this.plugin.settings.identity,
			}),
		);
	}

	// ---------- 0.2.4: checklist window edits ----------

	/**
	 * Replaces one line of a note, only if it still reads `expected` (so an edit made since
	 * the window drew can't be overwritten). Marks the note so the resulting metadata change
	 * doesn't fire auto-stage. Returns 'ok', 'stale' or 'blocked'.
	 */
	async editLine(file: TFile, index: number, expected: string, replacement: string): Promise<'ok' | 'stale' | 'blocked'> {
		if (!this.guard()) return 'blocked';
		let result: 'ok' | 'stale' = 'stale';
		this.windowEdits.set(file.path, Date.now());
		await this.plugin.app.vault.process(file, (content) => {
			const lines = content.split('\n');
			if (lines[index] !== expected) return content;
			lines[index] = replacement;
			result = 'ok';
			return lines.join('\n');
		});
		if (result === 'stale') this.windowEdits.delete(file.path);
		return result;
	}

	/** Shared write check: blocked vault → notice; dry run → console. True if a write may go ahead. */
	private guard(): boolean {
		const blocked = this.blockedReason();
		if (blocked) {
			new Notice(blocked);
			return false;
		}
		if (this.plugin.settings.dryRun) {
			new Notice('Sheiko dry run: nothing written (see console).');
			console.debug('[Sheiko dry run] write skipped');
			return false;
		}
		return true;
	}

	// ---------- Writes ----------

	private async appendHistory(file: TFile, list: Transition[]): Promise<void> {
		const lines = list.map(formatTransition);
		if (this.plugin.settings.dryRun) {
			console.debug(`[Sheiko dry run] ${file.path}: append to ${HISTORY_HEADING}`, lines);
			return;
		}
		await this.plugin.app.vault.process(file, (content) =>
			lines.reduce((c, l) => appendToSection(c, HISTORY_HEADING, l, isHistoryEntry), content),
		);
	}

	/** Returns the frontmatter as written, so the summary doesn't depend on the (async) metadata cache. */
	private async applyClosure(file: TFile, at: Date): Promise<FM> {
		let after: FM = {};
		const f = this.cfg.field;
		const identity = this.plugin.settings.identity;
		const week = this.plugin.settings.week;
		await this.frontmatter(file, 'closure', (fm) => {
			let wrote = false;
			const cd = fm[f.completedDate];
			if (cd === undefined || cd === null || cd === '') {
				fm[f.completedDate] = toLocalIso(at);
				wrote = true;
			} else if (typeof cd === 'string' && isDateOnly(cd) && cd.trim() === localDateString(at)) {
				// TaskNotes wrote today's date (date-only) for this same close; add the time we saw it happen.
				fm[f.completedDate] = toLocalIso(at);
				wrote = true;
			}
			if (identity && (fm[FIELD.closedBy] === undefined || fm[FIELD.closedBy] === '')) {
				fm[FIELD.closedBy] = identity;
				wrote = true;
			}
			const closed = parseTimestamp(fm[f.completedDate]);
			const created = parseTimestamp(fm[f.dateCreated]); // date-only → null → no duration (never guessed)
			if (fm[FIELD.timeToClose] === undefined && closed && created && closed >= created) {
				const b = splitBuckets(created, closed, week);
				fm[FIELD.timeToClose] = minutesBetween(created, closed);
				fm[FIELD.working] = b.working;
				fm[FIELD.overnight] = b.overnight;
				fm[FIELD.weekend] = b.weekend;
				wrote = true;
			}
			if (wrote) fm[FIELD.source] = 'sheiko';
			after = { ...fm };
		});
		return after;
	}

	private async applyReopen(file: TFile): Promise<void> {
		const f = this.cfg.field;
		await this.frontmatter(file, 'reopen', (fm) => {
			if (fm[FIELD.source] !== 'sheiko') return; // not Sheiko's close: leave it alone
			for (const k of [
				FIELD.closedBy,
				FIELD.timeToClose,
				FIELD.working,
				FIELD.overnight,
				FIELD.weekend,
				FIELD.source,
				f.completedDate,
			]) {
				delete fm[k];
			}
		});
	}

	private async frontmatter(file: TFile, label: string, fn: (fm: FM) => void): Promise<void> {
		if (this.plugin.settings.dryRun) {
			const fm: FM = { ...(this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) };
			const before = JSON.stringify(fm);
			fn(fm);
			console.debug(`[Sheiko dry run] ${file.path}: ${label}`, before, '→', JSON.stringify(fm));
			return;
		}
		await this.plugin.app.fileManager.processFrontMatter(file, fn);
	}

	/**
	 * Writes (or refreshes) the `## Lifecycle Summary` section: Closure + Time per status.
	 * For a completed task with a full-ISO completedDate the numbers stop at the close;
	 * otherwise they run to now.
	 */
	async writeSummary(file: TFile, fmOverride?: FM): Promise<boolean> {
		const blocked = this.blockedReason();
		if (blocked) {
			new Notice(blocked);
			return false;
		}
		const { app } = this.plugin;
		const f = this.cfg.field;
		const fm: FM = fmOverride ?? app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const writtenAt = new Date();
		const status = typeof fm[f.status] === 'string' ? (fm[f.status] as string) : null;
		const closedAt = isCompletedStatus(this.cfg, status) ? parseTimestamp(fm[f.completedDate]) : null;
		const body = await app.vault.read(file);
		const lines = buildSummary({
			history: parseHistory(body),
			end: closedAt ?? writtenAt,
			writtenAt,
			schedule: this.plugin.settings.week,
			label: (s) => labelFor(this.cfg, s),
			closure: {
				created: fm[f.dateCreated],
				completed: fm[f.completedDate],
				closedBy: fm[FIELD.closedBy],
				timeToClose: fm[FIELD.timeToClose],
				working: fm[FIELD.working],
				overnight: fm[FIELD.overnight],
				weekend: fm[FIELD.weekend],
				seenLive: fm[FIELD.source] === 'sheiko',
			},
		});
		if (this.plugin.settings.dryRun) {
			console.debug(`[Sheiko dry run] ${file.path}: write ${SUMMARY_HEADING}`, lines);
			return false;
		}
		await app.vault.process(file, (c) => replaceSection(c, SUMMARY_HEADING, lines));
		return true;
	}

	/** Context entries (append-only). */
	async addContext(file: TFile, line: string): Promise<boolean> {
		const blocked = this.blockedReason();
		if (blocked) {
			new Notice(blocked);
			return false;
		}
		if (this.plugin.settings.dryRun) {
			console.debug(`[Sheiko dry run] ${file.path}: add context`, line);
			new Notice('Sheiko dry run: context not written (see console).');
			return false;
		}
		await this.plugin.app.vault.process(file, (c) => appendToSection(c, CONTEXT_HEADING, line, isContextEntry));
		return true;
	}
}
