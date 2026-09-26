# Terms of Use, Community Rules, Privacy Policy and Child Safety Standards

**Published at version `1.1`. Effective when published in SeaYou.**

Version 1.1 is a material change carrying the owner's product decisions
(`docs/REMEDIATION.md`, "Decisions"): the 30-day appeal and evidence window, holds, decision
finality, the three moderation decisions and urgent AI flagging, suspension and ban effects,
100-bottle shores, the finder's reading and finder block, unblocking, notification lifetime,
deletion minimisation, time-zone use and fallback, the explicit "email already registered"
message and the 30-minute single-use reset link. Every account that accepted 1.0 is asked to
accept 1.1 through the gate below (`apps/api/src/http/policies.test.ts`).

Before 1.1 was released anywhere, two Privacy Policy sentences were corrected for risk policy v4
(the account's authoritative map clock drives day, night and storm eligibility; the browser keeps
the account's zone as last received from the server). 1.1 had not been published or accepted by
any account, so it was corrected in place rather than superseded by 1.2.

The documents live in `packages/shared/src/policies.ts` as structured content, in English and
left-to-right. One module serves three surfaces — the in-app reader, the public web pages and
the acceptance records — so the text a person was shown, the version stored against their
account and the text at the public URL cannot drift apart. The documents name no operator,
address, company, registration number or jurisdiction, and refer to the product only as
"SeaYou".

## What is published

| Document | Public URL | Accepted at registration? |
| --- | --- | --- |
| Terms of Use | `/legal/terms` | accepted |
| Community Rules | `/legal/community-rules` | accepted |
| Privacy Policy | `/legal/privacy` | acknowledged |
| Child Safety Standards | `/legal/child-safety` | published for reference |
| Delete your account | `/legal/delete-account` | an interactive page, not a document |
| Support | `/support` | a contact page, not a document |

`/legal` lists them all, and every page links to `/support`. Every page is plain server-rendered HTML: no sign-in, no JavaScript,
no PDF, indexable, and readable from a narrow phone upwards. They are served by the API so that
the URL works on its own, which is what a store listing needs.

## Registration consent

Two controls, both unchecked, each its own decision:

1. `I agree to the Terms of Use and Community Rules.`
2. `I have read the Privacy Policy.`

Each document name is a link that opens the full-screen legal view without losing the form.
Both are required. The client explains what is missing and the server refuses independently:
`RegisterRequestSchema.policies` demands three literal `true` flags plus the versions that were
shown, and answers `409 policy_version_stale` if they are not current. There is no marketing
consent, because SeaYou does no marketing.

`policy_acceptances` (migration `0012`) records one row per document per acceptance: version,
`accepted` or `acknowledged`, whether it happened at registration or later, and the real-clock
time. The rows are written in the same transaction as the account, and the table is append-only
so history survives a version change.

## When a version changes

`accountPolicies` compares each document's latest accepted version with the current one.
Anything different — including never accepted — gates the account: `requirePolicies` answers
`403 policies_required` on chart, friends, bottles, shore, ocean and notifications, and SeaYou
shows the acceptance screen instead of the ocean. Authentication, reading the documents, the
account's standing, appeals, signing out and **deleting the account** stay open throughout.
Nothing is ever carried over silently; accounts that predate the documents have no rows and are
asked on their next sign-in.

Seeded development accounts are created by the seed itself and record the same acceptance
registration would, because they are new accounts rather than pre-existing ones.

## No age restriction

SeaYou has no age gate. There is no date-of-birth field, no age checkbox, no age verification,
no stored verification timestamp and no underage registration block anywhere in the schema, the
API or the interface, and the documents make no claim that users are adults or have been
age-verified. A test walks every production source file and fails on any of those appearing.

Safety rules concerning minors are unconditional for every user: sexual exploitation of minors,
grooming and child sexual abuse material are prohibited absolutely in the Community Rules and in
the Child Safety Standards, which also set out in-app reporting, removal and sanctions, the
handling of valid legal requests, and where to raise a concern.

Not marketing SeaYou to children is a Play Console target-audience and content-rating decision,
not a registration restriction. See the list at the end of this file.

## Account deletion

One transactional, idempotent server operation (`services/deletion.ts`), reachable two ways:

- **In SeaYou:** the account sheet → **Delete account**, which asks for the password again and
  an explicit confirmation.
- **On the web:** `/legal/delete-account`, which explains what happens, then takes the username,
  the password and a required confirmation, all as a plain form post.

Both paths re-authenticate and call the same function. What it does:

- deletes every session, so access ends immediately (a non-active account is also refused by
  `login` and `resolveSession`, independently of the rows);
- deletes password-recovery records;
- clears the username, display name, email address, password, chosen harbour, time zone and
  preferences, and shows the account as "Deleted user" wherever someone else's history still
  refers to it (a letter they sent it stays in their Sent history, addressed to "Deleted user");
- deletes friendships, friend requests, blocks, notifications, document acceptances, map-marker
  state and stored idempotency records;
- cancels letters still at sea or adrift in the public ocean, releases the place reserved at the
  destination shore exactly once, and records a `cancelled` journey event;
- erases the text of **every** letter the account wrote — delivered ones too — and removes them
  from recipients' shores and received lists, except a copy held as moderation evidence within
  its retention period or under a legal or child-safety hold;
- removes the letters it received from its own shore and archive;
- leaves moderation cases, reports, violations and appeals in place, under the evidence-retention
  rules in `services/retention.ts`, because an open report, a pending appeal or a restriction
  still in force must outlive the account that caused it.

The account row itself survives as an anonymous marker with `status = 'deleted'` and
`deleted_at` set (migration `0013`). Dropping it would break the foreign keys of letters that
belong to other people. Calling the operation again returns the original deletion and changes
nothing.

## What the documents promise about moderation

Every statement the documents make about moderation is implemented, and has a test. The four
that most often drift are worth naming here, because changing the code without changing these
would make a published document false:

- **The single appeal.** The appeal is offered when the decision notice is presented, and is
  spent only by appealing or by explicitly confirming **Skip appeal**. Closing or reloading
  resolves nothing: the notice is derived from the rows and comes back. See
  `apps/api/src/http/appeals.test.ts`.
- **Violations never expire.** Only an accepted appeal removes one from the count; serving a
  suspension does not. `standingOf` has no time-based forgiveness in it.
- **Thirty-day appeal and evidence window.** An appeal must be filed within 30 days of the
  decision (server time); afterwards the notice says the period has expired. Content evidence
  (letter copy, reporter explanations, AI translation and notes) is redacted 30 days after the
  decision, or when a timely appeal is decided if later; only a documented legal or child-safety
  hold goes past it. See `apps/api/src/services/retention.test.ts` and
  `apps/api/src/http/moderation-decisions.test.ts`.
- **Decisions are final.** No administrator can revoke, reopen or reverse a decision; only the
  sender's appeal changes it. An ordinary violation escalated to critical gets one new appeal if
  none was filed. Automated review never decides; it can only mark a case urgent.
- **Browser storage.** The Privacy Policy lists exactly three things, and
  `apps/web/src/storage.test.ts` walks the source to prove there is no fourth.

## Correction of 2026-09-26 (still version 1.1)

The Terms of Use said a finder's reading "can be resumed for up to 15 minutes if it is
interrupted". The product decision changed to one reading, once, with no resumable period, and
the sentence now says so. Version 1.1 has not been published to any real user (there is no
production deployment yet), so it was corrected in place rather than superseded, as with the
earlier Privacy Policy correction; once a version has been published, a change like this needs a
new version. The Privacy Policy and Child Safety Standards made no timing promise about a
finder's reading and needed no change.

In the same round, sentences joined with a semicolon were split or rejoined with a comma across
all four documents and the account-deletion page, whose list items now read as sentences. Two
semicolons remain, each separating the items of a list whose items already contain commas (the
security records and what remains after deletion, both in the Privacy Policy). The wording also
now says that a possible threat, not only a possible child-safety issue, is marked urgent for a
reviewer, matching the review worker. No right, obligation or practice changed.

Also in the same round, the Terms of Use and Community Rules said that unblocking restores no
friendship. The owner decided that unblocking lifts the block and nothing else: a friendship the
block only hid is visible again, while no letter comes back and no new friendship is created.
The two sentences now say so, matching the code. This one does change a practice, so it is
recorded here explicitly. Like the other corrections, it is made in place because version 1.1 has
not been published to any real user.

## Releasing a new version

1. Edit the documents in `packages/shared/src/policies.ts`.
2. Raise `POLICY_VERSION`.
3. Ship. Every account is asked to accept on its next sign-in and is blocked from ordinary use
   until it does, or signs out, or deletes itself. Earlier acceptances stay on record.

`validatePolicySet` refuses to publish a document that is not released, is not English
left-to-right, has no effective statement, or contains unfinished text (an unresolved `[[…]]`
field, "TBD", "TODO", "placeholder", "draft" or any Hebrew). It runs in the tests and at API
boot, so an unfinished document cannot reach a person.

## Support

`Sea You Support` at `seayou.support@gmail.com`, served at `/support`: public, unauthenticated,
server-rendered, and free of JavaScript, like the legal pages beside it. The address comes from
`MIB_SUPPORT_EMAIL`, which defaults to that address in every environment and can be overridden
in production; the page and all of its links follow the configured value.

Support is a `mailto:` link and nothing else — there is no form, no inbox integration and no
ticket store in SeaYou. The same mailbox *sends* password-reset email when a deployment
configures SMTP; its Gmail App Password is then a deployment secret held only in the host's
secret store (`docs/DEPLOYMENT.md`, section 2a), never in the repository, and nothing in SeaYou
ever asks a person for a password, an app password or a verification code for the address. The page says
plainly that support will never ask for a password, a verification code, Gmail credentials,
payment details or identity documents.

Five headings open the same address with the subject already set, percent-encoded so an em dash
survives every mail client: Account help, Privacy request, Safety or abusive content (subject
"Safety report"), Technical problem, and Other. The address is also shown as selectable text for
a device with no mail client configured.

**Reachable from everywhere it is needed.** `SupportLink` is one component rendering an ordinary
link to `/support` in a new tab, so no gate or restriction can intercept it. It appears in the
account sheet as **Help & Support**, on the sign-in screen, on the policy-acceptance screen, on
the account-standing screen (suspended, banned, and while appealing) and in the account-deletion
dialog. The development server proxies `/support` and `/legal` to the API, giving development
the single origin production serves.

The Terms of Use, Privacy Policy and Child Safety Standards point at `/support` instead of an
unspecified page, and the Privacy Policy and Child Safety Standards name the address itself. No
personal name, address, country, company detail, response-time promise or jurisdiction claim
appears in any of them.

## Upgrading a development database created before the merge

The policy-acceptance migration was briefly numbered `0010` on this branch. When the moderation
branch merged, it was renumbered to `0012`, and a database that had already applied it under the
old number could not tell that the new `0012` was the table it already had. Two things went wrong
on such a database, and both are fixed:

- `0012` was replayed and `CREATE TABLE policy_acceptances` failed, so `db:migrate` and the API
  both refused to start. `0012` is now idempotent (`CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`), so replaying it over the existing table is a no-op.
- More quietly, `0010_reporting_and_moderation` and `0011_evidence_retention` were **skipped
  entirely**. Drizzle compares each journal entry against the single newest recorded migration,
  and the old policy entry's timestamp (1789859116404) is later than both of theirs, so they
  could never run. Such a database would have come up without a single moderation table.

`src/db/compat.ts` fixes both, from `runMigrations` — the one path `db:migrate`, the API, the
seed and every tool share. Before anything is applied it looks for the one stale bookkeeping row,
recognised by the timestamp and content hash the renumbered migration was recorded under. If it
is there, the existing `policy_acceptances` table is checked against the schema that migration
creates — every column with its type, nullability and key, the foreign key to `users`, and the
index and its columns. Only if it matches exactly is the stale row released, which lets Drizzle
replay the migrations it would otherwise skip and re-run `0012` harmlessly. If it does not match,
nothing is touched and the differences are listed.

### Why the same migration has two hashes

Drizzle identifies a recorded migration by the SHA-256 of the migration file's **raw text**, not
by what it does. The repository has no `.gitattributes`, so the bytes on disk depend on the
checkout's line-ending setting, and one commit produces two different files:

| Checkout | Recorded hash |
| --- | --- |
| LF (`core.autocrlf` false or `input` — macOS, Linux) | `66bde2c3…0330286a` |
| CRLF (`core.autocrlf=true`, the Git for Windows default) | `3c5b1613…d0dd8354` |

Both are the same historical file — blob `188b1e55` from commit `c411632`, the one and only
content `0010_policy_acceptances.sql` ever had — so both are recognised, and `compat.test.ts`
re-derives each one through Drizzle's own reader rather than trusting a constant. It also proves
the two renderings create an identical table, foreign key and index, which is what makes accepting
both safe. Any other hash recorded at that timestamp is refused, and the refusal prints the hash
it found so it can be reported without opening the database by hand.

Nothing is dropped, cleared or recreated, and the acceptance rows are counted before and after to
prove they are untouched. Running it twice is a no-op, and a fresh database is unaffected. After
migrating, `assertSchemaComplete` checks that every table and column the journal promises is
present, so a silently skipped migration is reported at once instead of surfacing later as a
confusing runtime error.

To upgrade an affected database:

```bash
git pull
pnpm install
pnpm --filter @mib/api db:migrate   # prints what it kept, if the compatibility step applied
pnpm dev
```

## Still to do in the Play Console (configuration, not code)

These cannot be satisfied by wording or by this repository:

1. **Public policy URL** — point the listing at the deployed `/legal/privacy`. It is already a
   public, non-geofenced HTML page rather than a PDF.
2. **Data Safety form** — complete it so it matches what SeaYou actually collects, shares,
   secures and deletes. The Privacy Policy's section 2 is the inventory to copy from. Points
   version 1.1 changed:
   - *Collected:* email address (account management, password reset), user IDs, in-app
     messages (letters), and the device time zone (app functionality — no location permission,
     not precise or approximate location).
   - *Shared:* none for advertising or analytics. Password-reset email passes through the
     operator's email provider (Gmail) as a service provider; say so if the form asks.
   - *Retention:* notifications kept for the life of the account; operational delivery and
     worker logs up to 90 days; moderation evidence 30 days from the decision (longer only for a
     timely appeal or a legal or child-safety hold).
   - *Deletion:* users can request deletion in the app and on the web; authored letter text,
     received letters, notifications, identifiers and credentials are deleted; a minimal
     anonymous tombstone and audit records remain.
   - *Encryption in transit:* yes, once deployed behind HTTPS.
3. **Target audience and content rating** — complete both declarations, and do not select
   children as a target audience for a service that shows letters between strangers.
4. **Account deletion declaration** — give the deployed `/legal/delete-account` as the web
   deletion URL; the in-app path already exists.
5. **Developer account verification** — the account holder verifies their identity privately
   with Google. Deliberately not written into the in-app documents.
6. **Store support contact** — give `seayou.support@gmail.com` as the listing's support address,
   and the deployed `/support` as the support URL. Both now exist; only the Play Console entry
   remains.
