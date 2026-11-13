# Health trends and task planning

## Health & Wellbeing → Health trends

Open **Health trends** and choose **Last 7 days** or **Last 30 days**, including
today. The current period is compared with the preceding equally sized period.
Saved `checkin_date` values determine the day, rather than UTC submission times.

The view shows water, sleep, hunger, energy and mood recorded-day averages, plus
activity and nutrition response counts. Each measure has its own recorded-day
denominator. Missing answers are not zero; a saved zero is included. Multiple
answers for the same measure/day are excluded from that measure and flagged for
review in history. Numeric comparisons need at least two recorded days in both
periods and show change without classifying it as good or bad. Choice counts show
the previous period with its recorded-day denominator. Line charts retain gaps
for missing or ambiguous values; **View daily values** provides the underlying
accessible table. These are descriptive records, not medical conclusions or
correlations. Today's values may still be incomplete.

Trends load on demand and read at most 61 owner-filtered check-ins with their
owner-filtered answers. The owner/date unique index bounds the query independently
of the dashboard's recent-entry limits. Stale/account-switch results are ignored,
Health edits invalidate the view, and leaving the app/signing out clears memory
and rendered values. No Health data enters general AI context, briefs, chat
storage, or a new AI service.

## Task estimates

Task create/edit has an optional **Estimated time** in whole minutes, 1–480,
with 15-minute, 30-minute and 1-hour shortcuts. Existing tasks remain unknown
(`NULL`) until the user sets an estimate. Estimates appear in task rows and
Today priorities, persist on save, can be cleared, and carry forward to recurring
successors. Editing an existing private task preserves its visibility/category.

The assistant's existing RLS-scoped task context includes estimates. Unknown
estimates remain unknown. A new AI proposal can include a duration when specified
by the user or when the user asked for an estimate; its valid value fills the
review form and never saves automatically. Health and Google event data remain
excluded from general context.

## Find time for my task

In the task editor, set an estimate and use **Find available times**. Choose a
day within the next 60 days and a local time window (default 08:00–18:00).
Suggestions apply only to tasks assigned to the signed-in user and stop at an
optional task due time. The button explicitly reads fresh selected Google
calendars and visible family events using the current user's existing read-only
connection. A selected calendar is required, and the fresh selected-calendar
count must match the number read before suggestions are shown. The algorithm does not send events
to AI or query another family member's private calendars.

Busy intervals are clipped and merged; transparent/declined Google events do not
block time. All-day dates cover their local days with Google exclusive end dates.
Google reads are padded to account for all-day dates in other calendar timezones,
and family events are fetched across the chosen day so datetime-backed all-day
records are not missed. Suggested starts round up to 15-minute boundaries and
never precede the current time. Up to three alternatives fit the full estimate.
An unclear timed-event end, partial/read failure, excessive event count, missing
selection, or skipped/repeated local time prevents availability claims.

**Use this time** fills only the draft reminder start. The user must review and
save normally. No calendar reservation is made, and task reminders are not
assumed to reserve work time. Changing estimate, assignee, dates, times or due
time invalidates results; closing the editor ignores pending responses.
Suggestions cover the chosen occurrence, not every future recurring occurrence.

## Deployment and verification

1. Apply `20261113034253_task_duration_estimates.sql`: a nullable constrained
   column and the existing recurrence trigger with the added field copied.
   Existing task access policies and trigger privileges remain in place.
2. Deploy `open-brain-assistant` from the merged source with its existing shared
   dependencies. The existing Calendar endpoint requires no change.
3. Publish the static dashboard and service worker (PWA v22).

Tests use synthetic records only; no live Health reads, task edits or messages.

- `npm --prefix tests run test:planning` checks aggregation, zero/missing/duplicate
  values, comparisons, choice counts, date boundaries, interval merging, exact
  fits, all-day events, DST gaps/ambiguity, past times, incomplete events, the
  actual migration/recurrence behavior in PGlite, and assistant context isolation.
- `python tests/browser-trends-duration.py` checks private query bounds, period
  switching, daily tables, empty/error/retry states, owner changes, explicit
  Calendar reads, no writes when choosing a gap, due cutoff, estimate create/
  edit/clear/reopen, private-task preservation, reviewed AI proposals, stale
  responses and desktop/390px/320px layouts.
- Existing complete Health history, dashboard/weekly-plan and Calendar-question
  checks cover the surrounding workflows.
