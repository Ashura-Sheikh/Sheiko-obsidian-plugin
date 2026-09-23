// Phase 3: applies the auto-roll to the vault and writes the summaries.

import { Notice, TFile, moment, normalizePath } from 'obsidian';
import type SheikoPlugin from './main';
import { CONTEXT_HEADING, appendToSection, formatContextLine, localDateString, minutesBetween, parseHistory, sectionLines } from './lifecycle';
import { RollReport, buildRollBlock, contextLineText, parseScheduled, rollTarget } from './roll';
import { isCompletedStatus, isTaskFile, labelFor, statusOf, tagList } from './tasknotes';

export const ROLLED_HEADING = '## 🔁 Rolled Over';
export const ROLL_COUNT = 'rollCount';
/** A cutoff acted on more than this long after it passed counts as a catch-up. */
const CATCH_UP_MS = 5 * 60 * 1000;

type FM = Record<string, unknown>;

export class Roller {
	private plugin: SheikoPlugin;
	private running = false;

	constructor(plugin: SheikoPlugin) {
		this.plugin = plugin;
	}

	/** Rolls unfinished tasks scheduled on or before `cut`'s day to the next day. */
	async run(cut: Date, manual: boolean): Promise<RollReport | null> {
		const { app } = this.plugin;
		const s = this.plugin.settings;
		const tracker = this.plugin.tracker;
		if (!tracker.writesAllowed()) {
			new Notice('Sheiko: writes are not allowed in this vault (see Sheiko settings → Safety).');
			return null;
		}
		if (this.running) return null;
		this.running = true;
		try {
			const cfg = this.plugin.taskNotes;
			const runAt = new Date();
			const cutDay = localDateString(cut);
			const report: RollReport = {
				cut,
				runAt,
				catchUp: !manual && runAt.getTime() - cut.getTime() > CATCH_UP_MS,
				manual,
				rolled: [],
				noDate: [],
				capped: [],
			};
			let edits = 0;
			for (const file of app.vault.getMarkdownFiles()) {
				if (!isTaskFile(app, file, cfg)) continue;
				const status = statusOf(app, file, cfg);
				if (isCompletedStatus(cfg, status)) continue;
				const fm: FM = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
				// Recurring tasks: TaskNotes uses `scheduled` as the repeat anchor, so rolling would break the series.
				const rec = fm[cfg.field.recurrence];
				if (rec !== undefined && rec !== null && rec !== '') continue;
				if (tagList(fm).includes(cfg.field.archiveTag)) continue;
				const statusLabel = status ? labelFor(cfg, status) : '—';
				const scheduled = fm[cfg.field.scheduled];
				if (!parseScheduled(scheduled)) {
					report.noDate.push({ path: file.path, name: file.basename, statusLabel });
					continue;
				}
				const to = rollTarget(scheduled, cutDay);
				if (to === null) continue;
				if (edits >= s.maxEditsPerRun) {
					report.capped.push({ path: file.path, name: file.basename });
					continue;
				}
				const from = parseScheduled(scheduled)?.date ?? String(scheduled);
				const prevCount = fm[ROLL_COUNT];
				const rollCount = (typeof prevCount === 'number' ? prevCount : 0) + 1;
				const history = parseHistory(await app.vault.read(file));
				const last = history[history.length - 1];
				const inReview = status === s.reviewStatus;
				report.rolled.push({
					path: file.path,
					name: file.basename,
					statusLabel,
					inReview,
					from,
					to,
					due: parseScheduled(fm[cfg.field.due])?.date ?? null,
					rollCount,
					minutesInStatus: last && last.to === status ? minutesBetween(last.at, runAt) : null,
				});
				const line = formatContextLine(
					runAt,
					'sheiko',
					contextLineText(from, to, cut, statusLabel, rollCount, report.catchUp, manual),
				);
				if (s.dryRun) {
					console.debug(`[Sheiko dry run] roll ${file.path}: scheduled ${String(scheduled)} → ${to}, rollCount ${rollCount}`, line);
				} else {
					await app.fileManager.processFrontMatter(file, (f: FM) => {
						f[cfg.field.scheduled] = to;
						f[ROLL_COUNT] = rollCount;
					});
					await app.vault.process(file, (c) => appendToSection(c, CONTEXT_HEADING, line));
				}
				edits++;
			}
			if (report.rolled.length || report.noDate.length || report.capped.length) await this.writeDailyNote(cut, report);
			const parts = [`Sheiko: rolled ${report.rolled.length} task(s) to ${cutDay === localDateString(runAt) && !manual ? 'tomorrow' : 'the next day'}.`];
			if (report.noDate.length) parts.push(`${report.noDate.length} with no date.`);
			if (report.capped.length) parts.push(`${report.capped.length} not rolled (edit limit).`);
			if (s.dryRun) parts.push('(Dry run: nothing written.)');
			new Notice(parts.join(' '));
			return report;
		} finally {
			this.running = false;
		}
	}

	/** Appends this run's block under "## 🔁 Rolled Over" in the cutoff day's daily note. */
	private async writeDailyNote(cut: Date, report: RollReport): Promise<void> {
		const { app } = this.plugin;
		const block = buildRollBlock(report).join('\n');
		const path = await this.dailyNotePath(cut);
		if (this.plugin.settings.dryRun) {
			console.debug(`[Sheiko dry run] daily note ${path}: append to ${ROLLED_HEADING}`, block);
			return;
		}
		let file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
			if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
			file = await app.vault.create(path, `# ${localDateString(cut)}\n`);
		}
		if (file instanceof TFile) {
			await app.vault.process(file, (c) => {
				// Blank line between runs so each block's heading stands on its own.
				const hasRuns = sectionLines(c, ROLLED_HEADING).some((l) => l.trim() !== '');
				return appendToSection(c, ROLLED_HEADING, hasRuns ? `\n${block}` : block);
			});
		}
	}

	/** Uses Obsidian's Daily Notes settings (folder + format), defaulting to YYYY-MM-DD in the vault root. */
	private async dailyNotePath(day: Date): Promise<string> {
		const { app } = this.plugin;
		let folder = '';
		let format = 'YYYY-MM-DD';
		const cfgPath = normalizePath(`${app.vault.configDir}/daily-notes.json`);
		try {
			if (await app.vault.adapter.exists(cfgPath)) {
				const raw = JSON.parse(await app.vault.adapter.read(cfgPath)) as { folder?: unknown; format?: unknown };
				if (typeof raw.folder === 'string') folder = raw.folder.trim().replace(/^\/+|\/+$/g, '');
				if (typeof raw.format === 'string' && raw.format.trim()) format = raw.format.trim();
			}
		} catch (e) {
			console.error('[Sheiko] Could not read Daily Notes settings, using defaults', e);
		}
		const name = moment(day).format(format);
		return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
	}
}
