# Sheiko Task Lifecycle

An Obsidian plugin that works **alongside [TaskNotes](https://github.com/callumalpass/tasknotes)** to add task-lifecycle tracking and a daily auto-roll for unfinished tasks.

> **Status: early release (v0.2.0), desktop only.** Plugin ID `sheiko-task-lifecycle`. Tested against TaskNotes **4.13.4**. Listed in the [Obsidian Community directory](https://community.obsidian.md/plugins/sheiko-task-lifecycle).

![The lifecycle window on a closed task: Context, Closure, and time per status split into working, overnight and weekend](docs/screenshots/lifecycle-window.png)

*Click the ribbon icon (history clock) on a TaskNotes task to open the lifecycle window. Screenshots are from the developer's test vault: sample task names are test data and may not match the task's current status, and some settings differ from the defaults below.*

## Before you start: what Sheiko changes in your vault

Sheiko edits your notes, so it starts switched off and stays cautious:

- **It does nothing unless TaskNotes is installed and enabled.** No tracking, no auto-roll, no prompts. If you enable TaskNotes later, reload Obsidian.
- **It writes nothing until you allow the current vault** (Settings → Sheiko Task Lifecycle → Safety → *Allow writes in this vault*). Until then it's read-only.
- **Auto-roll is off by default.** Turn on *Dry run* first to see what it would change, then switch auto-roll on. Dry-run output goes to the developer console (Ctrl/Cmd+Shift+I) at the *Verbose* log level.
- **Each batch run is capped** at 25 edited notes by default (*Max edits per run*). The rest are picked up on the next run.

Once allowed, it writes to **task notes** (frontmatter: `completedDate`, `closedBy`, `timeToCloseMinutes`, `timeWorkingMinutes`, `timeOvernightMinutes`, `timeWeekendMinutes`, `closureSource`, `scheduled`, `rollCount`, `status`; sections: `## Context`, `## Status History`, `## Lifecycle Summary`) and, when auto-roll runs, to **that day's daily note** (`## 🔁 Rolled Over`, creating the note if it doesn't exist). To find TaskNotes tasks it looks through the vault's Markdown files (Obsidian's directory lists this as "vault enumeration"), but it only edits task notes, the daily note and, if you use slots, its own report notes (see below). It never sends data anywhere: no network use, no telemetry.

**New in 0.2.0:** notes typed in the sign-off window are added to that task's `## Context`. If you use break or deep-work slots, Sheiko also writes **one report note per day** in a report folder (default `Sheiko Reports/2026-10-06.md`). Each slot adds a block, and earlier blocks are never changed. No slots, no report notes.

## Getting started

