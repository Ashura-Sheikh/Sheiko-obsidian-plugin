import { App, ButtonComponent, Component, MarkdownRenderer, Modal, Setting, TFile } from 'obsidian';
import type SheikoPlugin from '../main';
import { formatContextLine, formatDuration, parseHistory, toLocalIso } from '../lifecycle';
import {
	DESCRIPTION_SHORT,
	SENT_BACK_NOTE,
	classifyWorker,
	computeFacts,
	latestContext,
	plainLength,
	taskDescription,
	workerLabel,
} from '../review';
import { isCardOpen, pruneCardStates, recordCardToggle } from '../signoff-logic';
import { AgeBand, ageBands, reviewSince } from '../age-bands';
import { renderPriorityPill } from './pill';
import { labelFor } from '../tasknotes';

export type SignoffReason = 'review' | 'cutoff' | 'manual';

/** Above this many tasks, cards start folded so the window stays short. */
const FOLD_ABOVE = 3;

/**
 * Sign-off prompt. Closing stays the user's decision: nothing is closed unless
 * "Sign off and close" is clicked. "Sign off" records a sign-off and leaves the task
 * in review (0.2.4). One window at a time; new prompts are added to it.
 * Each task shows who worked on it, a short summary and a facts line, all read
 * locally from the note.
 */
export class SignoffModal extends Modal {
	private plugin: SheikoPlugin;
	private files: TFile[] = [];
	private reason: SignoffReason;
	/** Guards against overlapping async renders writing into the same container. */
	private renderToken = 0;
	/** Cards the user unfolded or folded, by task path, so a redraw doesn't reset them (0.2.2). */
	private cardStates = new Map<string, boolean>();
	/** Descriptions the user expanded with "Show more", by task path, kept across redraws (0.2.3). */
	private expanded = new Set<string>();
	/** 0.2.4: the age band the window is filtered to (its index), or null for all tasks. */
	private bandFilter: number | null = null;
	/** Owns the rendered Markdown in the cards; replaced on each redraw, unloaded on close (0.2.3). */
	private md = new Component();

	constructor(app: App, plugin: SheikoPlugin, reason: SignoffReason) {
		super(app);
		this.plugin = plugin;
		this.reason = reason;
	}

	add(files: TFile[]): void {
		for (const f of files) if (!this.files.some((x) => x.path === f.path)) this.files.push(f);
		this.redraw();
	}

	/** Whether this window is on screen. A closed or never-opened window isn't (0.2.2). */
	isShown(): boolean {
		return this.containerEl.isConnected;
	}

	onOpen(): void {
		this.redraw();
	}

	/** Redraws, logging a failure instead of dropping it silently (0.2.2). */
	private redraw(): void {
		this.render().catch((e: unknown) => console.error('[Sheiko] Sign-off window failed to draw:', e));
	}

	onClose(): void {
		this.renderToken++;
		this.md.unload();
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
		// Keep the text box being typed in, its cursor and the scroll position across the redraw (0.2.2).
		const focus = this.captureFocus();
		const scroll = { modal: this.modalEl.scrollTop, content: contentEl.scrollTop };
		this.md.unload();
		this.md = new Component();
		this.md.load();
		contentEl.empty();
		contentEl.addClass('sheiko-modal', 'sheiko-signoff');
		this.titleEl.setText(files.length === 1 ? 'Sign-off needed' : `Sign-off needed: ${files.length} tasks`);
		contentEl.createEl('p', { cls: 'sheiko-muted', text: this.intro() });
		// 0.2.4: the way to tasks signed off with "Sign off" and still waiting to close.
		const nSigned = this.plugin.tasksSignedOff().length;
		if (nSigned > 0) {
			const link = contentEl.createEl('a', { cls: 'sheiko-signed-link', href: '#', text: `✓ ${nSigned} signed off, waiting to close` });
			link.addEventListener('click', (ev) => {
				ev.preventDefault();
				this.plugin.openSignedOff();
			});
		}
		pruneCardStates(files.map((f) => f.path), this.cardStates);
		for (const path of [...this.expanded]) if (!files.some((f) => f.path === path)) this.expanded.delete(path);
		// 0.2.4: age bands (clock time since each task last entered review); a click filters the cards.
		const now = new Date();
		const bands = ageBands(
			files.map((f, i) => ({ path: f.path, since: reviewSince(parseHistory(contents[i] ?? ''), this.plugin.settings.reviewStatus) })),
			now,
			this.plugin.settings.ageBandHours,
		);
		if (this.bandFilter !== null && !bands[this.bandFilter]) this.bandFilter = null;
		this.renderBands(contentEl, bands);
		const shown = this.bandFilter === null ? null : new Set(bands[this.bandFilter]?.paths ?? []);
		files.forEach((file, i) => {
			if (shown && !shown.has(file.path)) return;
			this.renderCard(contentEl, file, contents[i] ?? '', files.length > FOLD_ABOVE);
		});
		if (shown && shown.size === 0) contentEl.createEl('p', { cls: 'sheiko-muted', text: 'No tasks in this band now.' });
		new Setting(contentEl)
			.setDesc('Tasks left for later stay in the status bar count. Click it to come back here.')
			.addButton((b) => b.setButtonText('Later').onClick(() => this.close()));
		this.modalEl.scrollTop = scroll.modal;
		contentEl.scrollTop = scroll.content;
		if (focus) this.restoreFocus(focus);
	}

