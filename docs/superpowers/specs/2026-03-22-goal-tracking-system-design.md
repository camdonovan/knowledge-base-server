# Goal Tracking & Todo Management System — Design Spec
**Date:** 2026-03-22
**Status:** Approved (post spec review)

---

## Overview

A fully automated goal tracking and todo management system built on Claude Code. Uses a hierarchical goal stack (Rian Doris / Goal Flywheel methodology) organized under 5 Wealth Pillars. Runs automated review loops via Telegram, manages all todos through TickTick, stores structured data in AWS RDS, and saves human-readable notes to Obsidian. All review history is queryable via the KB server (semantic + full-text search).

---

## Architecture: Option C — API Service + Thin Skills

A lightweight Node.js service (`goal-service`, port 3839) owns all data logic. Claude Code skills are thin conversation handlers that call the service API. This pattern matches the existing `kb-server` and prepares the system for a future UI with zero rework.

### Layers

```
Loop Triggers → Claude Skills ↔ Telegram (user)
                     ↕
              goal-service API (port 3839)
                     ↕
     RDS · TickTick · Obsidian · KB Server
```

### Components

| Component | Purpose |
|-----------|---------|
| `goal-service` | Node.js service. Owns RDS connection pool, TickTick aggregation, Obsidian writes, KB queries, context assembly |
| `initial-setup` skill | One-time. Runs in Claude Code terminal. Reviews notes.txt with user, synthesizes values doc, kicks off first yearly + monthly goal setup |
| `nightly-review` skill | Runs at 8:30pm PT. Full 5-step review via Telegram |
| `weekly-review` skill | Runs at 9am Saturday. Extended review + goal flywheel check |
| `monthly-review` skill | Runs last day of month. Monthly close + next month goal setting |
| `yearly-review` skill | Runs Jan 1. Full year retrospective + new yearly goals per pillar |
| `todo-monitor` skill | Runs every 5 minutes. Overdue nudges + new task linking |

---

## Goal Stack

### Tier Structure

```
★  Lifelong Ideals (5 Wealth Pillars)
│
1  Yearly Goals          — anchored to a wealth pillar
│
2  Quarterly Goals       — 90-day milestones, reviewed monthly
│
3  Monthly Goals         — concrete deliverables, reviewed weekly
│
4  Weekly Goals          — what moves the needle, reviewed nightly
│
5  Daily Tasks           — TickTick todos, planned each night
```

### Lifelong Ideals — 5 Wealth Pillars

Each pillar is informed by the user's source frameworks:

| Pillar | Sources | Core Idea |
|--------|---------|-----------|
| **Time Wealth** | Hobby Theory, Rian Doris | Autonomy over time. Scheduled goal blocks + genuine unscheduled recovery. No productivity guilt. |
| **Social Wealth** | The Happiness Lab | Deep relationships are the #1 predictor of happiness. Prioritize connection over achievement. |
| **Physical Wealth** | Notes.txt fitness principles | Consistent training (3x/week compound lifts), zone 2 cardio, sleep, mobility. Sustainable over optimal. |
| **Mental Wealth** | Rian Doris, Flow Research Collective | Purposeful work in flow states. Clear goals. Leverage trifecta (proficiency, process, people). Reduce cognitive load. |
| **Financial Wealth** | Money Scope | Financial independence through index investing, low fees, living below means, automating good behavior. |

### Goal Flywheel (Rian Doris)
- Weekly: "How did last week's actions align with goals? What's the gap? What 3 actions close it?"
- Each tier reviews whether it still serves the tier above
- Max 3 goal-directed actions per week, broken into 3 daily clear goals
- Clear Goal rule: a goal is only clear if you know exactly what to do, how, and when it's done

---

## RDS Schema (PostgreSQL)

### `lifelong_ideals`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| wealth_type | ENUM(time,social,physical,mental,financial) | |
| name | TEXT | |
| description | TEXT | |
| created_at | TIMESTAMPTZ | |

### `goals`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| parent_id | UUID FK → goals.id | NULL for yearly goals |
| ideal_id | UUID FK → lifelong_ideals.id | NULL except yearly goals |
| tier | ENUM(yearly,quarterly,monthly,weekly,daily) | |
| title | TEXT NOT NULL | |
| description | TEXT | |
| status | ENUM(active,completed,abandoned,paused) | |
| target_date | DATE | |
| completed_date | DATE | |
| metadata | JSONB | Flexible future fields |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

Self-referential hierarchy: weekly → monthly → quarterly → yearly → lifelong_ideal.