1. Install and enable [TaskNotes](https://github.com/callumalpass/tasknotes), then this plugin.
2. In this plugin's settings, switch on **Allow writes in this vault**.
3. Optional: enter **Your identity**. It's written as `closedBy` on closes Sheiko records. Left blank, `closedBy` isn't written.
4. Optional, for the sign-off flow: add a review status (e.g. `in-review`) in TaskNotes' settings, then pick it as **Review status** here. Until a review status is picked, the checkbox move and both sign-off prompts stay off.
5. Optional: set your **working hours**, try **Dry run**, then switch on **auto-roll**.

## What it does

### 1. Task lifecycle (Phase 1)

- **Context log.** An append-only `## Context` section in each task note, with entries formatted `- **{timestamp} — {who}:** {text}` (`— {who}` is left out when no identity is set).
- **Status history.** An append-only `## Status History` section with ISO-timestamped transitions. Clicking the same status again isn't logged.
- **Closure fields.** `completedDate` (full ISO), `closedBy` (only if an identity is set) and `timeToCloseMinutes` are written **only for a close Sheiko saw happen live**. Sheiko never overwrites a close written by hand or by another tool. Closes it recorded are marked `closureSource: sheiko`, and a reopen clears only those.
- **Time per status, in three buckets.** Time is split into working hours, overnight and weekend, written as `timeWorkingMinutes`, `timeOvernightMinutes` and `timeWeekendMinutes`. The three always add up to `timeToCloseMinutes`.
- **Lifecycle Summary.** A `## Lifecycle Summary` section (closure plus time per status), refreshed in place. It's written automatically on a live close, or on demand.
- **Startup catch-up.** Status changes made while Obsidian was closed are logged as "detected at startup", never given an invented time. Time spent in a status that was skipped over is shown as a **gap**, not estimated. Closes Sheiko didn't see happen are listed and flagged, never filled in.

### 2. Auto-stage and sign-off (Phase 2)

- **Auto-stage (forward only).** Starting a TaskNotes timer moves the task to the working status. Ticking the last unticked checkbox moves it to the review status. Moves happen only when something changes, never just because of existing state, and never backwards or out of a completed status.
- **Sign-off window.** It opens when a task enters review, and at each day's end time for anything still waiting. Each task gets a card with:
  - **Who worked on it**, read from a frontmatter field (default `assignedTo`). Names you list as AI agents show as *AI agent*, any other name as *Human*, and an empty field as *Worker: not recorded*. It's never guessed.
  - **Summary and context:** the first lines of the task's description, the latest Context entry, and the facts: time in progress, in review since, checklist progress, due or overdue, and how many times it was sent back. Cards start folded when more than 3 tasks are waiting.
  - **A context box** for a note while you decide. It's saved to the task's Context before *Approve* or *Send back* runs.

  Buttons: *Approve and close*, *Send back*, *Open*, *Later*. **Closing a task is always a user click, never automatic.**
- **Coming back to "Later".** The status bar shows **⭐ N awaiting sign-off**. Click it to reopen the window with everything still in review. It's hidden when nothing is waiting, and you can switch it off.

![The Sign-off needed window: one card per task with Open, Send back and Approve and close, a worker badge (AI agent, Human, or Worker: not recorded), a folded Summary and context panel, and a context box](docs/screenshots/sign-off-window.png)

![The status bar showing 4 awaiting sign-off and a running Deep work until 13:50 slot](docs/screenshots/status-bar.png)

### 3. Auto-roll and summary (Phase 3)

- At each day's end time (**weekends included**), unfinished tasks scheduled on or before that day have `scheduled` moved to the next day. A time of day, if present, is kept. **`due` never changes**, so slippage stays visible. `rollCount` goes up by one each time.
- **Not rolled:** completed, scheduled in the future, recurring (TaskNotes uses `scheduled` as the repeat anchor), and archived tasks. Tasks with **no date** are listed as "give these a date".
- **Summary, in two places:** a Context line on each rolled task, and a `## 🔁 Rolled Over` section in that day's daily note (one block per run, never overwritten). In-review tasks are listed first (⭐), and past-due tasks are flagged ⚠️.
- If Obsidian was closed at the cutoff, one **catch-up** roll runs on next open, labelled as a catch-up.

![A daily note's Rolled Over section: the run time, a table of rolled tasks, and the list of tasks with no date](docs/screenshots/rolled-over-daily-note.png)

### 4. Breaks and deep work

Start a slot from the 🎧 status-bar item or the command palette, or schedule slots per weekday in settings (e.g. `12:30-13:00 break, 14:00-15:30 deep work`). Break and deep work behave the same way.

- **While a slot runs**, sign-off prompts are held. Opening the sign-off window yourself still works. Sheiko logs:
  - tasks moved to review;
  - closes and other status changes;
  - tasks whose timed `due` falls inside the slot;
  - Markdown files touched.
- **When it ends**, at its time or early from the status bar, a report block is added to that day's note in the report folder, and held prompts are shown.
- **Time tracking is unchanged.** Slots don't affect the working, overnight and weekend split.
- **What "files touched" means:** any Markdown file changed while Obsidian is open, by you or by another plugin. For example, TaskNotes re-saves its board order across a column when a card moves. Changes made while Obsidian was closed, such as by an agent editing files directly, aren't captured, and the report says so. If Obsidian was closed during part of a slot, that stretch is noted as a gap.

<p>
  <img src="docs/screenshots/slot-start.png" alt="Start a break or deep-work slot: type, minutes, and 15m / 30m / 60m / 90m buttons" width="49%">
  <img src="docs/screenshots/slot-end.png" alt="Ending a break early: counts so far, with Keep going and End now and write report" width="49%">
</p>

![A slot report block: moved to review with the worker, closed, other status changes, came due, and Markdown files touched, ending with the closed-while-Obsidian-was-shut caveat](docs/screenshots/slot-report.png)

## Commands

- Open task lifecycle (context, closure, time per status). Also opened from the ribbon icon.
- Write lifecycle summary to this task
- Show tasks waiting for sign-off
- Roll unfinished tasks now (scheduled today or earlier → tomorrow)
- List tasks closed while Obsidian was shut
- Start a break or deep-work slot
- End the current break or deep-work slot now

The ribbon icon and the lifecycle command need a TaskNotes task open. On any other note you get a notice instead:

![The notice 'Sheiko: open a TaskNotes task first.' after clicking the ribbon icon on a daily note](docs/screenshots/open-task-first.png)

## Settings

| Setting | Default | Notes |
|---|---|---|
| Identity | *(blank)* | Written as `closedBy` and in Context entries. Blank = no `closedBy`. |
| Working hours (per weekday) | 09:00–17:00, every day | The end time is also the daily roll cutoff. The same window decides the working / overnight / weekend split. |
| Allowed vaults | *(empty)* | **Nothing is written until the current vault is allowed.** |
| Dry run | off | Logs intended writes instead of making them, including the daily note and slot reports |
| Max edits per run | 25 | Caps startup catch-up and auto-roll. Tasks held back are listed and picked up on the next run. |
| Working / review / done status | `in-progress` / *(not set)* / `done` | Picked from TaskNotes' own status list. While review is not set, the checkbox move and both sign-off prompts are off. |
| Auto-stage on timer start / all boxes ticked | on / on | Each can be switched off |
| Sign-off prompt on review / at cutoff | on / on | Each can be switched off |
| Auto-roll | off | Try dry run first |
| Show sign-off count in the status bar | on | Click it to reopen the sign-off window |
| Worker field | `assignedTo` | Frontmatter field naming who worked on a task |
| AI agent names | *(empty)* | Comma-separated, not case-sensitive. Any other name shows as human |
| Report folder | `Sheiko Reports` | One note per day for slot reports |
| Slots (per weekday) | *(blank)* | e.g. `12:30-13:00 break, 14:00-15:30 deep work`. Blank = none. Bad entries are flagged, not guessed |

Statuses and field names are read from TaskNotes' settings rather than hardcoded. TaskNotes' default statuses don't include a review status, so add one in TaskNotes first if you want the sign-off flow.

<p>
  <img src="docs/screenshots/settings-stages.png" alt="Settings: Stages and sign-off, with the working, review and done statuses and the four auto-stage and prompt toggles" width="49%">
  <img src="docs/screenshots/settings-auto-roll.png" alt="Settings: Auto-roll toggle and the per-weekday working-hours table" width="49%">
</p>

![Settings: Who worked on it (worker field, AI agent names) and Breaks and deep work (how slots work, report folder, per-weekday slots)](docs/screenshots/settings-worker-slots.png)

## Requirements

- Obsidian **1.4.4+**, desktop only
- **TaskNotes** installed and enabled (tested on 4.13.4)
- Obsidian's Daily Notes settings (folder and date format) are used for the Rolled Over summary

![Installed plugins: Sheiko Task Lifecycle v0.1.0 alongside TaskNotes 4.13.4 and Tasks](docs/screenshots/installed-plugins.png)

## Compatibility

- **TaskNotes Workflows:** its optional *scheduled-date rollover* workflow and Sheiko's auto-roll both move `scheduled` forward. Use one or the other, not both, or tasks will move twice.

## Known limits

- A task first seen by Sheiko has no earlier history. It's tracked from then on, with nothing backfilled.
- If a close written by an agent or by hand is reopened and then closed again live, the original `closedBy` / `timeToCloseMinutes` are kept, so they can be stale.
- Sheiko waits 600 ms after a change so TaskNotes can finish its own writes. That delay is a timing assumption.
- Tested only against TaskNotes 4.13.4. A change to TaskNotes' frontmatter or settings shape could break Sheiko.
- If a task's only recorded status change is the close itself, the Lifecycle Summary's *Time per status* table has no rows.
- The worker badge is only as accurate as the worker field. A name not in *AI agent names*, including a typo, shows as *Human*.
- "Came due during the slot" counts only `due` values with a time. Date-only dues are left out.

## Support

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs and open pull requests. Best effort. Report issues on [GitHub](https://github.com/Ashura-Sheikh/Sheiko-obsidian-plugin/issues). No response-time guarantee. Tested on TaskNotes 4.13.4.

## Development

- Node.js 20+
- `npm i` to install dependencies
- `npm run dev` to build in watch mode (`src/main.ts` → `main.js`)
- `npm run build` to type-check and run a production build
- `npm run lint` for ESLint with the Obsidian plugin rules
- `npm test` to type-check and run the tests

**Loading it in a dev vault:** symlink the repo into the vault as `<vault>/.obsidian/plugins/sheiko-task-lifecycle → <repo>` (the folder name must match the plugin ID), then enable "Sheiko Task Lifecycle" under Community plugins. To install manually instead, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/sheiko-task-lifecycle/`.

**Naming note:** class names, CSS classes, notices ("Sheiko: …") and the `closureSource: sheiko` value written to task notes deliberately keep the short name "Sheiko". Changing `closureSource` would stop a reopen from clearing closure fields on tasks Sheiko had already closed.

**Source layout (`src/`):** `main.ts` (plugin entry, commands, cutoff timer), `tracker.ts` (status-change detection, closure, startup catch-up), `lifecycle.ts` (history, time buckets, summary), `roll.ts` / `roller.ts` (auto-roll rules and engine), `review.ts` (sign-off card summaries and worker labels), `slots.ts` / `slot-logic.ts` (break and deep-work slots and reports), `tasknotes.ts` (reading TaskNotes' config), `settings.ts`, `ui/` (lifecycle, sign-off and slot windows).

**Tests (`test/`):** 43 tests run the real tracker, auto-roll and slot code against an in-memory vault and a stand-in for the `obsidian` module (`test/obsidian-mock.ts`). They cover the code that edits notes: closure fields, reopen, startup catch-up, dry run, the edit limit, what does and doesn't roll, sign-off summaries, and slot holds and reports. The repo's build workflow (`.github/workflows/lint.yml`) also runs them.

## Licence

[MIT](LICENSE) © 2026 Sheikh M Sahil

## Credits

Built from the [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin) template. API docs: https://docs.obsidian.md
