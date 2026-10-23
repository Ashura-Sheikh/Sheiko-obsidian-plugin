import { ButtonComponent, Component, ItemView, MarkdownRenderer, Notice, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import type SheikoPlugin from '../main';
import { formatContextLine } from '../lifecycle';
import { ChecklistItem, ChecklistSection, boxNoteText, checklistSections, tickContextText, toggledLine } from '../checklist';

export const CHECKLIST_VIEW = 'sheiko-checklist';

/**
 * 0.2.4: a task's checklist in its own pop-out window (resizable, movable), opened from
 * "Checklist n/m" on a sign-off card. Shows every section with checkboxes in full.
 *
 * Ticking writes one character on that line, only if the line is unchanged since the
 * window drew it. Every tick is logged as a Context line, and a ticked box can get a
 * note. Window ticks never move the task (no auto-stage). Protected sections are
 * view-only. Writes follow Sheiko's usual rules: allowed vault, dry run.
 */
export class ChecklistView extends ItemView {
	private plugin: SheikoPlugin;
	private path = '';
	private md = new Component();
	private token = 0;
	/** Which ticked boxes have their "add a note" box open, by line. */
	private noting = new Set<number>();

	constructor(leaf: WorkspaceLeaf, plugin: SheikoPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = false;
	}

	getViewType(): string {
		return CHECKLIST_VIEW;
	}

	getDisplayText(): string {
		const f = this.file();
		return f ? `Checklist: ${f.basename}` : 'Checklist';
	}

	getIcon(): string {
		return 'list-checks';
	}

	getState(): Record<string, unknown> {
		return { path: this.path };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const p = (state as { path?: unknown } | null)?.path;
		if (typeof p === 'string') this.path = p;
		await super.setState(state, result);
		this.redraw();
	}

	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.metadataCache.on('changed', (f) => {
				if (f.path === this.path) this.redraw();
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (f, old) => {
				if (old === this.path) {
					this.path = f.path;
					this.redraw();
				}
			}),
		);
		this.redraw();
		return Promise.resolve();
	}

	async onClose(): Promise<void> {
		this.token++;
		this.md.unload();
		return Promise.resolve();
	}

	private file(): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.path);
		return f instanceof TFile ? f : null;
	}

	private redraw(): void {
		this.render().catch((e: unknown) => console.error('[Sheiko] Checklist window failed to draw:', e));
	}

	private async render(): Promise<void> {
		const token = ++this.token;
		const file = this.file();
		const el = this.contentEl;
		if (!file) {
			el.empty();
			el.createEl('p', { cls: 'sheiko-muted', text: 'This note no longer exists.' });
			return;
		}
		const content = await this.app.vault.read(file);
		if (token !== this.token) return;
		const scroll = el.scrollTop;
		this.md.unload();
		this.md = new Component();
		this.md.load();
		el.empty();
		el.addClass('sheiko-checklist');
		const s = this.plugin.settings;
		const sections = checklistSections(content, s.protectedHeadings);
		const all = sections.flatMap((x) => x.items);
		const head = el.createDiv({ cls: 'sheiko-checklist-head' });
		head.createEl('h3', { text: file.basename });
		head.createEl('p', {
			cls: 'sheiko-muted',
			text: `Checklist ${all.filter((i) => i.checked).length}/${all.length}. Ticks here are written to the note and logged in its Context.`,
		});
		new ButtonComponent(head).setButtonText('Open note').onClick(() => {
			void this.app.workspace.getLeaf('tab').openFile(file);
		});
		const why = this.cannotTick();
		if (why) head.createEl('p', { cls: 'sheiko-checklist-warn', text: why });
		if (sections.length === 0) {
			el.createEl('p', { cls: 'sheiko-muted', text: 'This note has no checkboxes.' });
			return;
		}
		const lines = content.split('\n');
		for (const sec of sections) this.renderSection(el, file, lines, sec, why !== null);
		el.scrollTop = scroll;
	}

	/** Why nothing can be ticked from here right now, or null. */
	private cannotTick(): string | null {
		if (!this.plugin.settings.identity.trim()) return 'View only: set your identity in Sheiko settings to tick from here, so each tick shows who made it.';
		const blocked = this.plugin.tracker.blockedReason();
		if (blocked) return `View only. ${blocked}`;
		if (this.plugin.settings.dryRun) return 'View only: dry run is on.';
		return null;
	}

	private renderSection(parent: HTMLElement, file: TFile, lines: string[], sec: ChecklistSection, viewOnly: boolean): void {
		const box = parent.createDiv({ cls: `sheiko-checklist-section${sec.protected ? ' is-protected' : ''}` });
		if (sec.protected) {
			box.createEl('p', { cls: 'sheiko-checklist-warn', text: '🔒 Protected section: view only. Its owner ticks these in the note itself.' });
		}
		// Text between boxes is rendered in runs, so paragraphs and lists keep their shape.
		const itemsByLine = new Map(sec.items.map((it) => [it.line, it]));
		let run: string[] = [];
		const flush = (): void => {
			if (run.join('').trim()) {
				const div = box.createDiv({ cls: 'markdown-rendered sheiko-checklist-text' });
				void MarkdownRenderer.render(this.app, run.join('\n'), div, file.path, this.md);
			}
			run = [];
		};
		for (let i = sec.startLine; i < sec.endLine; i++) {
			const it = itemsByLine.get(i);
			if (!it) {
				run.push(lines[i] ?? '');
				continue;
			}
			flush();
			this.renderItem(box, file, it, viewOnly || sec.protected);
		}
		flush();
	}

	private renderItem(parent: HTMLElement, file: TFile, it: ChecklistItem, viewOnly: boolean): void {
		const row = parent.createDiv({ cls: 'sheiko-checklist-item' });
		row.setCssProps({ '--sheiko-indent': `${Math.min(it.indent, 24) / 2}em` });
		const cb = row.createEl('input', { type: 'checkbox', cls: 'task-list-item-checkbox' });
		cb.checked = it.checked;
		cb.disabled = viewOnly;
		const label = row.createDiv({ cls: 'markdown-rendered sheiko-checklist-label' });
		void MarkdownRenderer.render(this.app, it.text || ' ', label, file.path, this.md);
		cb.addEventListener('change', () => void this.toggle(file, it, cb.checked, cb));
		if (it.checked && !viewOnly) {
			const add = row.createEl('a', { cls: 'sheiko-checklist-note-link', href: '#', text: 'Add note' });
			add.addEventListener('click', (ev) => {
				ev.preventDefault();
				if (this.noting.has(it.line)) this.noting.delete(it.line);
				else this.noting.add(it.line);
				this.redraw();
			});
			if (this.noting.has(it.line)) this.renderNoteBox(parent, file, it);
		}
	}

	private renderNoteBox(parent: HTMLElement, file: TFile, it: ChecklistItem): void {
		const wrap = parent.createDiv({ cls: 'sheiko-checklist-note' });
		const ta = wrap.createEl('textarea', { attr: { rows: '2', placeholder: 'Note on this box, added to the task\'s context section…' } });
		const btns = wrap.createDiv({ cls: 'sheiko-card-actions' });
		new ButtonComponent(btns).setButtonText('Cancel').onClick(() => {
			this.noting.delete(it.line);
			this.redraw();
		});
		new ButtonComponent(btns)
			.setButtonText('Add note')
			.setCta()
			.onClick(async () => {
				const text = ta.value.trim();
				if (!text) return;
				const line = formatContextLine(new Date(), this.plugin.settings.identity, boxNoteText(it.text, text));
				if (await this.plugin.tracker.addContext(file, line)) {
					this.noting.delete(it.line);
					new Notice('Sheiko: note added to the task\'s context section.');
					this.redraw();
				}
			});
		ta.focus();
	}

	private async toggle(file: TFile, it: ChecklistItem, tick: boolean, cb: HTMLInputElement): Promise<void> {
		const res = await this.plugin.tracker.editLine(file, it.line, it.raw, toggledLine(it.raw, tick));
		if (res !== 'ok') {
			cb.checked = !tick;
			if (res === 'stale') new Notice('Sheiko: that line changed since the window drew it, so nothing was written. Showing the note as it is now.');
			this.redraw();
			return;
		}
		const line = formatContextLine(new Date(), this.plugin.settings.identity, tickContextText(it.text, tick));
		await this.plugin.tracker.addContext(file, line);
	}
}