### `goal_progress`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| goal_id | UUID FK → goals | |
| review_id | UUID FK → reviews | NULL if recorded outside a formal review |
| pct_complete | INT (0–100) | |
| progress_note | TEXT | |
| created_at | TIMESTAMPTZ | |

### `reviews`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| type | ENUM(daily,weekly,monthly,yearly) | No quarterly review loop exists by design — quarterly goals are reviewed as part of monthly reviews |
| review_date | DATE NOT NULL | |
| obsidian_path | TEXT | Path to the Obsidian note |
| summary | TEXT | |
| wins | TEXT[] | |
| challenges | TEXT[] | |
| created_at | TIMESTAMPTZ | |

### `todo_snapshots`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| ticktick_id | TEXT NOT NULL | TickTick task ID |
| goal_id | UUID FK → goals | NULL if unlinked |
| title | TEXT | |
| completed | BOOL | |
| due_date | TIMESTAMPTZ | |
| snapshotted_at | TIMESTAMPTZ | |
| first_nudge_sent_at | TIMESTAMPTZ | Set when initial overdue nudge is sent; prevents re-firing on every 5-min poll |
| overdue_follow_up_at | TIMESTAMPTZ | Set by monitor after "still on it" response; drives subsequent nudge timing |
| push_count | INT DEFAULT 0 | Incremented on each "push back" response; triggers blunt escalation at ≥ 3 |

### `journal_entries`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| review_id | UUID FK → reviews | |
| entry_date | DATE NOT NULL | |
| free_time_activities | TEXT | |
| content | TEXT | |
| mood_rating | INT (1–10) | |
| energy_rating | INT (1–10) | |
| created_at | TIMESTAMPTZ | |

---

## Initial Setup (One-Time, Runs in Claude Code Terminal)

1. **Theme extraction** — Claude reads `/home/cdonovan/notes.txt` and groups content into themes: flow philosophy, physical health, scheduling principles, financial ideals, habits, mindset
2. **Interactive review** — Claude presents each theme in the terminal. User accepts, rejects, or modifies. Anything unclear gets a follow-up question. Nothing is adopted without explicit approval
3. **Synthesis** — Approved content written to `~/obsidian-vault/meta/values-and-principles.md` and ingested into KB with tag `core-context`
4. **First goal setup** — Immediately runs first yearly + monthly goal-setting session in the terminal using the values doc as context. Sets current year's yearly goals (one+ per wealth pillar) and current month goals. Cascades into RDS

The values & principles doc is the persistent context pulled at the start of every review going forward via `kb_search("core-context")`.

---

## Review Flows

### Nightly Review — 8:30pm PT daily

| Step | What happens |
|------|-------------|
| 1. Data sync | Silent. goal-service pulls TickTick tasks for today, RDS goal stack, last 7 days of reviews from KB, mood/energy trend |
| 2. Status updates | Telegram. For each task due today or overdue (not all open tasks): "Done, still on it, or push back?" Updates TickTick + todo_snapshots |
| 3. Journal | Telegram. Free time activities, mood (1–10), energy (1–10), anything else worth noting. Saved to journal_entries |
| 4. Briefing | Telegram. Claude's proactive analysis: goal alignment, drift flags, wins, blunt observations, proposed tomorrow plan with top 3 goal-directed tasks |
| 5. Approve + lock in | Telegram hybrid discussion. User pushes back → Claude adjusts → approval → goal-service creates TickTick tasks + writes Obsidian daily note + saves review to RDS + ingests to KB |

### Weekly Review — 9am Saturday
- Summarizes last 7 daily notes
- Weekly goal hit rate
- Good/great things + challenges + what to change
- Look ahead 2 weeks
- Set top 3 outcomes for next week
- Goal flywheel check: does weekly → monthly still align?
- Saves weekly review note to Obsidian + RDS + ingests to KB

### Monthly Review — Last day of month
- Summarizes all weekly reviews
- Monthly goal completed/missed
- Progress on quarterly goals
- Mood/energy trend analysis
- Patterns Claude noticed across the month
- Set next month's goals
- Goal flywheel check: monthly → quarterly alignment
- Saves monthly review note to Obsidian + RDS + ingests to KB

### Yearly Review — January 1st
- Full year retrospective by wealth pillar
- Pulls values & principles doc from KB for alignment check (does NOT re-run notes.txt review — that is initial setup only)
- Sets new yearly goals per pillar
- Cascades: yearly → quarterly → monthly
- Updates lifelong_ideals in RDS if values have shifted
- Bezos flywheel check: do goals compound and fuel each other?
- Full goal stack saved to Obsidian + RDS + ingests to KB

