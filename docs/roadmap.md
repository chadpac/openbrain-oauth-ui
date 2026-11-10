# Open Brain priorities

This records the priorities agreed with the household owner. Each feature should
extend the existing app, preserve its privacy boundaries, and be reviewable
before publication.

## Completed

- Google Calendar phase one: read-only OAuth, encrypted server-side refresh
  token, calendar selection, Today/This Week/Upcoming display, refresh and revoke.
  Google Cloud publishing status was moved to Production and the user reconnected.
- Reminder reliability: authenticated scheduling, overlap protection, retry
  recovery, safer notification actions, recurrence validation, and private Health
  delivery. The user confirmed real-device push delivery, Done, and creation of
  the next daily occurrence. Snooze has automated coverage; manual device testing
  remains optional.
- Notification message placement above the Ask Open Brain launcher.

## Near-term sequence

1. Read-only questions about the signed-in user's Google Calendar: schedule and
   availability checks with explicit per-question control. This change implements
   that milestone; no Google event writes or private family availability sharing.
2. Notification quiet hours with clear per-user/device interruption choices.
3. Complete Evening Health & Wellbeing check-in history, then descriptive trends.
4. Task duration estimates and suggested time slots, reviewed by the user.
5. A focused read/search-only Gmail pilot, such as school deadlines or follow-ups.
6. A Connections & delivery status view showing last successful refresh,
   connections needing attention, notification device state, and exhausted retries.

## Later ideas to retain

- Calendar writes with additional permissions and review before every change.
- Explicitly shared family free/busy availability, with event details private by
  default; refine household, parents-only, and personal permissions first.
- Email/calendar links, proposed follow-up tasks, and reviewed reply drafts.
- Drive document search and links to tasks/events/memories.
- Goal milestones, check-ins, and links to tasks, habits, and weekly plans.
- Household chores, meal planning, maintenance, and more useful member dashboards.
- Optional task import/sync only when needed; keep one primary task system and
  plan duplicate/conflict handling first.
- Business integrations separated from household/private records.
- Synology/NAS search, historical personal timeline imports, local processing,
  optional location-aware errands, and reviewed browser actions.
- Home Assistant, person/project pages, and dedicated mobile experiences after
  the core workflows are reliable and used regularly.

Health stays private to the signed-in user and excluded from general AI context.
Any future Health AI opt-in must be separate and explicit. Health summaries should
be descriptive and avoid treating correlations as medical conclusions. Integrations
and AI context should have visible scope and permissions, with no automatic
purchase, submission, email sending, or other consequential action.
