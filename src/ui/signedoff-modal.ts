import { App, ButtonComponent, Modal, TFile } from 'obsidian';
import type SheikoPlugin from '../main';
import { toLocalIso } from '../lifecycle';
import { classifyWorker, workerLabel } from '../review';
import { renderPriorityPill } from './pill';

/**
 * 0.2.4: tasks signed off with "Sign off" but still in review, waiting for whoever
 * closes them. Opened from the "✓ N signed off" status-bar item, the link in the
 * sign-off window, or the command palette.
 */
export class SignedOffModal extends Modal {
	private plugin: SheikoPlugin;

	constructor(app: App, plugin: SheikoPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('sheiko-modal', 'sheiko-signoff', 'sheiko-signedoff');
		const files = this.plugin.tasksSignedOff();
		this.titleEl.setText(files.length === 1 ? 'Signed off, waiting to close' : `Signed off, waiting to close: ${files.length} tasks`);
		if (files.length === 0) {
			contentEl.createEl('p', { cls: 'sheiko-muted', text: 'Nothing is waiting.' });
			return;
		}
		contentEl.createEl('p', {
			cls: 'sheiko-muted',
			text: 'Signed off and still in review. Whoever closes them records the close; Sheiko notes the sign-off on the history line.',
		});
		for (const file of files) this.renderRow(contentEl, file);
	}

	private renderRow(parent: HTMLElement, file: TFile): void {
		const s = this.plugin.settings;
		const ev = this.plugin.signedOff.get(file.path);
		const fm: Record<string, unknown> = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const card = parent.createDiv({ cls: 'sheiko-card' });
		card.createDiv({ cls: 'sheiko-card-title', text: file.basename, attr: { title: file.basename } });
		const meta = card.createDiv({ cls: 'sheiko-card-worker' });
		const worker = classifyWorker(fm[s.workerField], s.agentNames);
		renderPriorityPill(meta, this.plugin.taskNotes, fm[this.plugin.taskNotes.field.priority]);
		meta.createSpan({ cls: `sheiko-worker sheiko-worker-${worker.kind}`, text: workerLabel(worker) });
		if (ev) {
			card.createEl('p', {
				cls: 'sheiko-muted sheiko-facts',
				text: `Signed off by ${ev.who} at ${toLocalIso(ev.at).slice(0, 16).replace('T', ' ')} (${ev.source === 'field' ? 'field' : 'context line'})`,
			});
		}
		const actions = card.createDiv({ cls: 'sheiko-card-actions' });
		new ButtonComponent(actions).setButtonText('Open').onClick(() => {
			void this.app.workspace.getLeaf(false).openFile(file);
		});
		new ButtonComponent(actions).setButtonText('Withdraw sign-off').onClick(async () => {
			if (await this.plugin.tracker.withdrawSignOff(file)) this.after(file);
		});
		new ButtonComponent(actions)
			.setButtonText('Close now')
			.setCta()
			.onClick(async () => {
				const note = await this.plugin.tracker.closeNoteFor(file);
				if (await this.plugin.tracker.setStatus(file, s.doneStatus, note)) this.after(file);
			});
	}

	/**
	 * After a withdrawal or close the task is no longer signed off-and-waiting. Dropped from
	 * the index straight away; the next metadata change re-reads the note to confirm.
	 */
	private after(file: TFile): void {
		this.plugin.signedOff.delete(file.path);
		this.plugin.refreshStatusBar();
		if (this.plugin.tasksSignedOff().length === 0) this.close();
		else this.render();
	}
}
