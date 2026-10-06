import { App, Modal, Setting, TFile } from 'obsidian';
import type SheikoPlugin from '../main';
import { formatContextLine, formatMinutes, parseHistory, toLocalIso } from '../lifecycle';
import { SENT_BACK_NOTE, classifyWorker, computeFacts, describeTask, latestContext, workerLabel } from '../review';
import { labelFor } from '../tasknotes';

export type SignoffReason = 'review' | 'cutoff' | 'manual';

/** Above this many tasks, cards start folded so the window stays short. */
const FOLD_ABOVE = 3;

/**
 * Sign-off prompt. Closing stays the user's decision: nothing is closed unless
 * "Approve and close" is clicked. One window at a time; new prompts are added to it.
 * Each task shows who worked on it, a short summary and a facts line, all read
 * locally from the note.
 */
export class SignoffModal extends Modal {
	private plugin: SheikoPlugin;
	private files: TFile[] = [];
	private reason: SignoffReason;
	/** Guards against overlapping async renders writing into the same container. */
	private renderToken = 0;

	constructor(app: App, plugin: SheikoPlugin, reason: SignoffReason) {
		super(app);
		this.plugin = plugin;
		this.reason = reason;
	}

	add(files: TFile[]): void {
		for (const f of files) if (!this.files.some((x) => x.path === f.path)) this.files.push(f);
		void this.render();
	}

	onOpen(): void {
		void this.render();
	}

	onClose(): void {
		this.renderToken++;
		this.contentEl.empty();
		this.plugin.signoffClosed(this);
	}

	private intro(): string {
		if (this.reason === 'cutoff') return 'End of day. These tasks are still waiting for sign-off.';
		if (this.reason === 'manual') return this.files.length === 1 ? 'This task is waiting for sign-off.' : 'These tasks are waiting for sign-off.';
		return this.files.length === 1
			? 'This task has moved to review and is waiting for sign-off.'
			: 'These tasks have moved to review and are waiting for sign-off.';
	}

	private async render(): Promise<void> {
		const token = ++this.renderToken;
		const files = [...this.files];
		// Read every note before touching the DOM, so a newer render can't interleave with this one.
		const contents = await Promise.all(files.map((f) => this.app.vault.cachedRead(f).catch(() => '')));
		if (token !== this.renderToken) return;

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('sheiko-modal', 'sheiko-signoff');
		this.titleEl.setText(files.length === 1 ? 'Sign-off needed' : `Sign-off needed: ${files.length} tasks`);
		contentEl.createEl('p', { cls: 'sheiko-muted', text: this.intro() });
		files.forEach((file, i) => this.renderCard(contentEl, file, contents[i] ?? '', files.length > FOLD_ABOVE));
		new Setting(contentEl)
			.setDesc('Tasks left for later stay in the status bar count. Click it to come back here.')
			.addButton((b) => b.setButtonText('Later').onClick(() => this.close()));
	}

