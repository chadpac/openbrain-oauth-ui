# Google Calendar phase one setup

This extends the existing dashboard. Google events remain read-only, are fetched
for the signed-in user, and are never written into the household events table.
Health & Wellbeing data is not sent to this integration or added to AI context.

## Google Cloud

1. Open https://console.cloud.google.com/ and select/create the project that will
   own Open Brain's OAuth client.
2. In **APIs & Services → Library**, enable **Google Calendar API**.
3. In **Google Auth Platform**, configure:
   - **Branding**: App name `Open Brain`; choose your user support email and
     developer contact email. For personal testing, complete the required fields;
     do not invent privacy-policy URLs. A production verification submission may
     require a real home page, privacy policy, and verified domain.
   - **Audience**: `External` for ordinary Gmail/family accounts. Keep publishing
     status `Testing` initially. Add every family Google account that will test
     the connection under **Test users**. `Internal` is only suitable if every
     user is in the same eligible Workspace organization.
   - **Data Access → Add or remove scopes**: add exactly:
     - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
     - `https://www.googleapis.com/auth/calendar.events.readonly`
     Do not add Calendar write scopes.
4. **Clients → Create client → Web application**:
   - Name: `Open Brain Calendar`
   - Authorized JavaScript origins: leave empty. This app uses a server callback,
     not the Google JavaScript OAuth SDK. If a UI requires an origin, the dashboard
     origin is `https://chadpac.github.io` (no path).
   - Authorized redirect URIs: paste this exact single URI, including the query:

     ```text
     https://prctfnpbftjepdckwpao.supabase.co/functions/v1/google-calendar-oauth?action=callback
     ```

   Do not use Supabase Auth's `/auth/v1/callback` or the dashboard as the redirect.
5. Create the client. Copy its client ID and client secret directly into Supabase
   as described below. Keep the secret out of source code and chat.

External apps in Testing generally receive refresh tokens that expire after
seven days when Calendar scopes are requested. That is expected during testing.
For stable family use, review Google's publishing/verification requirements and
move to Production as appropriate; publishing does not by itself imply verification.

## Supabase secrets and deployment

Open https://supabase.com/dashboard/project/prctfnpbftjepdckwpao/functions/secrets
(or **Edge Functions → Secrets**) and add:

| Secret name | Value |
| --- | --- |
| `GOOGLE_CALENDAR_CLIENT_ID` | The Web application's client ID ending in `.apps.googleusercontent.com` |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | That same client's client secret |

These belong only in Edge Function secrets. No frontend environment variables,
Supabase Auth Google provider changes, or new token-encryption keys are needed.
The existing Vault encryption key must remain intact.

The checked-in `supabase/functions/google-calendar-oauth` is the source of the
existing live function. `supabase/config.toml` retains `verify_jwt = false` so the
unauthenticated Google callback can reach it. Every authenticated POST performs
its own bearer-token validation with `auth.getUser` and checks household membership.

Deploy the reviewed function with the Supabase deployment tooling. No schema
migration is required for these fixes. Merge/publish the dashboard changes through
the repository's existing hosting flow; cache v16 replaces the previous v15 shell.

## Verify configuration

Open this public metadata endpoint (it never returns tokens):

```text
https://prctfnpbftjepdckwpao.supabase.co/functions/v1/google-calendar-oauth?action=config
```

Expected: `configured: true`, the exact redirect URI above, and only the two
read-only scopes. This checks that both settings exist; a successful OAuth flow
is still needed to confirm the values are valid.

## End-to-end acceptance check

1. Sign into Open Brain at
   https://chadpac.github.io/openbrain-oauth-ui/dashboard/.
2. Settings / Family → **Connect Google Calendar**. Sign into an allowed test
   Google account and approve both read-only permissions. You should return to
   Open Brain with a connection confirmation.
3. Choose calendars. Select only calendars you want shown, then save. Choosing
   none must display zero Google events. Selections are private to this user.
4. Use events on the selected calendar to check:
   - A timed event today appears in Today and Upcoming Events, using your local
     timezone, and contributes to This Week's count.
   - An event later this week contributes to This Week and appears among the
     first six Upcoming Events when applicable.
   - A multi-day/all-day event contributes on every overlapping day, excluding
     Google's exclusive end date. Events before today but in the current week
     still contribute to This Week.
   - Each Google event says `Google · read only`, with no Edit action.
5. Change an event in Google, click **Refresh events**, and confirm the result.
   Google updates are read only; Open Brain never modifies Google events.
6. Reload Open Brain and reconnect in a later session to exercise refresh-token
   use. Browser responses/storage must never contain refresh tokens or ciphertext.
7. Disconnect. Google revocation must succeed (or already be invalid) before the
   stored connection is removed. A transient revoke failure should show an error
   and allow retry. Open Brain events must remain intact.
8. Reconnect, test denial of consent, and test an invalid/revoked grant. The UI
   must show the actual error and retain reconnect/disconnect controls.

Automated checks use fake Google/Supabase responses, not live credentials:

```sh
node --test tests/google-calendar.test.cjs
python tests/browser-calendar.py
```

Use Node 24+ for the TypeScript test harness and Python Playwright with Chromium
for the browser smoke test. Set `CHROMIUM_PATH` if Chromium is elsewhere.

## Security review notes

The live token/state tables have RLS enabled and only `postgres`/`service_role`
table privileges. Token encrypt/decrypt RPCs are executable only by those roles.
The advisor's "RLS enabled, no policy" notices for these tables are intentional:
normal clients must have no access, including read access. Do not add browser
policies to clear those notices.

The project also has pre-existing advisor warnings unrelated to Calendar:
mutable search paths, publicly executable SECURITY DEFINER task functions, and
leaked-password protection disabled. Assess those functions' authorization bodies
before changing grants. See [Supabase function security guidance](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

References: [Google server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/guides/auth).
