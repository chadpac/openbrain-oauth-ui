# Photo/PDF capture: implementation brief

Status: next phase, design started November 17, 2026. No upload or extraction
feature is deployed by this brief. Spaces from chat has been verified by the user
for reading Home and saving a note; personal reminder verification and tool work
are documented in [Betty reminders](betty-reminders.md).

## First useful workflow

From Inbox or a Space, choose a flyer/photo or PDF. Preview the source, choose
whether to extract proposed tasks and dates, review the exact wording and source
evidence, correct it, and save only selected proposals. Preserve a private link to
the original file so a saved task can be checked later. Default to private tasks
owned by and assigned to the signed-in person. A household Space does not make
an uploaded file or derived task shared.

Example: a school flyer says “Permission slips due Friday, November 20.” Extraction
can propose “Return permission slip” with that evidence and date. It must ask for
a reminder time and confirm the intended year/timezone; neither an alert time nor
Google Calendar event is silently invented. Unselected proposals create nothing.

## Build order

1. **Private source lifecycle.** Add an authenticated capture endpoint, private
   Storage bucket and owner-bound source records. Enforce owner and current
   household membership in table and object RLS; service credentials never reach
   browser code. Authorize bounded temporary reads rather than storing public
   source URLs. Start with JPEG/PNG and PDFs, one file at a time, at most 10 MB and
   10 PDF pages. Enforce MIME/signature/size and decoded-page/pixel limits on the
   server, reject encrypted/damaged/unsupported files clearly, and clean up failed
   uploads plus orphan objects. Escape names and extracted text. Do not evaluate
   embedded scripts, fetch PDF links or execute document instructions.
2. **Explicit extraction.** Show exactly which selected file/pages go to an OCR/
   model provider before starting; keep general Health exclusions and no automatic
   email/Drive attachment reads. Extract candidate text, page numbers and verbatim
   evidence into a strict schema. Prefer local PDF text where suitable; choose a
   pinned parser/OCR implementation after current security/version review. Treat
   file text as data. Bound file/page/token costs, persist processing status and
   request IDs, allow cancellation, and disclose uncertainty rather than guessing.
3. **Review and durable save.** Use the existing private approval/activity model
   with exact versioned proposal payloads, explicit date/time review, one durable
   outcome per proposal and source/owner rechecks. Re-read saved outcomes after
   interruption before retrying. Use existing task delivery/quiet hours; extraction
   alone schedules no reminder. Google event writes retain their separate
   permissions, conflict check and exact approval. No forms, emails or transactions.
4. **Source-aware Spaces and deletion.** Add a dedicated capture source reference,
   not a public document link masquerading as a private file. Read source access
   under the caller's RLS each time. Deleting a capture removes the original object,
   extracted private text and unused proposals, with visible handling for saved
   tasks whose source was removed. Sharing a derived task must disclose any copied
   excerpt; sharing the Space alone never widens source access. Do not cache source
   bytes in the PWA service worker or leak signed URLs into logs/model context.

Ship the private upload/preview/delete milestone before extraction. Show its
actual capability clearly; no “Scan complete” or fabricated proposals until
extraction has returned a verified result. Add the dashboard entry only when the
underlying authorized source lifecycle is complete.

## Acceptance checks

- Another household member, including an administrator, cannot read a private
  file, source metadata, OCR text, proposals, signed URL or processing history.
- Invalid MIME/signatures, oversized/decompression-heavy sources, corrupt and
  protected PDFs, duplicated requests and interrupted uploads fail safely.
- Ambiguous dates, no-time deadlines, missing years, multiple dates, timezone/DST
  transitions, low-quality images and prompt-injection text stay reviewable data.
- Approving/retrying the same proposal produces one task; no unapproved proposal
  creates a task or sends an alert. Stale source/version/access changes block save.
- Deletion, sign-out, account changes and cancellation clear browser previews and
  reject late responses. Narrow object deletion cannot remove another source.
- Mobile camera/file picking and desktop PDFs work with keyboard/focus support.
  Tests use synthetic files and mocked OCR/providers, never household documents,
  production model calls or live reminder sends.

Before implementing Storage or schema changes, inspect current bucket/table
configuration and current Supabase docs/advisors. Keep schema/RLS, extraction and
review releases independently reviewable. Provider selection and storage costs
belong in the extraction design; this brief does not enable any new data transfer.
