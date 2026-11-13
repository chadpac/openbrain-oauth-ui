# Assistant preferences and saved-memory controls

Your assistant is available from the sidebar, mobile More menu, Settings, and the
assistant panel. Preferences apply to the signed-in account, including Today and
weekly briefs. Household administrators cannot read another person's profile.

The form supports an assistant name, warm/direct/neutral tone,
concise/balanced/detailed answers, planning notes, and optional working days,
hours and time zone. Overnight work windows are supported. Working hours guide
assistant suggestions; they do not change reminders, quiet hours or calendar
records. Use defaults fills a draft; Save applies it. Loading or saving errors
are visible, and unconfirmed saves do not replace the confirmed profile.

Saved-memory use defaults to on to preserve existing behavior. Pausing it skips
both recent-memory reads and semantic memory retrieval for general answers and
briefs. It does not remove saved records or stop you from browsing them. Profile
notes remain part of assistant context. Health records remain excluded. The
explicit, read-only Calendar-question path continues to interpret only the
question and dates; fetched Calendar events never enter model context or history.
Actions proposed by the assistant still require review and Save.

## Review, correct and remove

Review saved memories opens on demand, with 20-record pages, text search and an
optional archived filter. Pagination uses created_at plus id to handle ties.
Existing household/parents/private RLS applies. Only the author sees edit/remove
controls; other people's shared records are read only. Editing uses the existing
reviewed memory editor and save-memory service. Removal requires confirmation and
a returned row under the caller's own permissions. Archived memories are not
used in answers or semantic results.

The list shows accessible saved records, not an exhaustive provenance report of
every record used by an answer. Recent memory context is bounded to 60 records;
semantic retrieval adds up to eight currently visible active matches. Other
sources such as tasks or list items must be changed in their own screens.
Removing a saved memory does not erase facts independently stored in those
sources, text the user types again, or previous provider processing/retention.
There is no automatic learning or new connector in this release.

## Conversation and brief invalidation

A caller-RLS, SECURITY INVOKER RPC returns the caller's validated profile and a
SHA-256 context version. The version combines profile settings and the content
fingerprints of all currently visible active memories. The RPC returns no memory
text. Even while memory use is paused, the database fingerprint detects removals
so previously cached conversations cannot reintroduce deleted facts.

The browser keys chat and briefs by account and context version, prunes legacy
and older-version session caches, and clears visible conversation/briefs after
memory changes. It checks the current version at sign-in, opening the assistant,
before requests, and when returning to the tab. Other devices update when they
next refresh/check settings. This is not a real-time remote erase. An unverifiable
profile clears visible AI output and prevents general assistant requests.

The server discards old-version history before preparing model context, reads
preferences again after generation, and rejects the answer and actions with 409
if the version changed while answering. The browser also ignores stale in-flight
results after account/context changes. Semantic result IDs are re-read with RLS
and archived_at=null, so stale match payloads cannot reintroduce removed records.

## Deployment

1. Apply `20261113043720_assistant_preferences_memory_controls.sql`.
2. Deploy open-brain-assistant with index.ts, calendar-questions.ts,
   assistant-preferences.ts and deno.json; keep verify_jwt=true.
3. Merge/publish the dashboard, privacy notice and service worker v25.
4. Check the new form, save/reload, memory controls and assistant/Calendar paths.

No user preference rows are inserted by migration; missing rows return safe
defaults. The table has owner-only SELECT/INSERT/UPDATE policies, no authenticated
DELETE permission, no anonymous access, validated enums/time zones/days/times, and
no elevated triggers. Deployment should run backend first because older assistant
responses do not carry the context version required by the new frontend.

## Validation

- `NODE_PATH=/workspace/work/reminder-tools/node_modules node --test tests/assistant-preferences.test.cjs tests/calendar-questions.test.cjs`
- `python tests/browser-assistant-preferences.py`
- `python tests/browser-calendar-questions.py`
- Existing Health history, Health trends/task planning, and dashboard detail checks.

Tests use synthetic users/records and PGlite RLS. They do not read live memories,
Health records, or submit real AI requests.
