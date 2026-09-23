import { App, Modal, Setting, TFile } from 'obsidian';
import type SheikoPlugin from '../main';
import { labelFor } from '../tasknotes';

export type SignoffReason = 'review' | 'cutoff';

/**
 * Sign-off prompt. Closing stays the user's decision: nothing is closed unless
 * "Approve and close" is clicked. One window at a time; new prompts are added to it.
 */
export class SignoffModal extends Modal {
	private plugin: SheikoPlugin;
	private files: TFile[] = [];
	private reason: SignoffReason;

	constructor(app: App, plugin: SheikoPlugin, reason: SignoffReason) {
		super(app);
		this.plugin = plugin;
		this.reason = reason;
	}

	add(files: TFile[]): void {
		for (const f of files) if (!this.files.some((x) => x.path === f.path)) this.files.push(f);
		this.render();
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		this.plugin.signoffClosed(this);
	}

	private render(): void {
		const { contentEl } = this;
		const s = this.plugin.settings;
		const cfg = this.plugin.taskNotes;
		contentEl.empty();
		contentEl.addClass('sheiko-modal');
		this.titleEl.setText(this.files.length === 1 ? 'Sign-off needed' : `Sign-off needed: ${this.files.length} tasks`);
		contentEl.createEl('p', {
			cls: 'sheiko-muted',
			text:
				this.reason === 'cutoff'
					? 'End of day. These tasks are still waiting for sign-off.'
					: 'This task has moved to review and is waiting for sign-off.',
		});
		for (const file of [...this.files]) {
			new Setting(contentEl)
				.setName(file.basename)
				.addButton((b) =>
					b.setButtonText('Open').onClick(() => {
						void this.app.workspace.getLeaf(false).openFile(file);
					}),
				)
				.addButton((b) =>
					b.setButtonText(`Send back to ${labelFor(cfg, s.progressStatus)}`).onClick(async () => {
						if (await this.plugin.tracker.setStatus(file, s.progressStatus, 'sent back at sign-off')) this.done(file);
					}),
				)
				.addButton((b) =>
					b
						.setButtonText('Approve and close')
						.setCta()
						.onClick(async () => {
							if (await this.plugin.tracker.setStatus(file, s.doneStatus, `signed off by ${s.identity}`)) this.done(file);
						}),
				);
		}
		new Setting(contentEl).addButton((b) => b.setButtonText('Later').onClick(() => this.close()));
	}

	private done(file: TFile): void {
		this.files = this.files.filter((f) => f.path !== file.path);
		if (this.files.length === 0) this.close();
		else this.render();
	}
}
