# Reviewed Google Calendar event creation

Choose **+ Google event** in Upcoming Events or **Prepare Google event** on a Gmail
search result. Enter a title, destination calendar and confirmed start/end times
in the household timezone; times are never guessed from email. Location/details
are optional. This first release supports one timed event, 5 minutes to 24 hours,
starting in the future within the next year. It adds no guests or invitations,
uses the destination's default reminders and requests private event visibility.
Calendar owners/editors may still see the details. Existing-event editing/deletion,
all-day events, recurrence and guests are future additions.

## Permission and review

Existing Calendar display/questions and the ordinary Connect button remain
read-only. **Enable event creation** requests the additional `calendar.events`
scope through the same OAuth client/callback with PKCE and an atomically consumed
state that records whether writing was requested. The callback checks that grant
before replacing the encrypted credential and connection generation. Google scope
configuration and one-time user consent are described in [setup](google-calendar-setup.md#enable-reviewed-event-creation-on-the-existing-connection).
The scope allows more than creation at Google's permission level; this API exposes
only creation of an approved event. An account's selected writable calendars
(Google owner/writer role) are the only possible destinations.

**Check & review** reads selected Google calendars plus caller-RLS-visible family
events, stores an immutable private proposal, and makes no external write. The
review shows the exact destination/account, title, dates/timezone, details,
visibility and any overlapping busy events. It does not reserve time. At most
1,000 Google records and 250 family records are considered; partial/oversized
reads fail closed. All-day exclusive ends, overlapping sources and free/declined
flags follow existing Calendar rules. Unknown relevant end times block a check.
The review displays up to twenty conflicts and their full count. Other tasks or
reminders are not reservations. Only the chosen sources are checked.

**Approve & create** is a distinct explicit action. Any known conflicts require
the separate confirmation checkbox. Before a new provider write, the service
rechecks the connection generation, membership, selected calendars, destination
role, household timezone, source excerpt if applicable and event snapshot. A
changed snapshot requires cancelling the pending review and checking again.
Google has no atomic conflict-check-and-insert operation: another person can add
events between the check and the save, or later. This is conflict assistance, not
a continuing availability guarantee.

## Email and privacy boundaries

An email-derived title is editable and shown in the review. Copying subject,
sender and Gmail link into the event details is off by default and requires an
explicit checkbox. The service re-reads the source under the caller's own Gmail
generation and checks the excerpt fingerprint; no full bodies or attachments are
fetched. Source IDs and the fingerprint remain in the private proposal even when
not copied to Google. Email/Calendar records are not sent to a model by this flow,
and Health records and other members' private connections are never queried.

Proposals retain the event draft, source identifiers, bounded conflict snapshot,
state and provider receipt in Supabase. SELECT RLS restricts them to the owner
still in that household; browsers cannot mutate rows or execute the service-only
invoker RPCs. Tokens stay in the existing server-only encrypted connection table.
Sign-out/account changes clear view state and reject late responses. Creation
reviews do not enter general assistant context. These are separate from email task
references, which follow the task context behavior described in the privacy notice.

## Duplicate protection and interrupted saves

- Owner/request IDs reject changed payloads on retry. Identical active intents for
  the same connection share a proposal, including across fresh request IDs.
- A database row lease serializes simultaneous approvals. A second worker cannot
  finish an earlier worker's lease. The final pre-insert RPC checks membership,
  account/selection/scope, source generation and an unexpired lease, then stamps
  that a write may begin before the provider request leaves the service.
- Each proposal uses a fixed `ob` + UUID-derived Google event ID. The provider
  request includes private proposal/hash markers and never updates an existing
  event. A collision is read back and verified against the exact approved event.
- Completion is stored only after a matching Google response. A timeout, process
  interruption or failed receipt write preserves an uncertain/creating state.
  Retry first reads the same event ID; if present and matching, it records the
  result without another insert. If a previous stamped write cannot be found,
  it stays uncertain and no further insert is sent. Check the original calendar
  and retry the lookup later; if Google never confirms it, administrator help is
  needed to resolve that review before intentionally trying a new one. This
  conservative limit also avoids recreating an event removed outside Open Brain.
- A stamped write cannot be dismissed as an unwritten pending draft. The UI asks
  to check/retry the same review instead of preparing a duplicate. Google IDs
  provide practical idempotency; they are not a cross-provider transaction or a
  guarantee against Google's documented distributed ID-collision limits.
- Google events modified or removed outside Open Brain are never overwritten or
  resurrected during reconciliation. A conflicting identifier requires manual
  Calendar inspection. Completed receipts remain receipts of the original save,
  rather than live event synchronization.

**Event reviews & history** in Calendar Settings shows the owner's twenty most
recent reviews/results and allows retrying the same review. Closing a review
does not approve it. Disconnect keeps independent history and Google events;
uncertain older-account writes may require checking that original calendar.
Private proposal/result rows are deleted with the account or by an administrator.

## Rollout and validation

Apply `20261115052104_google_calendar_event_creation.sql`, deploy
google-calendar-oauth with deno.json and all shared dependencies, then publish
dashboard/about/privacy/service worker v29. No new secret or callback is needed.
Google setup/consent is the user's final enablement step. Do not create real events
as a deployment smoke test.

Tests use PGlite for the actual migration, RLS/grants and lease RPCs, mocked Google
responses for the full service flow, and headless browser fixtures for manual/email
review, exact approval, conflicts, uncertain recovery, history, account changes and
320/390/1280px layouts. No live email, model request, Google write or notification
is used in automated checks.

References: [Events insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert),
[event IDs](https://developers.google.com/workspace/calendar/api/v3/reference/events#id),
[Calendar authorization scopes](https://developers.google.com/workspace/calendar/api/auth).
