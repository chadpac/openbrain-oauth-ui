# Use Spaces from ChatGPT or Claude

Connect your AI client to your personal Open Brain account. You can then ask it to
find a Space, read it, save a note or document link, or link an existing record.

## One-time connection setup

Use the same **public OAuth gateway URL ending in `/mcp`** that was set up for
Gemini. It points to the personal Open Brain endpoint and advertises automatic
OAuth client registration for other compatible clients too.

To find it, open Cloudflare → Workers & Pages →
**openbrain-gemini-oauth-gateway** → Settings → Domains & Routes. Copy the
public `workers.dev` address and append `/mcp`. You can also copy that public URL
from the existing Gemini connection. Use the production address, without an
access key or preview/version prefix.

1. In ChatGPT, add a custom MCP app in Settings → Apps. Write-capable custom MCP
   apps require developer mode and availability/permission on your plan or workspace.
   In Claude, add a custom connector in Settings → Connectors. The exact labels
   vary by client version and organization settings.
2. Choose OAuth and enter that gateway URL. Do not append an access key or paste a
   Supabase API key, password or token into chat. Client ID/secret can normally be
   left blank when the client supports dynamic client registration, which the
   gateway advertises.
3. Complete the Open Brain sign-in/consent flow using **the same account as your
   Open Brain dashboard**. This endpoint retains its existing household-admin
   requirement. This is an Open Brain login; no new Gmail/Calendar scope is needed.
4. Enable the personal connection in your conversation. If you also have the older
   shared-parent connection, deselect it for Space work so the AI chooses the
   personal connection. Refresh its tools/reconnect or start a new chat if the new
   commands have not appeared yet.

The existing shared-key connection keeps its old memory/task tools. Its six new
Space entries return setup instructions: the shared key does not identify an
individual account and **never gains private Space access**. Refreshing that
shared-key connection alone does not turn it into a personal OAuth connection.

The upstream endpoint is
`https://prctfnpbftjepdckwpao.supabase.co/functions/v1/open-brain-gemini-oauth`.
Use the gateway for automatic setup: the direct Supabase authorization-server
metadata does not advertise `registration_endpoint`, so direct setup may require
an explicitly registered OAuth client ID and matching redirect URI. There is no
need to create a second gateway or change its existing routing.

## Things to say

- “Show my Open Brain Spaces.”
- “What's in my School Space?”
- “Save this note in my School Space. Title: Reading plan. Text: Read chapter four
  before Friday.”
- “Add this document link to my Home Space: https://example.com/manual. Call it
  Dishwasher manual.”
- “Find my existing task called Submit permission slip and link it to School.”
- “Find the memory about our school supply list and add it to School.”

The AI first resolves the named Space and its current visibility/version. If names
repeat, it should ask which one you mean. A household Space exposes native notes
and document links to your household, so saving those requires explicit sharing
consent. You can include “I understand School is shared with my household; save
this note there” when that is your intent. Linking an existing private record
does not change that record's permissions.

After a successful save, the item appears in the dashboard Space when refreshed.
You still create, rename, share, unshare and delete Spaces in the dashboard. Other
household members can read accessible shared content but only its creator can add
items. Notes are native Space notes, not new AI memories. Document links are stored
without fetching their contents or changing document access.

## Tools and privacy

| Tool | Action |
| --- | --- |
| `list_spaces` | Metadata only, at most 100 Spaces per page with complete keyset cursors. |
| `get_space` | Explicit read of one Space and up to 200 caller-accessible items. |
| `find_space_sources` | Search existing tasks, family events, goals or memories, 20 per page. |
| `add_space_note` | Add a titled plain-text note, up to 6,000 characters. |
| `add_space_document` | Add a safe http/https link and optional plain-text context. |
| `link_space_item` | Reference one existing accessible record; duplicate links stay single. |

These tools use the OAuth caller's own Supabase client and the existing invoker
RPCs/RLS. Neither tool arguments nor incoming identity headers can select an actor.
No service-role client is passed to the Space tools. The personal OAuth request
client is passed through Hono's request-specific environment, never global state.
Existing shared-key tools and the child MCP endpoint are unchanged in scope.

Writes require the current Space settings version. Native note/link writes also
check explicit household-sharing consent. The database rechecks the version and
source access atomically at save time. A settings change requires a fresh read
and review instead of silently publishing a private draft.

Each create has a required request UUID, reused unchanged for interrupted retries.
An identical request is idempotent; a changed request cannot reuse that identity.
Success is reported only after the database save succeeds. If a reply was lost,
retry the original ID/content or read the Space before trying a new create.
Existing item editing/deletion and source-record creation are not new Space tools.

All returned content is user data, not assistant instructions. Space commands do
not call an embedding/chat model, fetch external documents, send notifications,
read Gmail/Google Calendar/Health, or auto-load Space contents into general chat
context. The chosen AI client does receive the content you explicitly read or
save through it; choose the appropriate account/client for that information.

## Deployment and verification

The MCP source files are imported from hosted `open-brain-mcp` v15 and
`open-brain-gemini-oauth` v4, now versioned in this repository. Existing tool bodies
and auth gates are retained; a shared helper adds the six Space tools. Dependencies
are pinned and Deno lockfiles are committed. Runtime types use a pinned npm import.

Deploy both endpoints with `verify_jwt=false`, preserving their existing custom
key and OAuth authentication. This is not an unauthenticated data route: the old
endpoint verifies its key; the personal endpoint verifies a user JWT and admin
membership. No database migration, secret, cron or Google permission change is
needed. The child MCP and old named Gemini-key endpoint are not deployed.

Tests use actual MCP SDK discovery/calls and synthetic fixtures, including a
locally signed test OAuth JWT. They verify caller bearer/public-key forwarding,
forged header rejection, legacy behavior, bounds, ownership/version/sharing guards,
pagination, safe links, idempotent IDs and failure reporting. Existing SQL tests
exercise the actual underlying RLS/RPCs. Live checks use unauthenticated metadata
and denial responses; they do not read private records or create test user data.
