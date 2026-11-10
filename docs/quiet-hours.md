# Personal notification quiet hours

## Behavior

Settings / Family → **Your quiet hours** lets the signed-in user enable quiet
hours, choose start/end times, and select an IANA timezone. Quiet hours default
to **off**. The suggested 22:00–08:00 times do not take effect until the user
explicitly enables and saves them. Changes apply to that user's scheduled push
and Telegram reminders across devices, with their existing device/category
preferences still respected. Administrators cannot edit another user's quiet
hours through this feature.

The start is inclusive and the end exclusive. Both daytime and overnight
windows work. Equal enabled bounds, 24:00, second precision, and invalid timezones
are rejected. Local wall-clock times follow the selected timezone, including
DST changes. Reminder scheduling and daily-occurrence dates continue using the
household timezone; quiet hours can use a separate chosen timezone.

Tasks wait without being marked sent. If a task is completed, cancelled, paused,
or rescheduled while held, the next run re-evaluates it normally. A quiet user's
records are excluded before batch limits, so their backlog does not prevent
other household members' reminders from running.

Past event alerts are not replayed. Timed events expire five minutes after their
start (or their earlier valid end); the grace allows once-per-minute at-time
alerts to arrive. All-day events remain relevant through a valid supplied end or,
without an end, through their household-local start day. Delayed alerts use
"Upcoming event"/"All-day event reminder" instead of an outdated relative claim
such as "Starts in 1 day". Expired alerts become cancelled with a reason; no
Google Calendar events are changed.

Daily habits and private Health check-ins expire at household-local midnight.
If held past midnight, yesterday's occurrence is not sent the next morning.
Eligible current-day habits can still send after quiet hours end. This preserves
the current-day Health check-in flow without opening an old check-in by mistake.
The notification body stays generic, and the Health owner/category controls
remain enforced. Health data is not added to AI context.

Manual notification tests, including setup tests, send immediately. They are
explicit user actions, not scheduled reminders. The UI explains the test-button
exception. This first version has one account-wide quiet schedule; separate
per-device quiet-hour overrides and category exceptions can be added later.

## Data and authorization

The new `notification_preferences` table has a primary key/foreign key on
`owner_user_id`. Browser clients can SELECT, INSERT, and UPDATE only their own row
under RLS. UPDATE has both USING and WITH CHECK. Anonymous access and browser
DELETE are not granted. The validation trigger is SECURITY INVOKER with an empty
search path; it validates the timezone against pg_timezone_names and maintains
updated_at. No user_metadata authorization is used.

No preference row means quiet hours off. The browser loads preferences separately
from the main dashboard; load errors disable the form rather than silently
replacing settings with defaults. Save errors leave previous stored preferences
in effect and preserve editable inputs. The form shows unsaved changes until a
successful save.

Scheduled workers load enabled preferences using the existing server client. A
lookup outage holds delivery with HTTP 503 rather than ignoring a user's possible
quiet period. A malformed individual preference holds only that owner safely.
Preferences are captured once per invocation, so changes normally apply by the
next minute's scheduled run. Current local time is checked before each recipient,
Telegram send, push device, and push network dispatch.

Users already in quiet hours are filtered before claiming a delivery, leaving
retry attempts untouched. A dispatch already in progress at the boundary may
consume its ordinary attempt; later channels/devices are held. A successful
channel is not deliberately resent after quiet hours solely to retry a held
second device, matching the existing at-least-one-channel delivery semantics.
A push already accepted by its provider can still appear later because the OS
and provider control final device display. Quiet hours cannot retract it.

## Deployment

1. Apply `20261110005550_notification_quiet_hours.sql` first. It creates the
   owner-protected preferences table, validation, and policies. It does not create
   any user preference rows, change reminder times, or turn quiet hours on.
2. Deploy the four scheduled reminder functions with `_shared/quiet-hours.ts`,
   `_shared/push.ts`, and `_shared/reminder-delivery.ts` dependencies. Keep their
   current scheduler authentication and gateway JWT settings.
3. If deploying the shared push sender for web-push, retain the existing manual
   test behavior: it passes no quiet-hours gate and requires user authentication.
   The old manual-test helper is also compatible with the new scheduled workers.
4. Publish the dashboard, privacy clarification, and PWA v19 through normal
   hosting. A new browser with an old/missing table fails safely with a retry-load
   message and cannot overwrite preferences it could not load.
5. Verify table permissions and policies, run security advisors, test authenticated
   no-send worker checks, and monitor ordinary scheduled requests. No new Edge
   Function secrets or Google OAuth permissions are needed.

For live acceptance, the user can enable a short temporary quiet window, schedule
a reminder assigned to themselves inside it, confirm no scheduled message arrives
during the window, and confirm one delivery after it ends. Also test a task
completed while held and restore the desired schedule afterward. The test button
should still work during the quiet window.

For rollback, restore previous worker versions first. The additional preferences
table can remain safely with RLS; do not drop user settings or delivery records.
The previous frontend does not expose the new form. Retain the original VAPID key.

## Verification

```sh
npm --prefix tests ci
npm --prefix tests run test:reminders
python tests/browser-quiet-hours.py
python tests/browser-calendar.py
python tests/browser-calendar-questions.py
```

Database tests use the actual migration in PGlite with synthetic auth roles and
users. Worker tests use mocked transports and do not send any messages. Coverage
includes own-row RLS, default off, time/timezone validation, overnight/daytime
boundaries, DST, outage behavior, recipient isolation, task resumption, completed
and expired reminders, daily expiry, and quiet-hour transitions during dispatch.
Browser checks cover enable/disable, saved state, validation, safe load/save
failures, and desktop/phone layouts. Node 24+ and Python Playwright Chromium are
used. Set QUIET_SCREENSHOT_DIR to capture local review screenshots.
