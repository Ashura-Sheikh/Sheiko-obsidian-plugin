// An in-memory vault for tests: notes, frontmatter, metadata cache, config files,
// and a stand-in plugin object that Tracker and Roller can run against.

// Imported from the mock directly (not 'obsidian') so these test-only constructors
// type-check; the test build aliases 'obsidian' to the same file, so src/ and the
// tests share one module (instanceof checks work).
import { FileSystemAdapter, Notice, TFile, TFolder } from './obsidian-mock';
import { DEFAULT_SETTINGS, PluginData, SheikoSettings } from '../src/settings';
import { TaskNotesConfig, loadTaskNotesConfig } from '../src/tasknotes';
import { Tracker } from '../src/tracker';
import { Roller } from '../src/roller';
import { FocusSlots } from '../src/slots';
import type SheikoPlugin from '../src/main';
import type { TFile as RealTFile } from 'obsidian';

export const VAULT = '/vaults/test';

type FM = Record<string, unknown>;

// ---------- Minimal YAML (scalars and string lists only) ----------

function parseScalar(v: string): unknown {
	const t = v.trim();
	if (t === '') return null;
	if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
	if (t === 'true') return true;
	if (t === 'false') return false;
	if (t === 'null') return null;
	const q = /^(['"])(.*)\1$/.exec(t);
	return q ? q[2] : t;
}

export function splitNote(content: string): { fm: FM | null; body: string } {
	if (!content.startsWith('---\n')) return { fm: null, body: content };
	const end = content.indexOf('\n---', 4);
	if (end === -1) return { fm: null, body: content };
	const fm: FM = {};
	let listKey: string | null = null;
	for (const line of content.slice(4, end).split('\n')) {
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && listKey) {
			(fm[listKey] as unknown[]).push(parseScalar(item[1] ?? ''));
			continue;
		}
		const kv = /^([^:\s][^:]*):\s?(.*)$/.exec(line);
		if (!kv) continue;
		const key = kv[1] ?? '';
		const raw = kv[2] ?? '';
		if (raw.trim() === '') {
			fm[key] = [];
			listKey = key;
		} else {
			fm[key] = parseScalar(raw);
			listKey = null;
		}
	}
	return { fm, body: content.slice(end + 4).replace(/^\n/, '') };
}

function scalar(v: unknown): string {
	if (typeof v === 'string' && /[:#]\s|^\s|\s$|^$/.test(v)) return JSON.stringify(v);
	return String(v);
}

export function joinNote(fm: FM, body: string): string {
	const lines: string[] = [];
	for (const [k, v] of Object.entries(fm)) {
		if (v === undefined) continue;
		if (Array.isArray(v)) {
			lines.push(`${k}:`);
			for (const x of v) lines.push(`  - ${scalar(x)}`);
		} else lines.push(`${k}: ${scalar(v)}`);
	}
	return `---\n${lines.join('\n')}\n---\n${body}`;
}

// ---------- Fake app ----------

export interface FakeOptions {
	taskNotesInstalled?: boolean;
	taskNotesEnabled?: boolean;
	allowed?: boolean;
	settings?: Partial<SheikoSettings>;
	dailyNotes?: { folder: string; format: string } | null;
}

const STATUSES = [
	{ value: 'open', label: 'Open', isCompleted: false, order: 1 },
	{ value: 'in-progress', label: 'In progress', isCompleted: false, order: 2 },
	{ value: 'in-review', label: 'In Review', isCompleted: false, order: 3 },
	{ value: 'done', label: 'Done', isCompleted: true, order: 4 },
];

export class FakeVault {
	notes = new Map<string, string>();
	folders = new Set<string>();
	config = new Map<string, string>();
	fileObjs = new Map<string, TFile>();
	app: unknown;
	plugin!: SheikoPlugin;
	data!: PluginData;
	prompts: { paths: string[]; reason: string }[] = [];

	constructor(opts: FakeOptions = {}) {
		const installed = opts.taskNotesInstalled ?? true;
		const enabled = opts.taskNotesEnabled ?? true;
		if (installed) {
			this.config.set('.obsidian/plugins/tasknotes/data.json', JSON.stringify({ customStatuses: STATUSES, taskTag: 'task' }));
			this.config.set('.obsidian/plugins/tasknotes/manifest.json', JSON.stringify({ version: '4.13.4' }));
		}
		this.config.set('.obsidian/community-plugins.json', JSON.stringify(enabled && installed ? ['tasknotes'] : []));
		const dn = opts.dailyNotes === undefined ? { folder: 'Daily-Notes', format: 'YYYY-MM-DD' } : opts.dailyNotes;
		if (dn) this.config.set('.obsidian/daily-notes.json', JSON.stringify(dn));

		const adapter = new FileSystemAdapter(VAULT, this.config);
		const vault = {
			configDir: '.obsidian',
			adapter,
			getMarkdownFiles: () => [...this.notes.keys()].filter((p) => p.endsWith('.md')).map((p) => this.file(p)),
			read: (f: TFile) => Promise.resolve(this.notes.get(f.path) ?? ''),
			process: (f: TFile, fn: (c: string) => string) => {
				const next = fn(this.notes.get(f.path) ?? '');
				this.notes.set(f.path, next);
				return Promise.resolve(next);
			},
			create: (path: string, data: string) => {
				this.notes.set(path, data);
				return Promise.resolve(this.file(path));
			},
			createFolder: (path: string) => {
				this.folders.add(path);
				return Promise.resolve();
			},
			getAbstractFileByPath: (path: string) => {
				if (this.notes.has(path)) return this.file(path);
				if (this.folders.has(path)) return new TFolder(path);
				return null;
			},
		};
		const metadataCache = {
			getFileCache: (f: TFile) => {
				const content = this.notes.get(f.path);
				if (content === undefined) return null;
				const { fm, body } = splitNote(content);
				const listItems = body
					.split('\n')
					.map((l) => /^\s*- \[(.)\]/.exec(l)?.[1])
					.filter((t): t is string => t !== undefined)
					.map((task) => ({ task }));
				return { frontmatter: fm ?? undefined, listItems };
			},
		};
		const fileManager = {
			processFrontMatter: (f: TFile, fn: (fm: FM) => void) => {
				const { fm, body } = splitNote(this.notes.get(f.path) ?? '');
				const obj: FM = { ...(fm ?? {}) };
				fn(obj);
				this.notes.set(f.path, joinNote(obj, body));
				return Promise.resolve();
			},
		};
		this.app = { vault, metadataCache, fileManager };

		const settings: SheikoSettings = {
			...DEFAULT_SETTINGS,
			week: DEFAULT_SETTINGS.week.map((d) => ({ ...d })),
			allowedVaults: (opts.allowed ?? true) ? [VAULT] : [],
			...(opts.settings ?? {}),
		};
		this.data = { settings, lastStatus: {}, unwitnessedCloses: [], lastCutoffRun: null, activeSlot: null, lastScheduledSlot: null };
	}

	/** Typed as Obsidian's TFile so tests can pass it straight to src/ code. */
	file(path: string): RealTFile {
		let f = this.fileObjs.get(path);
		if (!f) {
			f = new TFile(path, Date.now() - 24 * 3600 * 1000); // created "yesterday" unless a test says otherwise
			this.fileObjs.set(path, f);
		}
		return f as unknown as RealTFile;
	}

	/** Loads TaskNotes' config the same way the plugin does, then builds Tracker + Roller. */
	async start(): Promise<void> {
		const taskNotes: TaskNotesConfig = await loadTaskNotesConfig(this.app as never);
		const self = this;
		const plugin = {
			app: this.app,
			data: this.data,
			get settings() {
				return self.data.settings;
			},
			taskNotes,
			saveData: () => Promise.resolve(),
			promptSignoff: (files: RealTFile[], reason: 'review' | 'cutoff' | 'manual') => {
				// Calls the plugin's own hold rule (FocusSlots.holdsPrompt), not a copy of it.
				if (plugin.slots.holdsPrompt(files, reason)) return;
				self.prompts.push({ paths: files.map((f) => f.path), reason });
			},
			refreshStatusBar: () => undefined,
			tasksAwaitingSignoff: () =>
				[...self.notes.keys()]
					.filter((p) => self.fm(p).status === self.data.settings.reviewStatus)
					.map((p) => self.file(p)),
		} as unknown as SheikoPlugin;
		plugin.tracker = new Tracker(plugin);
		plugin.roller = new Roller(plugin);
		plugin.slots = new FocusSlots(plugin);
		this.plugin = plugin;
	}

	addTask(path: string, fm: FM, body = 'Some task.\n'): RealTFile {
		const tags = fm.tags ?? ['task'];
		this.notes.set(path, joinNote({ tags, ...fm }, body));
		return this.file(path);
	}

	fm(path: string): FM {
		return splitNote(this.notes.get(path) ?? '').fm ?? {};
	}

	body(path: string): string {
		return splitNote(this.notes.get(path) ?? '').body;
	}

	/** Changes frontmatter "on disk", the way TaskNotes, an agent, or a hand edit would. */
	edit(path: string, changes: FM): void {
		const { fm, body } = splitNote(this.notes.get(path) ?? '');
		const next: FM = { ...(fm ?? {}) };
		for (const [k, v] of Object.entries(changes)) {
			if (v === undefined) delete next[k];
			else next[k] = v;
		}
		this.notes.set(path, joinNote(next, body));
	}

	snapshot(): Map<string, string> {
		return new Map(this.notes);
	}
}

// ---------- Fake timers (the tracker waits SETTLE_MS before writing) ----------

const pending = new Map<number, () => void>();
let nextId = 1;
(globalThis as unknown as { window: unknown }).window = {
	setTimeout: (fn: () => void) => {
		const id = nextId++;
		pending.set(id, fn);
		return id;
	},
	clearTimeout: (id: number) => {
		pending.delete(id);
	},
};

/** Runs every pending timer and lets the async writes they start finish. */
export async function runTimers(): Promise<void> {
	for (let round = 0; round < 5; round++) {
		const fns = [...pending.values()];
		pending.clear();
		for (const fn of fns) fn();
		for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
		if (pending.size === 0) return;
	}
}

export function resetNotices(): void {
	Notice.messages = [];
}

// Keep dry-run logging out of the test output.
console.debug = () => {};
