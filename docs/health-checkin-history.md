# Private Evening Health check-in history

Health & Wellbeing → **Check-in history** opens a history of the signed-in
owner's saved Evening Health & Wellbeing check-ins. It loads only when opened.
Use optional inclusive **From** and **Through** dates, **All dates**, or
**Load older check-ins**. Refresh reloads the currently applied date range.

Each dated check-in opens a read-only view of all eleven questions: planned
meals, vegetables/fiber, protein, water, activity and its notes, hunger, energy,
mood, sleep, biggest win, and obstacle. Missing answers say **Not recorded**;
zero is a recorded value. The list shows how many of the eleven answers were
saved. Multiple saved values for one question remain visible, as do additional
linked metrics. Historical dates use the saved `checkin_date`, not the UTC
date of `logged_at`. Standalone tracker logs remain in Recent entries.

The history reads `health_checkins` with its related `health_entries` and
tracker metadata in one query. Both check-ins and embedded entries have an
explicit owner filter, in addition to existing owner-only row-level security
on all three tables. Inactive or dashboard-hidden tracker metadata remains
available to its owner in history. Cursor pagination uses the unique
`(owner_user_id, checkin_date)` key: request 21 rows, show 20, and use the last
shown date as an exclusive cursor. This is independent of the dashboard's
recent 45-day check-in and 1,000-entry limits.

History stays in owner-bound browser memory and is cleared when leaving the
app or signing out. Responses from an earlier owner or superseded request are
ignored. Load failures remain visible with a retry; a failed older-page request
retains already loaded rows and its cursor. A successful Health edit invalidates
history so the next open/refresh reflects the edit.

No new sharing, browser storage, AI input, database migration, or write endpoint
is added. General AI context and briefs continue to exclude Health. Historical
check-in editing and descriptive trends are separate follow-ups.

## Verification

`python tests/browser-health-history.py` uses synthetic records and no live
Health data or writes. It covers all questions and notes, missing and zero
values, additional/duplicate answers, 76 days of cursor pagination, inclusive
dates, empty states, failed reads and retry, owner filters, foreign-owner
responses, slow account switches, logout clearing, AI context isolation,
keyboard access, and desktop/390px/320px layouts. The embedded REST query was
also validated live using an unauthenticated, zero-row request; existing table
RLS and owner policies were inspected without reading any Health entries.
