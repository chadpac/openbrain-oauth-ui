# Private background routines

Open **Background routines** in the sidebar or mobile More menu. Create either
**Daily deadline review** or **Watch deadline changes**. Nothing is preconfigured
or enabled by deployment. Background execution and each alert channel have explicit
checkboxes; a routine can be saved paused. No new Google permissions are needed.

## Scope and useful results

Both templates inspect only pending/in-progress Open Brain tasks assigned to the
owner and visible under the current task policy: the same household, household
visibility or private visibility created by that owner. Membership is rechecked
when queuing, checking and authorizing delivery. A private task created by someone
else is excluded even if assigned to the owner. The server scan intentionally
mirrors that policy rather than using a service-role general assistant context.
Future task-policy changes must update this scoped scan and its RLS comparison test.

The source projection is ID, title (bounded to 180 characters) and due time.
Descriptions, email, Google Calendar, Health records, general memories and AI
providers are not queried. Existing email-derived tasks are ordinary tasks here;
their descriptions/source details are not read. Routines do not change any tasks,
events or other app records.

The window includes deadlines from the past 30 days through the next 1, 3 or 7
elapsed days. Tasks without due_at are outside this check, even if remind_at is
set. A scan over 200 tasks fails visibly instead of publishing a partial all-clear.
The result is a dated snapshot, not live synchronization or a scheduling guarantee.

- Daily review runs at the chosen household-local time. Empty results remain in
  history without an external alert. Configured local timezone is saved with the
  routine; editing adopts the current household timezone. PostgreSQL timezone
  rules preserve the daily schedule across DST; a skipped time shifts to a valid
  local time and a repeated time produces one scheduled occurrence.
- Watches establish a silent baseline, then compare IDs, deadline times and
  overdue/upcoming buckets. New deadlines, changed dates, newly overdue items and
  items leaving the window/visible assignment can alert. Title-only edits do not
  trigger a change alert. Removed items can be completed, reassigned, hidden or
  outside the window; no unsupported explanation is inferred.
- Watches sweep hourly. Task inserts/deletes and deadline/status/assignment/access
  changes also debounce an earlier check, at least one minute from the change and
  fifteen minutes from the last check start. Wake-ups are best effort; the hourly
  sweep recovers missed wake-ups. It does not promise instant notifications.
- **Queue check now** queues server work without keeping the browser open. Manual
  starts have a five-minute cooldown, share the same quotas, and do not create a
  second active job. The scheduler normally wakes once per minute.

## Durable work and controls

Configurations have versions. Saving, pausing or resuming invalidates older active
jobs and pending alerts; resume establishes a fresh baseline to avoid a backlog of
old change alerts. A two-minute lease prevents ordinary overlapping checks. A
crashed check can be reclaimed, with a new lease that an old worker cannot finish.
Retries back off after one then two minutes, with three total attempts. Atomic
SQL checks persist their result before any external notification begins; subsequent
workers resume the saved notification stage.

History shows queued/checking/completed/failed/cancelled runs, attempt counts,
result snapshots and delivery states. It is private to its owner still in that
household, including from other admins. Browser mutation grants and direct queue
RPC access are denied. Signing out clears forms/results and rejects late responses.
History pages use keyset pagination. Completed/failed/cancelled history is removed
after 30 days; settings/baseline remain until routine deletion, and usage counts
remain for 35 days. Account deletion cascades these records.

Delete removes that routine and its run history. Usage counts deliberately remain
to prevent deleting/recreating routines from bypassing daily limits. Pausing or
deleting cannot recall a notification already dispatched to a provider.

## Delivery and privacy

In-app history is always available for completed results. Phone/browser and
Telegram channels are optional, off by default, and send only generic text that a
private check is ready. No task title, deadline, count or source description is
sent in these alerts. The link opens the signed-in Background routines panel.
Phones/browsers must already be enabled with task notifications on; Telegram must
already be connected and enabled. At most ten enabled devices are considered per
batch. A push acceptance means at least one considered device's provider accepted
the request; partial device failures are not blindly retried. OS display is not
guaranteed. A shared push tag replaces older notifications for the same routine.