	/** "In review: >3h [3] · >6h [10] · …", each band clickable; "All" clears the filter. */
	private renderBands(parent: HTMLElement, bands: AgeBand[]): void {
		if (bands.length === 0) return;
		const line = parent.createDiv({ cls: 'sheiko-bands' });
		line.createSpan({ text: 'In review: ' });
		bands.forEach((b, i) => {
			if (i > 0) line.createSpan({ cls: 'sheiko-muted', text: ' · ' });
			const el = line.createEl('a', {
				cls: `sheiko-band${this.bandFilter === i ? ' is-active' : ''}`,
				href: '#',
				text: `${b.label} [${b.paths.length}]`,
				attr: { title: `${b.range} in review (clock time). Click to show only these.`, 'aria-pressed': String(this.bandFilter === i) },
			});
			el.addEventListener('click', (ev) => {
				ev.preventDefault();
				this.bandFilter = this.bandFilter === i ? null : i;
				this.redraw();
			});
		});
		if (this.bandFilter !== null) {
			line.createSpan({ cls: 'sheiko-muted', text: ' · ' });
			const all = line.createEl('a', { cls: 'sheiko-band', href: '#', text: 'All' });
			all.addEventListener('click', (ev) => {
				ev.preventDefault();
				this.bandFilter = null;
				this.redraw();
			});
		}
	}

	private captureFocus(): { path: string; start: number; end: number } | null {
		const el = this.contentEl.ownerDocument.activeElement;
		// instanceOf, not instanceof: works for elements in an Obsidian popout window too.
		if (!el?.instanceOf(HTMLTextAreaElement) || !this.contentEl.contains(el)) return null;
		const path = el.getAttribute('data-sheiko-path');
		return path === null ? null : { path, start: el.selectionStart, end: el.selectionEnd };
	}

	private restoreFocus(focus: { path: string; start: number; end: number }): void {
		const box = Array.from(this.contentEl.querySelectorAll('textarea')).find((t) => t.getAttribute('data-sheiko-path') === focus.path);
		if (!box) return;
		box.focus({ preventScroll: true });
		box.setSelectionRange(focus.start, focus.end);
	}

