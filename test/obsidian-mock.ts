// Stand-in for the `obsidian` module, used only by the test build (test/run.mjs
// aliases `obsidian` to this file). Covers just what src/ needs outside the UI.

export class Notice {
	static messages: string[] = [];
	constructor(message: string) {
		Notice.messages.push(message);
	}
}

export class TAbstractFile {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
}

export class TFolder extends TAbstractFile {}

export class TFile extends TAbstractFile {
	stat: { ctime: number; mtime: number; size: number };
	constructor(path: string, ctime: number) {
		super(path);
		this.stat = { ctime, mtime: ctime, size: 0 };
	}
	get basename(): string {
		const name = this.path.split('/').pop() ?? this.path;
		return name.replace(/\.[^.]+$/, '');
	}
	get extension(): string {
		const m = /\.([^./]+)$/.exec(this.path);
		return m?.[1] ?? '';
	}
}

export class FileSystemAdapter {
	private base: string;
	private files: Map<string, string>;
	constructor(base: string, files: Map<string, string>) {
		this.base = base;
		this.files = files;
	}
	getBasePath(): string {
		return this.base;
	}
	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}
	read(path: string): Promise<string> {
		const v = this.files.get(path);
		return v === undefined ? Promise.reject(new Error(`missing ${path}`)) : Promise.resolve(v);
	}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Only the date tokens the plugin's daily-note paths use. */
export function moment(d: Date): { format: (fmt: string) => string } {
	return {
		format: (fmt: string) =>
			fmt
				.replace('YYYY', String(d.getFullYear()))
				.replace('MM', pad(d.getMonth() + 1))
				.replace('DD', pad(d.getDate())),
	};
}

// UI classes: imported by src/settings.ts at module load, never exercised by the tests.
export class PluginSettingTab {
	constructor(..._args: unknown[]) {}
}
export class Setting {
	constructor(..._args: unknown[]) {}
}
export class Modal {
	constructor(..._args: unknown[]) {}
}
export class Plugin {}
export type App = unknown;
