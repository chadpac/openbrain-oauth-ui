# Reminder reliability review

This continues the existing task, event, habit, and private Health reminder
implementation. It does not introduce Google Calendar writes or add Health data
to the general assistant context.

## Baseline observations

The four cron jobs were enabled every minute, and their observed HTTP requests
returned 200. Cron's own successful status means the request was queued; it does
not prove that a phone displayed the notification. Two push subscriptions were
enabled at review time. No live household reminders or health entries were
changed during this review and no test messages were sent.

The original workers accepted unauthenticated calls. Tasks could be sent by two
overlapping invocations. Event notifications marked failed were never selected
again; failed habit log rows permanently blocked another attempt that day. Habit
and Health reminders had only a ten-minute eligibility window. Push Done/Snooze
read the token and changed the task before consuming the token, allowing races;
Snooze also accepted completed, paused, or cancelled tasks.

The recurrence SQL preserved local time across daylight-saving transitions, but
an unrecognized weekday silently produced a seven-day interval.

## Changes

- Cron gets an Authorization bearer token from Supabase Vault. A server-only RPC
  compares it against the Vault value; unauthenticated workers reject requests
  before reading reminder records. No new Edge Function environment secrets are
  required, and the credential value is not checked into the repository.
- A service-only delivery table leases each occurrence for five minutes. The key
  includes the task/event recipient and scheduled time, or the habit/Health local
  date. Overlapping calls cannot both claim the same occurrence. A crashed
  worker's lease can expire and be reclaimed.
- Failed attempts retry after 1, 2, 4, then 8 minutes, with five total attempts.
  Completed delivery claims repair application delivery markers if saving those
  markers previously failed. A worker that lost its lease cannot overwrite the
  replacement worker's result.
- Exhausted task/event deliveries get a retry-limit error and no longer occupy
  the front of the next batch. Reschedule the reminder to create a fresh
  occurrence. Habits and Health use a fresh occurrence the next local day.
- Habit and Health eligibility now lasts from the scheduled local time through
  the end of that day, so a delayed cron run can catch up. Completed habits or
  check-ins still suppress the reminder. Midnight is represented as 00:00,
  avoiding the locale-dependent 24:00 interpretation.
- Push actions run in one database transaction. They lock the resource before
  the token, validate current membership/assignment/status/expiry, and consume
  the token with the update. Task Done/Snooze invalidates sibling tokens so
  buttons from another device cannot act on the old notification.
- Telegram task updates condition on assignment, active status, and the reminder
  time read before the update. Raw webhook payloads are no longer logged.
- The shared push sender respects per-device task/event/habit/Health preferences
  and the test-device endpoint filter. Only 404/410 endpoints are removed. Push
  and Telegram sends have a ten-second network timeout.
- The recurrence helper rejects invalid weekday sets and oversized/zero
  intervals while retaining the existing valid rules and DST behavior.

## Delivery semantics and limits

A reminder is considered sent when at least one configured channel accepts it,
matching the existing behavior. Failures from another channel/device are retained
as an error, but successful channels are not deliberately resent to retry a
failed device. Provider acceptance does not prove device display; OS/browser
permissions, connectivity, and notification settings still affect display.

External providers and database commits cannot form one transaction. A crash or
network ambiguity after provider acceptance but before recording success can
still cause a later duplicate. The leases prevent ordinary overlapping sends;
they do not promise exactly-once external delivery.

The existing recurrence trigger creates the next occurrence from the prior
scheduled time when a task transitions into completed. This review preserves
that cadence, including overdue tasks, rather than skipping occurrences.

## Tests

```sh
npm --prefix tests ci
npm --prefix tests run test:reminders
node --test tests/google-calendar.test.cjs
```

Use Node 24+. Reminder tests run the actual migration and recurrence trigger in
PGlite (Postgres), with minimal Supabase/Vault/cron fixtures. Worker transports
are mocked; no Google, Telegram, or push requests are sent. The Vault crypto
fixtures test the authentication contract, not production cryptography.

## Coordinated production deployment

1. Capture the current function versions/source for rollback and confirm the
   current four job names still match the migration.
2. Apply `20261109232415_reminder_delivery_reliability.sql` first. This creates the
   Vault credential, restricted delivery state/RPCs, atomic push-action RPC, and
   recurrence validation, then adds the credential to the existing cron job
   commands. The old workers ignore the additional header, so they continue
   working while the new versions deploy. Existing job IDs/schedules remain.
3. Deploy all seven versioned functions: send-telegram-reminders,
   send-event-notifications, send-habit-reminders, send-health-checkin-reminders,
   push-notification-action, telegram-reminder-actions, and web-push. Include
   `supabase/functions/_shared/` dependencies in deployment bundles. Retain the
   checked-in gateway JWT settings. Do not rotate the existing VAPID key.
4. Verify a POST without credentials returns 401 and GET returns 405 for each
   scheduled worker. Submit an authenticated `{"dry_run":true}` using a pg_net
   call whose Authorization header reads from Vault. It should return
   `{"ok":true,"dry_run":true}` without querying recipients or sending anything.
5. Check subsequent scheduled HTTP status codes and delivery aggregates. Run
   Supabase security advisors and confirm anonymous/authenticated roles still
   lack access to the new delivery table and RPCs.
6. With the user's participation, use the existing Test this device button,
   then test a reminder assigned to that user, Snooze, Done, and the next
   recurring occurrence. Confirm the private Health check-in still goes only
   to its owner on a Health-enabled device.

For rollback, restore the previous workers/actions first. The added cron header
can remain because previous workers ignore it. Keep the Vault secret and ledger
until rollback has been verified; do not delete tokens or existing app records.
Revert the recurrence helper separately if necessary. No frontend or PWA update
is needed for this backend change.
