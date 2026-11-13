# Assistant activity and approvals

Activity & approvals is available in the desktop sidebar, mobile More menu and
assistant panel. It is private to the signed-in account, including when another
household member is an administrator. New questions, Today/weekly briefs and
explicit Calendar questions create queued/running entries. Successful read-only
requests complete; proposed changes wait for review. Failed or interrupted
requests offer Ask again rather than automatically repeating a request.

The list has status filters and 20-record pages ordered by created_at plus id.
Refresh checks the latest state; visible activity refreshes every 12 seconds.
Unfinished generation older than five minutes is marked failed when next read.
This release does not add a queue worker or background routines.

## Exact approval scope

Each immutable server proposal shows its destination, visibility, content and
applicable assignee, dates, quantities, notes, recurrence and estimate. Missing
dates, ambiguous/inaccessible lists and invalid assignees require a new request.
Approve & save approves one displayed proposal; Dismiss saves no domain record.
There is no blanket approval or automatic downstream action.

- Reminders create one Open Brain task. The existing reminder scheduler handles
  its delivery and quiet hours; a reminder is not a calendar reservation.
- Family events create one shared Open Brain event. They do not write to Google
  Calendar or create event notifications.
- List proposals add the displayed items, quantities and notes to the exact
  named list. Existing items, including duplicates, remain; the card says so.
- Memories store the displayed text/type/topics/visibility and a search embedding.
  Embedding preparation uses the existing provider only after approval. No hidden
  metadata-extraction model request is added.

The browser submits only activity ID, proposal index and version. It cannot
replace an approved payload. A SECURITY INVOKER RPC rechecks membership, assignee,
destination name/visibility/access, current assistant context and expiry, and
saves through the caller's existing domain RLS. All items and their receipt commit
in one transaction. A repeated decision returns the same receipt, including after
the parent activity completes; concurrent approval and control operations use the
same transaction advisory lock. A failed insert rolls back its entire batch.
Delivery is never repeated by retrying the approval request.

Receipts are owner-scoped retry records, not a source of authorization. The
authenticated role may insert its own receipt only for its own waiting activity,
but cannot update/delete receipts or write lifecycle/proposal rows. Every domain
write still goes through its existing RLS. Activity lifecycle RPCs are service-only
and explicitly match the authenticated owner supplied by the Edge Function.

Pending proposals expire 30 minutes after request creation. Context changes
invalidate pending approvals. Saving a memory changes the assistant context, so
remaining proposals from that old context require a fresh request. Destination
changes also require a new proposal rather than silently redirecting a save.
Revised chat proposals cancel the older activity's pending proposals when the
replacement is confirmed; previously completed saves are retained.

## Pause, cancel and uncertain results

Pause and Cancel pending work prevent later proposals/saves for that activity.
A model request already sent may finish at the provider and may incur usage.
Its late response cannot overwrite paused/cancelled state. Pending approvals can
be resumed within their expiry; generation paused before a result must be asked
again. Cancelling does not undo existing confirmed records or reminder deliveries.

The UI disables decisions while a save is in flight and reports success only on
a returned receipt. If a receipt committed but activity summary synchronization
failed, the save remains successful; the next list read reconciles the summary.
If a network error prevents confirmation, refresh Activity before retrying.
Duplicate decisions remain idempotent. Other screen refresh failures do not turn
a confirmed save into a failed save. Account changes discard late UI responses.

## Sources, connections and delivery

The model may cite task/event/goal/list/memory IDs from its caller-RLS context.
The server discards references absent from that context. These are model-selected
citations, not an independent factual verification or exhaustive provenance list.
Opening a source performs a fresh read with the current account's RLS. Removed or
inaccessible records show an unavailable message. Source content is escaped, and
no source can redirect to arbitrary model-supplied URLs.

The sidebar shows read-only Calendar connection status and its last check. Event
refresh time is shown only if that browser session actually refreshed events.
Devices show registered enabled settings and last update; registration does not
guarantee current browser permission or delivery. Task failures are limited to
tasks created by the caller, and event failures to the caller's notifications.
Exact server delivery keys are built from those caller-visible records before
reading attempt counts and next eligible retry times. No push endpoints, keys,
raw provider errors, Health records or Health-delivery details are returned.
There is no force-resend button; retry limits and quiet hours remain in effect.

## Privacy and retention

Activity stores request kind, state/times, proposal drafts, model-selected source
IDs and decision/result IDs. It does not store raw questions, model answers,
fetched Calendar events or Calendar answers. It is never read into general model
context. Old proposals/source links are hidden and cannot be approved after the
assistant settings or visible-memory context changes. This is not deletion of
history: proposal copies remain in the private activity table, and independent
saved tasks/events/list items/memories stay in their own screens. Deleting a saved
memory does not erase an independently retained proposal. Account deletion
cascades activity/receipts. Full history export/deletion controls remain a later
roadmap item. Health remains excluded from general assistant context and activity
operational queries. Information explicitly typed by a user may appear in their
own proposed memory or other proposed record.

## Deployment and validation

Backend first; no production changes are applied by this pull request.

1. Verify the assistant-preferences migration/backend from the preceding release
   is present; this migration depends on its context-version RPC.
2. Apply `20261113162753_assistant_activity_approvals.sql`.
3. Deploy `open-brain-activity` with its deno.json and shared
   `_shared/assistant-activity.ts`. Keep verify_jwt=true.
4. Deploy `open-brain-assistant` with its existing helpers and the shared activity
   helper, retaining verify_jwt=true. It still accepts older untracked clients.
5. Publish dashboard/privacy/service-worker v26 only after both backends work.
   The new frontend fails closed if activity creation is unavailable.
6. Smoke-check read-only questions, a synthetic scoped approval, duplicate replay,
   a paused request, source denial, and a second account before enabling broader
   use. Do not use private Health records or send real test notifications.

Local automated coverage uses PGlite RLS/transactions and mocked provider responses;
browser coverage uses synthetic accounts at 320/390/1280px. Live provider delivery
and the hosted migration/Edge runtime still need post-deployment verification.

```sh
NODE_PATH=/path/to/pglite/node_modules node --test tests/*.test.cjs
python tests/browser-assistant-activity.py
python tests/browser-assistant-preferences.py
python tests/browser-calendar-questions.py
```