	private renderCard(parent: HTMLElement, file: TFile, content: string, folded: boolean): void {
		const s = this.plugin.settings;
		const cfg = this.plugin.taskNotes;
		const cache = this.app.metadataCache.getFileCache(file);
		const fm: Record<string, unknown> = cache?.frontmatter ?? {};
		const card = parent.createDiv({ cls: 'sheiko-card' });

		const worker = classifyWorker(fm[s.workerField], s.agentNames);
		const head = new Setting(card).setName(file.basename);
		head
			.addButton((b) =>
				b.setButtonText('Open').onClick(() => {
					void this.app.workspace.getLeaf(false).openFile(file);
				}),
			)
			.addButton((b) =>
				b.setButtonText(`Send back to ${labelFor(cfg, s.progressStatus)}`).onClick(async () => {
					if (!(await this.saveDraft(file))) return;
					if (await this.plugin.tracker.setStatus(file, s.progressStatus, SENT_BACK_NOTE)) this.done(file);
				}),
			)
			.addButton((b) =>
				b
					.setButtonText('Approve and close')
					.setCta()
					.onClick(async () => {
						if (!(await this.saveDraft(file))) return;
						if (await this.plugin.tracker.setStatus(file, s.doneStatus, s.identity ? `signed off by ${s.identity}` : 'signed off')) this.done(file);
					}),
			);

		// Own line under the header, so the badge doesn't wrap inside the narrow name column.
		card
			.createDiv({ cls: 'sheiko-card-worker' })
			.createSpan({ cls: `sheiko-worker sheiko-worker-${worker.kind}`, text: workerLabel(worker) });

		const details = card.createEl('details', { cls: 'sheiko-card-details' });
		details.open = !folded;
		details.createEl('summary', { text: 'Summary and context' });

		const desc = describeTask(content);
		details.createEl('p', { cls: desc ? '' : 'sheiko-muted', text: desc || 'No description in the note.' });

		const ctx = latestContext(content);
		if (ctx) {
			const p = details.createEl('p', { cls: 'sheiko-latest-context' });
			p.createEl('strong', { text: `Latest context${ctx.who ? ` (${ctx.who})` : ''}: ` });
			p.appendText(ctx.text);
		}

		const boxes = (cache?.listItems ?? []).filter((li) => typeof li.task === 'string');
		const facts = computeFacts({
			history: parseHistory(content),
			now: new Date(),
			schedule: s.week,
			progressStatus: s.progressStatus,
			reviewStatus: s.reviewStatus,
			checklist: boxes.length ? { done: boxes.filter((li) => li.task !== ' ').length, total: boxes.length } : null,
			due: fm[cfg.field.due],
		});
		const parts: string[] = [];
		if (facts.progressMinutes !== null) parts.push(`${labelFor(cfg, s.progressStatus)}: ${formatMinutes(facts.progressMinutes)}`);
		if (facts.inReviewSince) parts.push(`In review since ${toLocalIso(facts.inReviewSince).slice(0, 16).replace('T', ' ')}`);
		if (facts.checklist) parts.push(`Checklist ${facts.checklist.done}/${facts.checklist.total}`);
		if (facts.due) parts.push(`${facts.overdue ? '⚠️ Overdue' : 'Due'} ${facts.due.replace('T', ' ')}`);
		if (facts.sentBack > 0) parts.push(`Sent back ${facts.sentBack}×`);
		if (parts.length) details.createEl('p', { cls: 'sheiko-muted sheiko-facts', text: parts.join(' · ') });

		// Context box: always visible (outside the fold). The draft survives re-renders, and is
		// saved before Approve / Send back so a note typed but not added isn't lost.
		const drafts = this.plugin.signoffDrafts;
		new Setting(card)
			.setClass('sheiko-card-context')
			.addTextArea((t) => {
				t.setPlaceholder('Add context for this task…')
					.setValue(drafts.get(file.path) ?? '')
					.onChange((v) => {
						if (v.trim()) drafts.set(file.path, v);
						else drafts.delete(file.path);
					});
				t.inputEl.rows = 2;
				t.inputEl.addClass('sheiko-context-input');
			})
			.addButton((b) =>
				b.setButtonText('Add').onClick(async () => {
					if (!drafts.get(file.path)?.trim()) return;
					if (await this.saveDraft(file)) void this.render();
				}),
			);
	}

	/**
	 * Writes this task's typed-but-unsaved context, if any. Returns false only if there
	 * was a draft and it couldn't be written (writes blocked / dry run), so the caller
	 * stops instead of changing status with the note silently dropped.
	 */
	private async saveDraft(file: TFile): Promise<boolean> {
		const draft = this.plugin.signoffDrafts.get(file.path)?.trim();
		if (!draft) return true;
		const line = formatContextLine(new Date(), this.plugin.settings.identity, draft);
		if (!(await this.plugin.tracker.addContext(file, line))) return false;
		this.plugin.signoffDrafts.delete(file.path);
		return true;
	}

	private done(file: TFile): void {
		this.files = this.files.filter((f) => f.path !== file.path);
		if (this.files.length === 0) this.close();
		else void this.render();
	}
}
