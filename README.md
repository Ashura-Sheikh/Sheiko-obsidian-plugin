# Sheiko (working name)

An Obsidian plugin that works **alongside [TaskNotes](https://github.com/callumalpass/tasknotes)** to add task-lifecycle tracking and a daily auto-roll for unfinished tasks.

> **Status: in development, desktop only.** Temporary ID `sheiko-dev` / "Sheiko (dev)". The final name and ID haven't been chosen yet. Tested only against TaskNotes **4.13.4** in a dedicated test vault.

## What it does

### 1. Task lifecycle (Phase 1)

- **Context log.** An append-only `## Context` section in each task note, with entries formatted `- **{timestamp} — {who}:** {text}`.
- **Status history.** An append-only `## Status History` section with ISO-timestamped transitions. Clicking the same status again isn't logged.
- **Closure fields.** `completedDate` (full ISO), `closedBy` and `timeToCloseMinutes` are written **only for a close Sheiko saw happen live**. Sheiko never overwrites a close written by hand or by another tool. Closes it recorded are marked `closureSource: sheiko`, and a reopen clears only those.
- **Time per status, in three buckets.** Time is split into working hours, overnight and weekend, written as `timeWorkingMinutes`, `timeOvernightMinutes` and `timeWeekendMinutes`. The three always add up to `timeToCloseMinutes`.
- **Lifecycle Summary.** A `## Lifecycle Summary` section (closure plus time per status), refreshed in place. It's written automatically on a live close, or on demand.
- **Startup catch-up.** Status changes made while Obsidian was closed are logged as "detected at startup", never given an invented time. Time spent in a status that was skipped over is shown as a **gap**, not estimated. Closes Sheiko didn't see happen are listed and flagged, never filled in.

### 2. Auto-stage and sign-off (Phase 2)

- **Auto-stage (forward only).** Starting a TaskNotes timer moves the task to the working status. Ticking the last unticked checkbox moves it to the review status. Moves happen only when something changes, never just because of existing state, and never backwards or out of a completed status.
- **Sign-off prompt.** Opens when a task enters review, and at each day's end time for anything still waiting. Buttons: *Approve and close*, *Send back*, *Open*, *Later*. **Closing a task is always a user click, never automatic.**

### 3. Auto-roll and summary (Phase 3)

- At each day's end time (**weekends included**), unfinished tasks scheduled on or before that day have `scheduled` moved to the next day. A time of day, if present, is kept. **`due` never changes**, so slippage stays visible. `rollCount` goes up by one each time.
- **Not rolled:** completed, scheduled in the future, recurring (TaskNotes uses `scheduled` as the repeat anchor), and archived tasks. Tasks with **no date** are listed as "give these a date".
- **Summary, in two places:** a Context line on each rolled task, and a `## 🔁 Rolled Over` section in that day's daily note (one block per run, never overwritten). In-review tasks are listed first (⭐), and past-due tasks are flagged ⚠️.
- If Obsidian was closed at the cutoff, one **catch-up** roll runs on next open, labelled as a catch-up.

## Commands

- Open task lifecycle (context, closure, time per status). Also opened from the ribbon icon.
- Write lifecycle summary to this task
- Show tasks waiting for sign-off
- Roll unfinished tasks now (scheduled today or earlier → tomorrow)
- List tasks closed while Obsidian was shut

## Settings

| Setting | Default | Notes |
|---|---|---|
| Identity | `sheikh` | Written as `closedBy` and in Context entries |
| Working hours (per weekday) | 09:00–17:00, every day | The end time is also the daily roll cutoff. The same window decides the working / overnight / weekend split. |
| Allowed vaults | *(empty)* | **Nothing is written until the current vault is allowed.** |
| Dry run | off | Logs intended writes instead of making them, including the daily note |
| Max edits per run | 25 | Caps startup catch-up and auto-roll. Tasks held back are listed and picked up on the next run. |
| Working / review / done status | `in-progress` / `in-review` / `done` | Picked from TaskNotes' own status list |
| Auto-stage on timer start / all boxes ticked | on / on | Each can be switched off |
| Sign-off prompt on review / at cutoff | on / on | Each can be switched off |
| Auto-roll | on | |

Statuses and field names are read from TaskNotes' settings rather than hardcoded. The review status (`in-review`) isn't part of TaskNotes' default set, so add it in TaskNotes first if you want the sign-off flow.

## Requirements

- Obsidian **1.4.4+**, desktop only
- **TaskNotes** installed and enabled (tested on 4.13.4)
- Obsidian's Daily Notes settings (folder and date format) are used for the Rolled Over summary

## Known limits

- A task first seen by Sheiko has no earlier history. It's tracked from then on, with nothing backfilled.
- If a close written by an agent or by hand is reopened and then closed again live, the original `closedBy` / `timeToCloseMinutes` are kept, so they can be stale.
- Sheiko waits 600 ms after a change so TaskNotes can finish its own writes. That delay is a timing assumption.
- Tested only against TaskNotes 4.13.4. A change to TaskNotes' frontmatter or settings shape could break Sheiko.

## Development

- Node.js 18+
- `npm i` to install dependencies
- `npm run dev` to build in watch mode (`src/main.ts` → `main.js`)
- `npm run build` to type-check and run a production build
- `npm run lint` for ESLint with the Obsidian plugin rules

**Loading it in a dev vault:** symlink the repo into the vault, e.g. `<vault>/.obsidian/plugins/sheiko-dev → <repo>`, then enable "Sheiko (dev)" under Community plugins. To install manually instead, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/sheiko-dev/`.

**Source layout (`src/`):** `main.ts` (plugin entry, commands, cutoff timer), `tracker.ts` (status-change detection, closure, startup catch-up), `lifecycle.ts` (history, time buckets, summary), `roll.ts` / `roller.ts` (auto-roll rules and engine), `tasknotes.ts` (reading TaskNotes' config), `settings.ts`, `ui/` (lifecycle and sign-off windows).

**Tests:** the unit and scenario tests used during the build (pure logic, plus the real tracker/roll code run against a stand-in Obsidian) aren't in this repo yet.

## Credits

Built from the [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin) template. API docs: https://docs.obsidian.md
