# Use Spaces from ChatGPT or Claude

Connect your AI client to your personal Open Brain account. You can then ask it to
find a Space, read it, save a note or document link, or link an existing record.

## One-time connection setup

For ChatGPT, use the personal Supabase OAuth endpoint directly:

```
https://prctfnpbftjepdckwpao.supabase.co/functions/v1/open-brain-gemini-oauth
```

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select **+ → Add custom MCP
   server**, name it **Open Brain Personal**, enter the endpoint above and choose
   OAuth. Available controls depend on account/workspace permissions.
2. If ChatGPT asks for a client ID and secret, copy the exact callback/redirect URL
   shown for this connection. In your Supabase project, open **Authentication →
   OAuth Apps → New OAuth App**, name it **Open Brain ChatGPT**, choose
   **Confidential** and paste that exact redirect URL. Create the app and copy its
   generated client ID/secret directly into ChatGPT. A callback URL is not a secret;
   keep the client secret private. Do not substitute a project API key.
3. Complete the connection in ChatGPT. On **Authorize Open Brain**, enter the
   email and **Open Brain password** for the same account as the dashboard and
   choose **Sign in with password**. This sends no email and keeps the OAuth
   callback in its original tab. Enter the password only on the Open Brain page.
4. On **Authorize Open Brain**, review the app name **Open Brain ChatGPT** and
   click **Approve**. Signing in alone does not approve the connection. Wait for
   the page to return to ChatGPT. This endpoint retains its existing household-admin
   requirement and requests no new Gmail/Calendar permissions.
   Existing consent may return you automatically without asking for approval again.
5. In a new chat, select **Open Brain Personal** with `@` and ask it to use
   `list_spaces` to show your Spaces. Refresh the connection's tools if needed.

An expired request cannot finish connecting. Close its old authorization tab,
reload the ChatGPT connection page and start a fresh Connect attempt. If a sign-in
link opens the dashboard, return to the original Authorize Open Brain tab and
look for Approve. Complete approval before the new request expires. A spinning
ChatGPT Connect button can represent an unfinished attempt; a fresh page load
is needed before retrying. Do not create replacement credentials just because
an individual authorization request expired.

Email links remain an alternative. Keep the original connection tab open. Copy
the new email sign-in link into that original tab's address bar instead of
finishing OAuth in a new email tab. This preserves the AI client's private
callback context. Use the newest email for the current attempt; never post an
email sign-in link in chat. If sending is rate limited, stop resending and use
the password option, or wait for the email limit to reset. No password is changed
or reset by this connection flow.

The existing shared-parent connection keeps its old memory/task tools, but cannot
identify an individual or access private Spaces. Select the personal connection
for Space work. Refreshing a shared-key connection alone does not make it personal.

Claude can use a custom OAuth connector to the same personal endpoint with its own
registered client and exact callback URI. Gemini's quick-add connection is a separate
setup; preserve its current configuration while verifying ChatGPT.

The existing Cloudflare OAuth gateway ending in `/mcp` is an optional route for
clients that need dynamic registration advertised. It is not required when using
an explicitly registered OAuth client with the direct Supabase endpoint. Supabase's
current public authorization-server metadata does not advertise
`registration_endpoint`. Manual registration does not require a saved gateway URL.

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
