# Open Brain priorities

These priorities were agreed with the household owner. Extend the existing app,
preserve private and household boundaries, and prepare reviewable changes before
publication.

## Completed

- Google Calendar phase one: read-only OAuth, encrypted refresh tokens, calendar
  selection, Today/This Week/Upcoming, refresh and revoke; Google Production setup.
- Reliable reminders: authenticated scheduling, overlap/retry protection, safer
  notification actions, recurrence validation, and private Health delivery.
- Read-only Calendar questions with explicit per-question opt-in.
- Personal quiet hours for scheduled push/Telegram across devices.
- Toast placement, dashboard count drilldowns, and dated weekly-plan display/reuse.
- Private complete Evening Health check-in history with filters and older pages.
- Private descriptive Health trends, optional task duration estimates and reviewed
  calendar-gap suggestions; simplified Health cards and collapsible recent entries.
- Private assistant preferences and saved-memory controls, with context-aware
  conversation/brief invalidation (merged; deployment verification required).

## Current work

Assistant activity and approval center: private request states, model-selected
source links, scoped one-proposal approvals, durable pause/cancel, Calendar/device
status and task/event delivery retries. See [behavior, boundaries and deployment](assistant-activity-and-approvals.md).

## Agreed next phases

1. Focused read/search-only Gmail pilot and calendar/email intelligence: school
   deadlines, commitments, daily digests, linked messages/events, suggested tasks,
   reviewed reply drafts, and conflict-aware planning. Calendar writes and email
   sending need separate permissions and review before consequential changes.
2. Background routines: scheduled and event-driven bounded work after the app
   closes, resumable progress, meaningful completion/change notifications, pause
   controls, and visible AI/hosting usage limits.
3. Configurable Spaces: start with School and Home, then projects, meal planning,
   maintenance, trips and goals. Combine relevant tasks, events, documents, notes,
   progress and reviewed actions; pin/hide/reorder before considering generated UI.
4. Photo/PDF capture: reviewed extraction from flyers, forms, receipts and documents
   into proposed dates, tasks and records, retaining the source.
5. Voice: dictation and optional spoken responses first, then live conversation;
   optional avatar/personalization after the useful workflows work reliably.
6. Shopping, subscriptions and travel: wishlists, gift budgets, price watches,
   renewal/return deadlines, comparisons and itineraries. Begin with tracking and
   recommendations; reviewed transactions are a later step.

## Cross-cutting additions accepted after the Muse review

- Explicit watch rules for useful changes (deadline updates, replies, price
  thresholds, conflicts), with interruption controls beyond fixed reminders.
- Sourced web research and reusable comparisons, checklists, documents and
  itineraries linked to tasks/projects instead of losing results in chat.
- Goals broken into milestones and dependencies, next actions, periodic check-ins,
  progress and stalled-work signals, linked to calendar time, habits and week plans.
- Granular connector permissions and memory/data export and deletion controls as
  the assistant grows. Avoid duplicate transactions and claim success only after
  the provider confirms the result.

## Later ideas retained

- Optional per-device quiet hours; more household chores and responsibilities.
- Explicit family free/busy sharing, refined parents-only/household/private access,
  and individual dashboards without revealing another person's private details.
- Drive search; optional Tasks/Todoist import/sync with duplicate handling.
- Business projects/inventory/integrations separated from household/private data.
- Synology/NAS and historical Gmail/chat/notes/Takeout imports into a searchable
  personal timeline; local processing where it improves privacy, cost or reliability.
- Optional location-aware errands, Home Assistant, richer people/project pages,
  dedicated mobile experiences, and reviewed browser/online actions.

## Product and privacy boundaries

Health stays private to its owner and excluded from general AI context and briefs.
A future Health AI opt-in must be separate and explicit. Trends are descriptive;
missing data is not zero and correlations are not medical conclusions. Connected
email, Calendar and other sources must have visible scope and permissions.
Sending, purchasing, submitting and other consequential actions require the
relevant approval. Routine work should not create repeated unnecessary prompts.

## Research behind the November 12, 2026 additions

These are Open Brain roadmap decisions inspired by documented Muse capabilities,
not a dependency on Meta's models or a promise of feature parity.

- [Muse product design: background work, goals, activity, memory, artifacts](https://muse.ai/blog/how-we-designed-muse)
- [Spaces: custom project dashboards and background updates](https://about.fb.com/news/2026/11/introducing-spaces-customize-muse-app/)
- [Voice and optional expressive avatars](https://about.fb.com/news/2026/11/introducing-muse-ai-voice-expressive-avatars/)
- [Memory and connector controls](https://muse.ai/security-and-privacy)
- [Connector approval and confirmed-result requirements](https://platform.muse.ai/docs)

Photo/PDF capture is our additional product recommendation. Meta describes sharing
Spaces as a direction being explored; Open Brain's own household roles and private
Health boundaries remain requirements throughout these phases.
