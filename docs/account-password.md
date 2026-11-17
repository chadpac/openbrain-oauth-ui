# Change your Open Brain password

In the dashboard tab where you are already signed in, open **Settings → Your
account → Change Open Brain password**. On mobile, Settings is in More.

The dialog verifies the current dashboard session and shows its account email.
Check that email, enter a new password twice and choose **Save new password**.
Wait for the confirmation before using the new password in a fresh ChatGPT
connection. This form does not send a sign-in email or open another browser tab.

If the session is missing or expired, the form stops and asks you to sign in in
that dashboard browser. Seeing a signed-in dashboard in a different browser or
profile does not sign in this one. Supabase may require recent authentication or
the current password according to the account's server-side policy; the form
does not bypass those requirements. No password is changed until you save.

## Implementation and verification

- Uses the dashboard's existing Supabase session and verifies it with getUser.
- Pins the authenticated `PUT /auth/v1/user` request to that verified account's
  access token, using the same self-service endpoint as auth.updateUser. An
  account switch cannot redirect the password write to another user.
- No service-role key, admin reset, direct database password write, new schema,
  Edge Function, project Auth setting or emailed token is involved.
- Passwords exist only in form/request memory; they are not logged, persisted in
  app storage or included in assistant context. Fields clear when a request
  starts/finishes and on dialog close, sign-out or account change. Late responses
  cannot show another account's result.
- Tests use synthetic identities/tokens and intercepted Auth requests. They
  cover validation, verified identity, caller token/body, provider errors,
  missing/mismatched sessions, account changes, late responses and phone layouts.
  No real account password is changed by verification.

Publish dashboard and service worker v33. The existing OAuth sign-in page accepts
the resulting Open Brain password; it is separate from the Supabase dashboard
account password and from third-party email account passwords.
