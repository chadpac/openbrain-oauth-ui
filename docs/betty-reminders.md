# Betty: personal reminders from chat

Betty is the user's chosen assistant name, not a separate service or a global
wake word. ChatGPT or Gemini must have a working personal Open Brain connection
and expose the relevant tools in that conversation. Naming the assistant does
not install a connector or change either product's saved instructions.

## Suggested saved instructions

Save this separately in each AI product's personal instructions or a dedicated
assistant/Gem. Select the personal Open Brain connection where needed:

> My personal assistant is Betty. “Betty, remind me to…” means a personal Open
> Brain reminder, not a reminder stored in ChatGPT or Gemini. Use
> get_my_reminder_settings and create_personal_reminder when available. Resolve
> an unclear date/time with me and use the returned timezone unless I specify
> another one. Save it privately to my account. Confirm its title and reminder
> time only after saved=true; do not say it was sent before delivery is confirmed.
> “Betty, remember…” means save a note to my Home Space. Resolve the actual Space
> first; ask before saving a note in a household-shared Space. If the connection
> or required tool is unavailable, tell me instead of claiming it was saved.

The instruction has to be added in those products by the user. Deployment does
not edit their account settings. Gemini's separate quick-add connection may not
expose these personal OAuth tools; inspect its available tools before relying on
the same wording there. No replacement of that working connection is required
by this rollout.

## Betty inside the Open Brain dashboard

The dashboard's built-in Betty panel is a separate path from ChatGPT/Gemini.
“Betty, check my Open Brain reminder settings” now reads the signed-in person's
saved channel configuration, timezone and quiet hours directly, with no AI request,
task/memory/Health reads, notification sends or changes. The chosen assistant name
is recognized. Explicit settings-only questions use this path; a combined settings
and action request retains the normal proposal/review flow. Existing assistant
context checks and private activity tracking still apply.

The November 17 dashboard error was a provider failure, not an OAuth failure or
an invalid Betty name. The primary model ID was invalid; the fallback's unspecified
output limit requested a 16,384-token allowance and was rejected for insufficient
credit. General answers now use the existing valid `openai/gpt-4o-mini` model with
an explicit 3,000-token output cap and a 30-second request timeout. No provider call
or credit purchase was made to test the fix. Credit can still run out; the UI now
reports that specific condition instead of incorrectly blaming verified settings.
Truncated responses never become actionable proposals, and provider response bodies
are not logged or displayed. These response limits are not an account spending cap.

## Personal reminder tools

- `get_my_reminder_settings`: read only the caller's channel booleans, household
  timezone and quiet hours. No device endpoints, keys or Telegram IDs are returned.
- `create_personal_reminder`: create one private one-time task, owned by and
  assigned to the authenticated caller. Resolve future dates/times explicitly;
  timestamps require an offset, and a separate deadline cannot precede the
  reminder. No inferred default time or assignment to another family member.
- `get_my_reminder`: re-read one caller-created, caller-assigned task by returned
  ID. Its saved time, visibility, current status and channel-acceptance marker
  can be checked without sending a message or reading another person's reminders.

Personal reminder creation uses a caller-generated UUID as the task primary key.
Reuse the same ID and content after any interruption. The primary-key constraint
prevents concurrent duplicate inserts; exact current caller-owned content is
checked before recovering an interrupted save. Changed content is a conflict,
never an overwrite. Recovery also works after the reminder time passes or a
channel is disabled. An unknown outcome must never be retried with a new ID.
This is per-request protection; semantically identical requests with new IDs are
still distinct tasks. A task intentionally deleted later cannot be recognized
as an earlier completed request by a tombstone ledger.

Existing household tasks and recurrence remain separate. `create_family_task`
creates an explicitly requested household-visible task, with membership and writes
now using the caller's JWT/RLS and household, and creator fixed to the caller.
Its older API has no request ID; never blindly retry an interrupted creation.
The legacy shared-key endpoint does not gain personal reminder tools or access.

## Delivery and verification

The existing scheduler checks due reminders once per minute with the dashboard
closed. Task notifications use enabled phone/browser devices with task alerts
selected and/or the assignee's enabled Telegram connection. Quiet hours can defer
delivery. A separate due time alone does not schedule an alert: `remind_at` does.

If no channel is configured, creation stops before saving. The caller can ask
whether the user wants to enable notifications in Settings or explicitly save a
task without an alert. Only that agreement permits `save_without_delivery=true`;
the result reports `no_channel_configured`.

`saved=true` means the database confirmed the task. `awaiting_delivery` means
no delivery is recorded yet. `accepted_by_at_least_one_channel` means at least
one provider accepted an alert, not that every device received/displayed it.
Errors require review in Open Brain; raw provider responses are not exposed to
chat. Connection, browser/OS permission and notification settings affect display.
The worker's existing retry/lease behavior is unchanged; see
[reminder reliability](reminder-reliability.md) and [quiet hours](quiet-hours.md).

On November 17, 2026, read-only production checks confirmed active minute-based
reminder jobs, successful worker HTTP responses, an enabled task device and
Telegram for the connected account, and an earlier recorded reminder acceptance.
Those checks created no task, sent no test message and did not prove phone display.

When the user returns, select the personal connection in a new chat and ask
“Check my Open Brain reminder settings.” Then choose a real reminder a few
minutes ahead, verify its private dashboard task, close the dashboard and confirm
phone/Telegram arrival. This final device-display check is still outstanding.

## Implementation and release

The three tools use the request's verified user client and existing table grants
and RLS. No service-role task queries, schema changes, new OAuth scopes, AI calls,
live test tasks or notification sends are needed to deploy. The existing admin
requirement on the personal endpoint remains in place. The server version is 1.2.0
with 20 tools; clients may need a fresh conversation/tool discovery.

Synthetic tests exercise the actual MCP SDK and caller-JWT handler with mocked
Supabase requests, unique-key races, lost insert replies, invalid times, unavailable
settings, quiet hours, scoped household writes and delivery-state distinctions.
The existing reminder/quiet-hour/Space regression suites remain required.
