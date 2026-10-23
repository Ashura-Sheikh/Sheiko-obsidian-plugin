// 0.2.4: how long tasks have been waiting in review, in separate bands of clock time
// (Sheikh's answers 1-3, 2026-10-23). Pure logic, tested directly.
//
// With hours [3, 6, 12, 24] the bands are 3–6h, 6–12h, 12–24h and 24h+, labelled
// ">3h", ">6h", ">12h", ">24h". A task under the first threshold, or with no
// "entered review" time, isn't in any band.

export interface AgeBand {
	/** Lower bound in hours (inclusive). */
	from: number;
	/** Upper bound in hours (exclusive), or null for the last band. */
	to: number | null;
	label: string;
	/** "3–6 hours" / "over 24 hours", for the tooltip. */
	range: string;
	paths: string[];
}

const HOUR = 3600 * 1000;

/** When the task last entered review, from Status History (the card's "In review since"). */
export function reviewSince(history: { at: Date; to: string }[], reviewStatus: string): Date | null {
	if (!reviewStatus) return null;
	let at: Date | null = null;
	for (const t of history) if (t.to === reviewStatus) at = t.at;
	return at;
}

/** "3, 6, 12, 24" → [3, 6, 12, 24]. Null unless every value is a positive number and they rise. */
export function parseBandHours(text: string): number[] | null {
	const parts = text.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
	if (parts.length === 0) return null;
	const nums = parts.map(Number);
	if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
	for (let i = 1; i < nums.length; i++) if ((nums[i] ?? 0) <= (nums[i - 1] ?? 0)) return null;
	return nums;
}

export function ageBands(items: { path: string; since: Date | null }[], now: Date, hours: number[]): AgeBand[] {
	const bands: AgeBand[] = hours.map((h, i) => {
		const next = hours[i + 1];
		return {
			from: h,
			to: next ?? null,
			label: `>${h}h`,
			range: next === undefined ? `over ${h} hours` : `${h}–${next} hours`,
			paths: [],
		};
	});
	for (const it of items) {
		if (!it.since) continue;
		const age = (now.getTime() - it.since.getTime()) / HOUR;
		for (const b of bands) {
			if (age >= b.from && (b.to === null || age < b.to)) {
				b.paths.push(it.path);
				break;
			}
		}
	}
	return bands;
}
