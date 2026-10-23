// 0.2.4: which tasks in review are signed off but not closed. Kept apart from main.ts
// so the tests run this class itself against the in-memory vault, not a copy of it.

import type { App, TFile } from 'obsidian';
import { parseHistory } from './lifecycle';
import type { SheikoSettings } from './settings';
import { SignoffEvent, signoffState } from './signoff-record';
import { TaskNotesConfig, isTaskFile, statusOf } from './tasknotes';

export class SignoffIndex {
	/** Signed off and still in review, by path, with the sign-off that counts. */
	readonly map = new Map<string, SignoffEvent>();

	constructor(
		private app: App,
		private cfg: () => TaskNotesConfig,
		private settings: () => SheikoSettings,
	) {}

	private inReview(file: TFile): boolean {
		const review = this.settings().reviewStatus;
		return !!review && isTaskFile(this.app, file, this.cfg()) && statusOf(this.app, file, this.cfg()) === review;
	}

	/** Re-reads one note. Returns true if its signed-off state changed. */
	async refresh(file: TFile): Promise<boolean> {
		if (!this.cfg().found || file.extension !== 'md') return false;
		if (!this.inReview(file)) return this.map.delete(file.path);
		// read, not cachedRead: right after Sheiko's own write the cache can still hold the old text.
		const content = await this.app.vault.read(file);
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const s = this.settings();
		const st = signoffState({ history: parseHistory(content), content, fm, reviewStatus: s.reviewStatus, field: s.signoffField });
		const had = this.map.has(file.path);
		if (st.signedOff && st.event) this.map.set(file.path, st.event);
		else this.map.delete(file.path);
		return had !== st.signedOff;
	}

	async rebuild(): Promise<void> {
		this.map.clear();
		if (!this.cfg().found || !this.settings().reviewStatus) return;
		await Promise.all(this.app.vault.getMarkdownFiles().filter((f) => this.inReview(f)).map((f) => this.refresh(f)));
	}

	rename(oldPath: string, newPath: string): void {
		const ev = this.map.get(oldPath);
		this.map.delete(oldPath);
		if (ev) this.map.set(newPath, ev);
	}

	/** In review and NOT signed off: the sign-off window, its count and its prompts. */
	awaiting(): TFile[] {
		if (!this.cfg().found) return [];
		return this.app.vault.getMarkdownFiles().filter((f) => this.inReview(f) && !this.map.has(f.path));
	}

	/** In review and signed off: the "waiting to close" list and its count. */
	signed(): TFile[] {
		if (!this.cfg().found) return [];
		return this.app.vault.getMarkdownFiles().filter((f) => this.map.has(f.path) && this.inReview(f));
	}
}