	private renderCard(parent: HTMLElement, file: TFile, content: string, folded: boolean): void {
		const s = this.plugin.settings;
		const cfg = this.plugin.taskNotes;
		const cache = this.app.metadataCache.getFileCache(file);
		const fm: Record<string, unknown> = cache?.frontmatter ?? {};
		const card = parent.createDiv({ cls: 'sheiko-card' });

		const worker = classifyWorker(fm[s.workerField], s.agentNames);
		// 0.2.3 (#5): the title gets its own full-width line, cut with "…" if too long
		// (full title on hover); the buttons sit in a row below it instead of squeezing it.
		card.createDiv({ cls: 'sheiko-card-title', text: file.basename, attr: { title: file.basename } });
		const actions = card.createDiv({ cls: 'sheiko-card-actions' });
		new ButtonComponent(actions).setButtonText('Open').onClick(() => {
			void this.app.workspace.getLeaf(false).openFile(file);
		});
		new ButtonComponent(actions).setButtonText(`Send back to ${labelFor(cfg, s.progressStatus)}`).onClick(async () => {
			if (!(await this.saveDraft(file))) return;
			if (await this.plugin.tracker.setStatus(file, s.progressStatus, SENT_BACK_NOTE)) this.done(file);
		});
		// 0.2.4 (Sheikh, 2026-10-23): "Sign off" records the sign-off and leaves the task in
		// review for whoever closes it; "Sign off and close" is the old "Approve and close".
		const signOff = new ButtonComponent(actions)
			.setButtonText('Sign off')
			.setCta()
			.onClick(async () => {
				if (!(await this.saveDraft(file))) return;
				if (await this.plugin.tracker.signOff(file)) {
					this.done(file);
					this.plugin.signoffChanged(file);
				}
			});
		if (!s.identity.trim()) {
			// Decision 4: an anonymous sign-off can't be read by anyone, so the button is off.
			signOff.setDisabled(true).setTooltip('Set your identity in Sheiko settings to sign off.');
		}
		new ButtonComponent(actions)
			.setButtonText('Sign off and close')
			.setCta()
			.onClick(async () => {
				if (!(await this.saveDraft(file))) return;
				if (await this.plugin.tracker.setStatus(file, s.doneStatus, s.identity ? `signed off by ${s.identity}` : 'signed off')) this.done(file);
			});

		// Own line under the header, so the badge doesn't wrap inside the narrow name column.
		const meta = card.createDiv({ cls: 'sheiko-card-worker' });
		// 0.2.4: priority pill, in TaskNotes' own label and colour.
		renderPriorityPill(meta, cfg, fm[cfg.field.priority]);
		meta.createSpan({ cls: `sheiko-worker sheiko-worker-${worker.kind}`, text: workerLabel(worker) });

		const details = card.createEl('details', { cls: 'sheiko-card-details' });
		details.open = isCardOpen(file.path, folded, this.cardStates);
		details.addEventListener('toggle', () => {
			// A card from a previous redraw can still fire after it's been replaced; ignore it.
			if (details.isConnected) recordCardToggle(file.path, details.open, folded, this.cardStates);
		});
		details.createEl('summary', { text: 'Summary and context' });

		this.renderDescription(details, file, content);

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
		if (facts.progressMs !== null) parts.push(`${labelFor(cfg, s.progressStatus)}: ${formatDuration(facts.progressMs)}`);
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
				t.inputEl.setAttr('data-sheiko-path', file.path);
			})
			.addButton((b) =>
				b.setButtonText('Add').onClick(async () => {
					if (!drafts.get(file.path)?.trim()) return;
					if (await this.saveDraft(file)) this.redraw();
				}),
			);
	}

	/**
	 * Writes this task's typed-but-unsaved context, if any. Returns false only if there
	 * was a draft and it couldn't be written (writes blocked / dry run), so the caller
	 * stops instead of changing status with the note silently dropped.
	 */
	/**
	 * 0.2.3 (#6): the task's first real section, rendered as Markdown (template lines such as
	 * Meta Bind fields skipped). Longer than about DESCRIPTION_SHORT characters: clamped,
	 * with "Show more" / "Show less". Internal links open the note, like the Open button.
	 */
	private renderDescription(parent: HTMLElement, file: TFile, content: string): void {
		const desc = taskDescription(content);
		if (!desc) {
			parent.createEl('p', { cls: 'sheiko-muted', text: 'No description in the note.' });
			return;
		}
		const box = parent.createDiv({ cls: 'sheiko-desc' });
		const body = box.createDiv({ cls: 'sheiko-desc-body markdown-rendered' });
		const long = plainLength(desc) > DESCRIPTION_SHORT;
		const open = this.expanded.has(file.path);
		if (long && !open) body.addClass('is-clamped');
		MarkdownRenderer.render(this.app, desc, body, file.path, this.md).catch((e: unknown) =>
			console.error('[Sheiko] Could not render the task description:', e),
		);
		body.addEventListener('click', (ev) => {
			// instanceOf, not instanceof: works in an Obsidian popout window too (see captureFocus).
			const target = ev.target as Node | null;
			if (!target?.instanceOf(HTMLElement)) return;
			const link = target.closest('a.internal-link');
			if (!link) return;
			ev.preventDefault();
			const href = link.getAttribute('data-href') ?? link.getAttribute('href');
			if (href) void this.app.workspace.openLinkText(href, file.path, false);
		});
		if (!long) return;
		const more = box.createEl('a', { cls: 'sheiko-desc-more', text: open ? 'Show less' : 'Show more', href: '#' });
		more.addEventListener('click', (ev) => {
			ev.preventDefault();
			const nowOpen = body.hasClass('is-clamped');
			body.toggleClass('is-clamped', !nowOpen);
			more.setText(nowOpen ? 'Show less' : 'Show more');
			if (nowOpen) this.expanded.add(file.path);
			else this.expanded.delete(file.path);
		});
	}

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
		else this.redraw();
	}
}