---

## Todo Monitor — Every 5 Minutes

**New tasks:** Any TickTick task not in todo_snapshots triggers a Telegram message: "I see you added X — which goal does this support?" If no response in 30 minutes, filed as unlinked and flagged at nightly review.

**Overdue tasks:** Task past due → 5-minute wait → Telegram nudge with three options:
- **Done** → mark complete in TickTick + todo_snapshots
- **Still on it** → Claude estimates appropriate follow-up window based on task type, sets `overdue_follow_up_at`
- **Push back** → "When to?" → updates due date in TickTick + RDS

**Blunt escalation:** Same task pushed 3+ times triggers a nightly review flag: *"You've pushed X N times. Either it's not a priority, the scope is wrong, or something is blocking you. Let's fix that tonight."*

---

## Proactivity Stance

Claude is **extremely proactive and blunt** but **never makes changes without approval**. This means:
- Surfacing goal drift without being asked
- Flagging patterns (repeated pushes, low mood correlating with skipped workouts, etc.)
- Proposing reschedules and reprioritization
- Calling out when stated values and actual behavior don't match
- All proposals require explicit user approval before any change is made to TickTick, RDS, or Obsidian

---

## Obsidian Structure

```
~/obsidian-vault/
├── meta/
│   └── values-and-principles.md       ← synthesized from notes.txt, core KB context
├── reviews/
│   ├── daily/
│   │   └── YYYY-MM-DD.md
│   ├── weekly/
│   │   └── YYYY-WXX.md
│   ├── monthly/
│   │   └── YYYY-MM.md
│   └── yearly/
│       └── YYYY.md
```

### Daily Note Format
```markdown
---
review_id: "uuid"
date: 2026-03-22
mood: 7
energy: 8
goal_ids: ["uuid-yearly", "uuid-monthly", "uuid-weekly"]
---

## Day Summary
[2–3 sentence synthesis]

## Tasks Completed
- [task] (ticktick_id: xxx, goal_id: uuid)

## Tasks Pushed
- [task] → new due: YYYY-MM-DD (reason: ...)

## Free Time
[Journal entry]

## Tomorrow's Plan
1. [goal-directed task] (goal_id: uuid)
2. [goal-directed task] (goal_id: uuid)
3. [goal-directed task] (goal_id: uuid)

## Claude's Flags
- [blunt observations]
```

---

## Loop Triggers (CronCreate)

| Loop | Schedule | Skill |
|------|----------|-------|
| Nightly review | `30 20 * * *` (America/Los_Angeles) | `nightly-review` |
| Weekly review | `0 9 * * 6` (America/Los_Angeles) | `weekly-review` |
| Monthly review | `0 9 28-31 * *` (America/Los_Angeles) | `monthly-review` |
| Yearly review | `0 10 1 1 *` (America/Los_Angeles) | `yearly-review` |
| Todo monitor | `*/5 * * * *` | `todo-monitor` |

**Cron implementation notes:**
- The `L` (last day of month) modifier is not supported in standard POSIX cron. The monthly review cron fires on days 28–31; the `monthly-review` skill checks at runtime whether today is actually the last day of the month and exits early if not. This handles all month lengths correctly.
- The yearly review fires at **10am PT** (not 9am) to avoid collision with the weekly review cron on years when Jan 1 falls on a Saturday. If both fire, the weekly runs first at 9am and the yearly at 10am, each independently.
- All times are America/Los_Angeles (Pacific Time, DST-aware).

---

## Future UI

The `goal-service` REST API is designed as the backend for a future goal stack UI. Every goal query, progress fetch, and review summary is exposed as an endpoint from day one — the UI layer is additive, requires no schema changes, and the structured Obsidian notes (with embedded IDs) allow cross-referencing between the visual UI and the written record.

---

## Key Design Principles (from values & principles doc)

- **Time blocking:** Dedicated goal time is ring-fenced. What happens outside of it is free. No productivity guilt.
- **Clear goals only:** A task only goes on the plan if it meets the Clear Goal rule (what, how, when done)
- **Consistent over optimal:** 2-day rule, habit stacking, boring but reliable systems beat complex ones
- **Inputs over outputs:** Track leading indicators (deep work hours, sleep, flow duration), not just results
- **Bezos flywheel:** Goals should compound and fuel each other across wealth pillars
