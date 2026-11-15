# School and Home Spaces

Open **Spaces** in the sidebar or mobile More menu. **Create a School Space** and
**Create a Home Space** open reviewed setup forms with private visibility by
default. **+ Space** supports other named collections using the same controls.
Deployment creates no user Spaces or sample records.

## What a Space contains

- References to existing visible Open Brain tasks, family events, goals and saved
  memories. Linking stores source IDs, not copied titles, descriptions or bodies.
  The current source projection is read under the caller's RLS on each refresh.
- Space notes: a title and plain-text body stored in the Space, separate from AI
  memories. No embedding/model request is made.
- Document/web links: a title, http/https address and optional user-written context.
  Links open in a new tab with noopener/noreferrer. No remote document/image is
  fetched or uploaded and no Drive/document permissions are changed. Credentialed
  URLs and non-web schemes are rejected.

**Add item** offers a bounded searchable source picker or a new note/link form.
It lists twenty accessible sources per page, with UUID keyset pagination. Source
queries use the Space's household and current RLS; inaccessible counts are not
returned. Space metadata pages contain at most 100 accessible Spaces. Creators
can have twenty Spaces per household, with up to 200 accessible items per Space.
Oversized collections fail visibly instead of claiming complete coverage. Titles
and displayed source snippets are bounded; **View original** re-reads one current
source through its original table policy.

The initial event source is Open Brain family events. Google Calendar events,
email, Health records, routines and arbitrary other tables are not automatically
imported or linkable source types. A Google Calendar/document URL can be added as
an explicitly written web link, following that Space's visibility. Connector
integration and file capture can be added later with their own visible scope.

## Source permissions and sharing

A Space is private to its creator or explicitly shared with its household. Sharing
requires a confirmation naming the data that becomes shared: the Space's name,
purpose, native notes and document labels/links. It does not widen task, goal or
memory permissions. A household member reading a shared Space sees only source
links they can already access, without inaccessible source titles/IDs/counts.
Private/parents-only source policies remain in force. Archived memories/goals and
deleted sources disappear on the next current read.

The creator manages the Space and its contents; other household members have a
read-only collection but can customize their own view. Shared Space editing by
other members is a future extension. Membership is checked through every table's
RLS. Unsharing hides the Space, its native content and personal layouts from other
members. Existing content already viewed cannot be recalled. A shared Space whose
creator leaves the household remains read-only for remaining members until the
creator can manage it again or an administrator removes it.

Note/link saves carry both their item version and the Space settings version.
A private draft cannot silently save after another device shares the Space; the
user must refresh and reopen the editor. Space name/sharing and personal-layout
edits also use optimistic versions so stale devices cannot overwrite newer changes.
Stable request IDs make create retries idempotent, and source uniqueness prevents
the same record from being linked twice in one Space.

## Personal layout and progress

Pin or hide Space cards for your account. **Show Spaces hidden from my view** can
restore them. Within a Space, item options pin/hide/reorder records, and
**Customize my layout** hides/reorders the five sections: tasks, family events,
notes/saved memories, documents/links and progress/goals. School and Home have
different starting section orders. **Show items hidden from my view** restores
access to your hidden cards. These controls do not delete or reshare records and
do not affect another person's layout. Inaccessible/stale item pointers are dropped
when saving a personal layout rather than revealing whether a hidden source exists.

Task progress is completed / (pending + in_progress + completed) among currently
visible linked tasks, excluding your hidden items. Paused/cancelled/unavailable
tasks do not become a false denominator. An empty denominator shows no percentage.
Goal progress comes from the current linked goal. No generated progress, global
household completion claim or inferred task/event relationship is added.

## Creating and reviewing actions

**New task** opens the existing task editor and defaults to a private task assigned
to the creator, even for an administrator. An admin can explicitly choose household
visibility and another assignee. Linking a private task to a shared Space does not
share that task. **New family event** opens the existing family-event form with an
explicit household-sharing notice: a private Space does not make that event private.
These forms retain their existing notification/recurrence behavior and require the
normal Save action before a source record is created.

After a successful source save, a separate caller-RLS request links it to the
original Space, guarded by account identity and Space settings version. If linking
fails, the app states that the source was saved and instructs the user to link the
existing record; it does not claim rollback or encourage recreating it. A later
recurring task occurrence is a new record and is not automatically linked.
**Activity & approvals** opens the existing deliberate proposal review; there is
no automatic AI generation or approval from a Space.

## Storage, security and deletion

The additive migration introduces spaces, space_items and space_views with RLS,
explicit authenticated grants and invoker-only functions with empty search_path.
There are no new SECURITY DEFINER functions, service-role browser routes, OAuth
permissions, Edge Functions, cron jobs or secrets. Source access is not recreated
in privileged code: source-existence checks, detail projections and pickers all run
as the caller under the existing source table policies. Parent/owner/creator/source
identities are immutable through validation triggers. Polymorphic references
carry no cached private source content; unavailable references can remain as
unrendered metadata until their Space is deleted.

Removing a reference leaves the original task/event/goal/memory intact. Deleting a
native note/link removes that Space copy. Deleting a Space requires explicit UI
confirmation and cascades its native content/references and all viewers' layouts;
original source records remain. Space records also cascade when their household
or creator account is deleted. Personal view data is removed with that viewer's
account. Space data does not enter general assistant context or background routines
automatically. Health tables and Google/email endpoints are never queried by Spaces.

Forms and results live in page memory, not localStorage/sessionStorage. Account
changes clear content/forms and reject late list/detail/picker/source/mutation
responses. Visible Spaces refresh periodically; hidden tabs do not poll. Source
permissions cannot recall data already displayed, but subsequent reads and current
source dialogs are cleared when access is lost.

## Deployment and checks

1. Apply `20261115162802_school_home_spaces.sql` and verify hosted RLS/grants,
   invoker functions, source guards and security advisors. Existing source policies
   and data are unchanged.
2. Publish dashboard/About/privacy/service worker v31. No Edge Function or scheduler
   deployment is needed. Existing Gmail, Google Calendar and routine flows remain
   independent.
3. Verify static hosted files match tested source and the signed-out page loads with
   no script errors. Do not create real user Spaces, tasks, events or notifications
   as a deployment smoke test.
4. The user creates School/Home, links one existing record, adds a note/link, tries
   personal pin/hide/order and, if desired, explicitly shares with the household.

PGlite tests run the actual migration, RLS, invoker RPCs, immutable identities,
sharing/version guards, pagination, direct-write bounds and deletion semantics.
Browser fixtures exercise School setup, safe source rendering, notes/docs,
sharing confirmation, personal layouts/progress, source creation/link failure,
account changes and 320/390/1280px layouts. Existing application regression suites
cover Gmail, Calendar, reminders, routines, assistant controls and private Health.
No live user records, external document reads or notifications are used in tests.