Database authorization rechecks enabled/version, membership, lease, quiet hours,
reservation day and expiry before each transport and again before each push
request. Quiet hours defer unstarted channels; invalid quiet-hour settings fail
closed. New results supersede older deferred alerts, and alerts expire after 24
hours. A durable channel stamp is written before dispatch. After a crash, a stamped
channel is marked unknown instead of automatically resending it; remaining
unstarted channels can resume. Provider receipt writes require the same lease.
Failed/uncertain deliveries stay visible alongside the result. A transient failure
can therefore cause a missed alert, but the private in-app result remains.

External sends and database commits cannot form one transaction. These controls
prevent routine overlapping/replayed sends; they do not promise exactly-once
delivery, device display, or recall of an in-flight request.

## Work and usage limits

- Two fixed templates per account, one configuration of each kind.
- At most 30 check attempts per UTC day per account, including failed retries and
  manual checks. Budget-held checks wait for the next UTC day.
- At most four alert-batch authorizations per UTC day, shared across templates.
  Each batch may use the selected Telegram channel and up to ten considered
  devices. An unused reservation is not refunded; a deferred batch crossing UTC
  midnight needs a new reservation before another dispatch.
- Each scan reads at most 201 candidate rows to enforce the 200-task limit.
- Each worker invocation queues at most twenty due routines, checks at most five
  jobs, and starts at most five alert batches, with a short wall-clock budget.
- Zero AI calls/tokens. These are application work limits, not a hosting-bill cap.

The dashboard shows today's UTC checks/alerts and fixed limits. The cron command
avoids invoking the worker when no eligible routine or retention cleanup needs it.
No browser timer is needed for background execution; browser polling only refreshes
the visible private status panel.

## Security and rollout

`open-brain-routines` validates the bearer via auth.getUser and binds all controls
to that owner and household. `run-background-routines` accepts only the existing
Vault scheduler credential through authorize_open_brain_scheduler. Both retain
verify_jwt=false for their explicit authentication path. Public mutation/worker
functions are SECURITY INVOKER, service-only, with an empty search_path.

The sole new definer is private.wake_deadline_routines(), a non-exposed trigger
needed to let ordinary task writes wake opted-in assignee queues without granting
browser queue mutation. It has an explicit auth.uid()/membership check, empty
search_path, no public execution and no source-content reads. Errors do not break
saving a task; hourly checks remain. Source queries have a bounded deadline index.

1. Apply `20261115060351_private_background_routines.sql`. It creates the new cron
   job disabled and leaves all four existing reminder jobs untouched.
2. Deploy both new functions with deno.json/lockfiles and the shared routine helper.
   The worker also bundles reminder-delivery.ts and push.ts. The shared push helper
   now supports asynchronous final delivery gates and an optional device limit;
   old synchronous callers remain compatible and are covered by regressions.
3. Verify anonymous/malformed worker calls fail and a Vault-authenticated
   `{"dry_run":true}` returns success without querying sources or sending alerts.
   Verify hosted table grants, RLS, invoker/definer boundaries and advisors.
4. Enable only the new run-background-routines cron job, then publish
   dashboard/About/privacy/service worker v30. Confirm hosted source and checks.
5. The user explicitly creates/starts a routine and optionally selects delivery
   channels. Test Queue check now, close/reopen, inspect the saved result, and
   pause/resume. No live user routine or notification is created during deployment.

Automated tests run the actual migration/RPCs/triggers/RLS in PGlite and mocked
transports plus headless browser controls at desktop/mobile sizes. Existing reminder,
quiet-hours, Health, Gmail and Calendar flows have regression coverage. New
entrypoints type-check with pinned dependencies. A broader check reproduces existing
Supabase generic-type depth errors in the unchanged task/habit reminder workers;
the unchanged baseline was checked separately, and those functions are not redeployed.
