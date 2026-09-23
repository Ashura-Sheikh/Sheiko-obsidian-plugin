import { App, Modal, Setting, TFile } from 'obsidian';
import type SheikoPlugin from '../main';
import {
	CONTEXT_HEADING,
	computeDurations,
	formatContextLine,
	formatMinutes,
	parseHistory,
	sectionLines,
} from '../lifecycle';
import { labelFor } from '../tasknotes';
import { FIELD } from '../tracker';

type FM = Record<string, unknown>;

function display(v: unknown): string {
	if (v === undefined || v === null || v === '') return '—';
	if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
	return JSON.stringify(v);
}

/** Task lifecycle: Context log (+ add), closure record, time per status. */
export class LifecycleModal extends Modal {
	private plugin: SheikoPlugin;
	private file: TFile;

	constructor(app: App, plugin: SheikoPlugin, file: TFile) {
		super(app);
		this.plugin = plugin;
		this.file = file;
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('sheiko-modal');
		const cfg = this.plugin.taskNotes;
		const body = await this.app.vault.read(this.file);
		const fm: FM = this.app.metadataCache.getFileCache(this.file)?.frontmatter ?? {};

		this.titleEl.setText(this.file.basename);

		// ---- Context ----
		contentEl.createEl('h4', { text: 'Context' });
		const ctx = sectionLines(body, CONTEXT_HEADING).filter((l) => l.trim().startsWith('- '));
		if (ctx.length === 0) contentEl.createEl('p', { cls: 'sheiko-muted', text: 'No context yet.' });
		else {
			const ul = contentEl.createEl('ul', { cls: 'sheiko-context' });
			for (const l of ctx) ul.createEl('li', { text: l.trim().slice(2).replace(/\*\*/g, '') });
		}
		let draft = '';
		new Setting(contentEl)
			.addTextArea((t) => {
				t.setPlaceholder('Add context…').onChange((v) => (draft = v));
				t.inputEl.rows = 3;
				t.inputEl.addClass('sheiko-context-input');
			})
			.addButton((b) =>
				b
					.setButtonText('Add')
					.setCta()
					.onClick(async () => {
						if (!draft.trim()) return;
						const line = formatContextLine(new Date(), this.plugin.settings.identity, draft);
						if (await this.plugin.tracker.addContext(this.file, line)) await this.render();
					}),
			);

		// ---- Closure ----
		contentEl.createEl('h4', { text: 'Closure' });
		const closure = contentEl.createDiv({ cls: 'sheiko-grid' });
		const row = (k: string, v: unknown): void => {
			closure.createSpan({ cls: 'sheiko-muted', text: k });
			closure.createSpan({ text: display(v) });
		};
		row('Created', fm[cfg.field.dateCreated]);
		row('Completed', fm[cfg.field.completedDate]);
		row('Closed by', fm[FIELD.closedBy]);
		const ttc = fm[FIELD.timeToClose];
		row(
			'Time to close',
			typeof ttc === 'number'
				? `${formatMinutes(ttc)}  (working ${formatMinutes(Number(fm[FIELD.working] ?? 0))} · overnight ${formatMinutes(
						Number(fm[FIELD.overnight] ?? 0),
					)} · weekend ${formatMinutes(Number(fm[FIELD.weekend] ?? 0))})`
				: undefined,
		);
		row('Recorded by', fm[FIELD.source] === 'sheiko' ? 'Sheiko (seen live)' : fm[cfg.field.completedDate] ? 'Someone else, or by hand' : undefined);

		// ---- Time per status ----
		contentEl.createEl('h4', { text: 'Time per status' });
		const history = parseHistory(body);
		const rep = computeDurations(history, new Date(), this.plugin.settings.week);
		if (rep.untracked) {
			contentEl.createEl('p', {
				cls: 'sheiko-muted',
				text: 'No status changes recorded yet. Tracked from here forward; earlier history isn’t filled in.',
			});
			return;
		}
		const table = contentEl.createEl('table', { cls: 'sheiko-table' });
		const head = table.createEl('tr');
		for (const h of ['Status', 'Total', 'Working', 'Overnight', 'Weekend']) head.createEl('th', { text: h });
		for (const s of rep.perStatus) {
			const tr = table.createEl('tr');
			tr.createEl('td', { text: labelFor(cfg, s.status) + (s.status === rep.current ? ' (now)' : '') });
			tr.createEl('td', { text: formatMinutes(s.minutes) });
			tr.createEl('td', { text: formatMinutes(s.buckets.working) });
			tr.createEl('td', { text: formatMinutes(s.buckets.overnight) });
			tr.createEl('td', { text: formatMinutes(s.buckets.weekend) });
		}
		if (rep.gapMinutes > 0) {
			const tr = table.createEl('tr', { cls: 'sheiko-muted' });
			tr.createEl('td', { text: 'Gap (changed while Obsidian was closed)' });
			tr.createEl('td', { text: formatMinutes(rep.gapMinutes) });
			tr.createEl('td', { text: 'Not split: the real change time is unknown', attr: { colspan: '3' } });
		}
		const first = history[0];
		if (first && first.kind !== 'created') {
			contentEl.createEl('p', {
				cls: 'sheiko-muted',
				text: 'Time before the first recorded change isn’t counted.',
			});
		}
	}
}

/** Lists closes made while Obsidian was closed (decision 2a: flagged, never filled in). */
export class UnwitnessedModal extends Modal {
	private plugin: SheikoPlugin;

	constructor(app: App, plugin: SheikoPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText('Closed while Obsidian was shut');
		const list = this.plugin.data.unwitnessedCloses;
		contentEl.createEl('p', {
			cls: 'sheiko-muted',
			text: 'Sheiko didn’t see these closes happen, so it hasn’t filled in any closure fields for them.',
		});
		if (list.length === 0) {
			contentEl.createEl('p', { text: 'None.' });
			return;
		}
		const ul = contentEl.createEl('ul');
		for (const u of list) {
			const li = ul.createEl('li');
			const a = li.createEl('a', { text: u.path.replace(/\.md$/, ''), href: '#' });
			a.addEventListener('click', (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(u.path, '', false);
				this.close();
			});
			li.appendText(`, detected ${u.detectedAt}`);
		}
		new Setting(contentEl).addButton((b) =>
			b.setButtonText('Clear list').onClick(async () => {
				this.plugin.data.unwitnessedCloses = [];
				await this.plugin.saveData(this.plugin.data);
				this.close();
			}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
