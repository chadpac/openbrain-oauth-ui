# Gmail read-only pilot

Email review is in the desktop sidebar and mobile More menu. Each account connects
its own Gmail account. Checking connection status does not read mail. Search is an
explicit request for the last 24 hours, 7 days or 30 days, with up to 200 characters
of Gmail search syntax and 20 message results per page. Received timestamps are
also checked server-side so search operators cannot bypass the selected window.
Deleted/inaccessible messages are reported as unavailable rather than silently
claimed as reviewed. The digest describes only loaded messages, not the entire
mailbox, and is generated on demand; background/scheduled digests remain future
work.

The service uses Gmail messages.list and messages.get with format=metadata, a
bounded fields projection and short excerpts. It does not fetch full bodies,
attachments or remote images, mark messages read, change labels, create Gmail
drafts or send email. Possible deadline/commitment flags are keyword hints, not
confirmed dates or AI interpretations. No email is sent to a model, embedded into
memory, or included in general assistant context by this pilot.

## Reviewed private tasks

Choose Prepare private reminder on a message. Edit the title and choose a future
reminder time; dates are not inferred from excerpts. The browser rejects skipped
and ambiguous local DST times. The server re-reads the source, checks its
fingerprint and connection generation, and creates one private/self-assigned
proposal in Activity & approvals. This step does not save a task.

The approval card shows the exact task title, subject/sender/source link,
visibility, assignee and time. Its existing transactional caller-RLS save and
receipt provide duplicate protection. A receipt trigger checks the Gmail account
generation under an account advisory lock before commit. If the account was
disconnected or switched, the entire domain write rolls back. Reconnect and
proposal creation use the same account lock. Source links re-read the current
message under the recorded account generation. They cannot silently switch to a
different Gmail account. Request UUIDs make proposal retries idempotent; changed
payloads under the same request ID are rejected. A new request can intentionally
prepare another task, so this is not cross-request duplicate detection.

Approved private tasks may enter the existing assistant's task context. This is
disclosed in the review flow. Task descriptions contain only subject, sender and
a fixed Gmail link, not the excerpt. Independently saved tasks and activity drafts
remain after disconnect; deleting those records uses their own screens.

## Google Cloud setup

The pilot reuses the existing GOOGLE_CALENDAR_CLIENT_ID/SECRET and registered
callback. Do not paste credentials into chat or replace existing Calendar secrets.

1. In the existing Google Cloud project, enable **Gmail API**:
   https://console.cloud.google.com/apis/library/gmail.googleapis.com
2. In Google Auth Platform → Data Access, add only:
   `https://www.googleapis.com/auth/gmail.readonly`.
   Existing Calendar read-only permissions remain. Gmail OAuth requests only the
   Gmail scope with include_granted_scopes=false, offline consent and PKCE.
3. Keep the existing registered callback exactly:
   `https://prctfnpbftjepdckwpao.supabase.co/functions/v1/google-calendar-oauth?action=callback`.
   A cryptographically random `gmail.` state is routed to the Gmail handler and
   consumed atomically from a separate service-only state table. Calendar states
   continue through the original flow. No new redirect URI is needed.
4. Check the audience/test-user settings and Google's restricted-scope rules for
   your intended pilot. Do not move an existing Production Calendar application
   back to Testing just for this addition. Follow Google's applicable verification
   process; public distribution or server handling of restricted-scope data can
   require additional verification/security assessment. Publishing is not proof of
   verification. Personal-use exceptions depend on Google's eligibility rules.
5. In Open Brain, open Email review → Connect Gmail and complete Google's consent
   for the intended account. Then run a narrow search to verify access. The agent
   does not grant Google consent or read live mail as part of deployment tests.

`GET /functions/v1/google-gmail?action=config` reports credential presence, the
scope and redirect, never secrets. It cannot prove that Gmail API is enabled,
that the consent configuration is accepted, or that a refresh token works. A
successful user-authorized connection and read are still needed.

Disconnect revokes the Google grant before removing local credentials; a failed
revocation keeps them for retry. Google revocation may also invalidate Calendar
access for the same app/project/account. The confirmation explicitly says so;
cached Calendar events are cleared and a connected Calendar is flagged for
refresh/reconnect. Replacing the Gmail account invalidates older Gmail approvals.

## Storage and access

- google_gmail_connections and google_gmail_oauth_states have RLS and no browser
  privileges. Tokens reuse the existing server-only Vault-backed encryption RPCs.
- google_gmail_accounts exposes only the caller's own email/connection/status
  metadata through SELECT RLS; authenticated users cannot update its identity.
- Save/clear/proposal RPCs are SECURITY INVOKER and executable only by service_role.
  The receipt trigger is also invoker-only. It never accesses token ciphertext.
- Email headers/excerpts are held in the view, cleared on reload/sign-out, and
  never stored in localStorage/sessionStorage. Late reads, sources and proposal
  responses cannot populate another signed-in account. Failed reads clear the
  actionable message list. Server responses are no-store; service workers never
  cache Gmail API responses.
- Stored proposal/task copies intentionally retain the approved subject, sender
  and link. Disconnect does not erase those separate records. No mailbox sync,
  historical import, automatic AI learning or background polling is added.

## Rollout

1. Apply `20261113210622_gmail_readonly_pilot.sql` after the activity migration.
2. Deploy google-gmail with its shared gmail.ts helper, deno.json/lockfile.
   verify_jwt=false is intentional: every POST validates its bearer with
   auth.getUser; GET config contains no secrets. The OAuth callback is handled by
   the existing public Calendar callback, which also retains verify_jwt=false.
3. Deploy google-calendar-oauth including the shared helper, and open-brain-activity
   with its existing helper plus Gmail account checks. Other assistant/model
   functions are unchanged.
4. Publish dashboard/privacy/service worker v27. Configure Google Cloud and complete
   consent before claiming a live mailbox read works.

Automated checks use synthetic records and mocked Google responses. They cover
OAuth scope/PKCE/state replay, encrypted storage, metadata projections, bounded
queries, source fingerprints, generation changes, revocation failures, caller-RLS
task saves/rollback, UI account switching and 320/390/1280px layouts.

References: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get),
[Google OAuth revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke),
[restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
