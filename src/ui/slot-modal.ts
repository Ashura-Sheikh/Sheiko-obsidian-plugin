import { App, Modal, Setting } from 'obsidian';
import type SheikoPlugin from '../main';
import { SlotKind, kindLabel } from '../slot-logic';

/** Start a break or deep-work slot now, for a number of minutes. */
export class StartSlotModal extends Modal {
	private plugin: SheikoPlugin;

	constructor(app: App, plugin: SheikoPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('sheiko-modal');
		this.titleEl.setText('Start a break or deep-work slot');
		contentEl.createEl('p', {
			cls: 'sheiko-muted',
			text: 'Sign-off prompts are held until it ends. A report of what happened is added to today’s note in your report folder.',
		});
		let kind: SlotKind = 'deep-work';
		let minutes = 60;
		new Setting(contentEl).setName('Type').addDropdown((d) =>
			d
				.addOption('deep-work', kindLabel('deep-work'))
				.addOption('break', kindLabel('break'))
				.setValue(kind)
				.onChange((v) => (kind = v === 'break' ? 'break' : 'deep-work')),
		);
		const len = new Setting(contentEl).setName('Minutes').addText((t) => {
			t.setValue(String(minutes)).onChange((v) => {
				const n = Number(v);
				if (Number.isInteger(n) && n > 0 && n <= 24 * 60) minutes = n;
			});
			t.inputEl.type = 'number';
		});
		for (const n of [15, 30, 60, 90]) len.addButton((b) => b.setButtonText(`${n}m`).setTooltip(`${n} minutes`).onClick(() => {
			minutes = n;
			const input = len.controlEl.querySelector('input');
			if (input) input.value = String(n);
		}));
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText('Start')
					.setCta()
					.onClick(() => {
						const blocked = this.plugin.tracker.blockedReason();
						if (blocked) {
							this.contentEl.createEl('p', { cls: 'sheiko-muted', text: blocked });
							return;
						}
						const end = new Date(Date.now() + minutes * 60 * 1000);
						if (this.plugin.slots.start(kind, end, 'manual')) this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Confirms ending the running slot early. */
export class EndSlotModal extends Modal {
	private plugin: SheikoPlugin;

	constructor(app: App, plugin: SheikoPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const slot = this.plugin.slots.active;
		const { contentEl } = this;
		contentEl.addClass('sheiko-modal');
		if (!slot) {
			this.close();
			return;
		}
		this.titleEl.setText(`${kindLabel(slot.kind)} until ${slot.end.slice(11, 16)}`);
		const n = slot.events.length;
		const files = Object.keys(slot.touched).length;
		contentEl.createEl('p', {
			cls: 'sheiko-muted',
			text: `So far: ${n} status change(s), ${slot.held.length} sign-off prompt(s) held, ${files} Markdown file(s) touched.`,
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Keep going').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText('End now and write report')
					.setCta()
					.onClick(() => {
						this.close();
						void this.plugin.slots.finish(true);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
