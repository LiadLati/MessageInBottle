# Terms of Use, Community Rules, Privacy Policy and Child Safety Standards

**Published at version `1.0`. Effective when published in the App.**

The documents live in `packages/shared/src/policies.ts` as structured content, in English and
left-to-right. One module serves three surfaces — the in-app reader, the public web pages and
the acceptance records — so the text a person was shown, the version stored against their
account and the text at the public URL cannot drift apart. The documents name no operator,
address, company, registration number or jurisdiction, and refer to the product only as
"the App".

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
consent, because the App does no marketing.

`policy_acceptances` (migration `0012`) records one row per document per acceptance: version,
`accepted` or `acknowledged`, whether it happened at registration or later, and the real-clock
time. The rows are written in the same transaction as the account, and the table is append-only
so history survives a version change.

## When a version changes

`accountPolicies` compares each document's latest accepted version with the current one.
Anything different — including never accepted — gates the account: `requirePolicies` answers
`403 policies_required` on chart, friends, bottles, shore, ocean and notifications, and the App
shows the acceptance screen instead of the ocean. Authentication, reading the documents, the
account's standing, appeals, signing out and **deleting the account** stay open throughout.
Nothing is ever carried over silently; accounts that predate the documents have no rows and are
asked on their next sign-in.

Seeded development accounts are created by the seed itself and record the same acceptance
registration would, because they are new accounts rather than pre-existing ones.

## No age restriction

The App has no age gate. There is no date-of-birth field, no age checkbox, no age verification,
no stored verification timestamp and no underage registration block anywhere in the schema, the
API or the interface, and the documents make no claim that users are adults or have been
age-verified. A test walks every production source file and fails on any of those appearing.

Safety rules concerning minors are unconditional for every user: sexual exploitation of minors,
grooming and child sexual abuse material are prohibited absolutely in the Community Rules and in
the Child Safety Standards, which also set out in-app reporting, removal and sanctions, the
handling of valid legal requests, and where to raise a concern.

Not marketing the App to children is a Play Console target-audience and content-rating decision,
not a registration restriction. See the list at the end of this file.

## Account deletion

One transactional, idempotent server operation (`services/deletion.ts`), reachable two ways:

- **In the App:** the account sheet → **Delete account**, which asks for the password again and
  an explicit confirmation.
- **On the web:** `/legal/delete-account`, which explains what happens, then takes the username,
  the password and a required confirmation, all as a plain form post.

Both paths re-authenticate and call the same function. What it does:

- deletes every session, so access ends immediately (a non-active account is also refused by
  `login` and `resolveSession`, independently of the rows);
- deletes password-recovery records;
- clears the username, display name, email address, password, chosen harbour and time zone, and
  replaces the display name other people see on a letter with "Deleted account";
- deletes friendships, friend requests and blocks, so the account leaves discovery and everyone's
  lists;
- deletes notifications, map-marker state and stored idempotency records;
- cancels letters still at sea or adrift in the public ocean, releases the place reserved at the
  destination harbour, records a `cancelled` journey event and clears the text, so no deleted
  account's letter can still be found and opened;
- leaves letters that already reached their recipient with that recipient, as their correspondence;
- leaves moderation cases, reports, violations and appeals in place, under the evidence-retention
  rules in `services/retention.ts`, because an open report, a pending appeal or a restriction
  still in force must outlive the account that caused it.

The account row itself survives as an anonymous marker with `status = 'deleted'` and
`deleted_at` set (migration `0013`). Dropping it would break the foreign keys of letters that
belong to other people. Calling the operation again returns the original deletion and changes
nothing.

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

Support is a `mailto:` link and nothing else — there is no form, no inbox integration, no SMTP
sender and no ticket store in the App, and nothing anywhere holds or asks for a password, an app
password, an OAuth token, SMTP credentials or a verification code for the address. The page says
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

## Still to do in the Play Console (configuration, not code)

These cannot be satisfied by wording or by this repository:

1. **Public policy URL** — point the listing at the deployed `/legal/privacy`. It is already a
   public, non-geofenced HTML page rather than a PDF.
2. **Data Safety form** — complete it so it matches what the App actually collects, shares,
   secures and deletes. The Privacy Policy's section 2 is the inventory to copy from.
3. **Target audience and content rating** — complete both declarations, and do not select
   children as a target audience for a service that shows letters between strangers.
4. **Account deletion declaration** — give the deployed `/legal/delete-account` as the web
   deletion URL; the in-app path already exists.
5. **Developer account verification** — the account holder verifies their identity privately
   with Google. Deliberately not written into the in-app documents.
6. **Store support contact** — give `seayou.support@gmail.com` as the listing's support address,
   and the deployed `/support` as the support URL. Both now exist; only the Play Console entry
   remains.
