// v0.2.2: sign-off window decisions, kept free of DOM and Obsidian code so the tests run the
// same rules the plugin does (the same pattern as the slot hold rule and the ready gate).

/** What to do with a sign-off prompt. */
export type SignoffRoute = 'held' | 'add' | 'open';

/**
 * Decides where a sign-off prompt goes.
 * - `held`: a break / deep-work slot is holding automatic prompts.
 * - `add`: a sign-off window is open on screen, so the tasks are added to it.
 * - `open`: no window, or the one still referenced is no longer on screen. A new one opens.
 *
 * `windowShown` is `null` when no window is referenced, otherwise whether it's still on screen.
 * Before 0.2.2, a referenced window was always reused, even if it was gone, so no prompt appeared.
 */
export function signoffRoute(held: boolean, windowShown: boolean | null): SignoffRoute {
	if (held) return 'held';
	return windowShown === true ? 'add' : 'open';
}

/** The `[Sheiko]` console line for each route, so a missed prompt can be traced. */
export function signoffRouteLog(route: SignoffRoute, reason: string, count: number, staleDropped: boolean): string {
	const tasks = `${count} task${count === 1 ? '' : 's'}`;
	if (route === 'held') return `[Sheiko] Sign-off prompt held by the running slot (${reason}, ${tasks}).`;
	if (route === 'add') return `[Sheiko] Sign-off: added to the open window (${reason}, ${tasks}).`;
	return `[Sheiko] Sign-off window opened (${reason}, ${tasks})${staleDropped ? '; the previous window was no longer on screen' : ''}.`;
}

/**
 * Whether a card is unfolded. Cards start folded above a set number of tasks; a card the user
 * opened or closed keeps that state across redraws, so a redraw doesn't fold it back.
 */
export function isCardOpen(path: string, foldedByDefault: boolean, overrides: ReadonlyMap<string, boolean>): boolean {
	return overrides.get(path) ?? !foldedByDefault;
}

/**
 * Records a card's fold state after it's toggled. Only a state that differs from the default is
 * kept, so setting the default during a redraw (which also fires `toggle`) records nothing.
 */
export function recordCardToggle(path: string, open: boolean, foldedByDefault: boolean, overrides: Map<string, boolean>): void {
	if (open === !foldedByDefault) overrides.delete(path);
	else overrides.set(path, open);
}

/** Drops fold states for tasks no longer in the window. */
export function pruneCardStates(paths: readonly string[], overrides: Map<string, boolean>): void {
	for (const p of [...overrides.keys()]) if (!paths.includes(p)) overrides.delete(p);
}
