# Terms of Use, Community Guidelines and Privacy Policy — status

**Status: WORKING DRAFT (version `0.1-draft`). Not approved legal text. Not released.**

The three documents live in `packages/shared/src/policies.ts` and are rendered by the app from
there, so the version a person is shown is always the version the server records. This file says
how the draft handed over on 2026-09-19 was checked against the product, what was corrected, what
the code now does with the documents, and — most importantly — what still needs a decision before
any of it may be released. Nothing in the open list has been guessed.

## What the app does now

- **Reachable before registration and after.** The sign-in screen links all three documents; the
  registration form links them from its controls; the account sheet (avatar → "Terms and
  privacy") links them again and states what the account accepted and when. `/#terms`,
  `/#guidelines` and `/#privacy` open a document directly.
- **Accessible views.** Structured blocks, never HTML: real headings, lists and tables, Hebrew
  right-to-left inside an English shell, a modal that keeps focus and returns it, and every
  unresolved field as a highlighted `[…]` mark that a screen reader announces as "not yet
  completed". Drafts carry a bilingual banner with the count of open fields and the list of
  statements that depend on unreleased work.
- **Registration.** Two controls, both unchecked to begin with, each a separate decision:
  *accept* the Terms of Use and Community Guidelines; *acknowledge* the Privacy Policy. Both are
  required; the client explains what is missing; the server refuses anything less
  (`RegisterRequestSchema` demands three literal `true` flags plus the versions shown, and
  answers `409 policy_version_stale` if they are not the current ones). No marketing consent,
  because there is no marketing: the only e-mail the service sends is a password-reset link the
  person asked for.
- **Recorded per account.** `policy_acceptances` (migration `0010_policy_acceptances`, additive)
  holds one row per document per acceptance: version, `accepted`/`acknowledged`, where it
  happened (registration or the later update screen) and the real-clock timestamp. The account
  and its three rows are written in one transaction. History is kept; a newer version accepted
  later is a new row.
- **Existing accounts are never treated as having accepted.** Accounts created before this
  change have no rows; their session says `acceptedVersion: null` for every document. While the
  set is a draft nothing is demanded of them — there is nothing final to ask about. Once a
  released set exists, every account whose latest acceptance differs from the current version
  (never-accepted included) is gated: sign-in, the documents, acceptance and sign-out work, every
  other route answers `403 policies_required`, and the app shows the acceptance screen instead
  of the ocean. The same happens after any future version bump.
- **Release is blocked in code, not only in a note.** A production build (`MIB_DEV_MODE=false`)
  refuses registration with `503 policies_not_released` while the set is a draft, so nobody can
  be asked to agree to unfinished text by accident; development builds allow it so the flow
  could be built and tested. A document marked released that still carries an open field stops
  the API from starting (`assertPolicySetServeable`). Releasing is a deliberate code change:
  resolve every marker, set `status: 'released'`, bump `version`, set `effectiveAt`.

## How the draft was checked against the product

Every factual sentence was compared with the code on `main` (and, for reporting and appeals,
with `feature/reporting-and-moderation`, which the documents describe and which must merge
before they can be released). Corrections made:

| Draft said | Product actually does | Text now says |
| --- | --- | --- |
| Rate limits "on sending letters and reports" | Limits exist on registration, sign-in, password recovery and (moderation branch) reports; none on sending | Names the four; states there is no limit on sending |
| "Verify no active payment means" | No payment code, no subscriptions, no payment data anywhere | States it plainly, marker removed |
| "Verify whether marketing exists" | None; no mailing list; only password-reset mail | States it plainly; no marketing control added |
| Account details "e-mail … as required" | E-mail is mandatory at registration, unique, used for recovery; not shown to others | Says so |
| Public map | Shows other people's lost bottles as position and loss time only — no sender, recipient, harbours or text | Says exactly that (the draft implied more) |
| Finder's reading | One reading; recoverable for 15 minutes; then closed; no archive | Confirmed, 15 minutes stated |
| Sunk bottles | Never listed publicly | Confirmed |
| Same-harbour delivery | Immediate | Confirmed |
| Journey timing | Fixed by the server at release; device clock and refreshes irrelevant | Added |
| Technical data "IP, browser data, logs, as collected" | IP used in memory for auth rate limits only, never stored; request log has method/path/status/duration, no IP; no browser/device data beyond the time zone | States exactly that; infrastructure logs left open |
| Cookies / SDKs / pixels "to verify" | No cookies; sessionStorage (session token, unsent draft), localStorage (time zone); no analytics, ads or third-party code; map data bundled, no external tile server by default | States exactly that; external tiles flagged as a deployment choice |
| Security "only what is verified" | scrypt-hashed passwords with per-password salt; hashed session and reset tokens; single-use 30-minute reset tokens; admin role enforced server-side | States those; TLS, storage encryption, backups left open |
| Deletion | No self-service account or letter deletion exists | Says so; manual handling via the (still open) contact channel |
| Minimum age | Not decided, not implemented | Kept as an open marker; never stated as a fact |
| Appeal deadline | None in the product | Kept as an open marker; the code's optional `MIB_APPEAL_WINDOW_DAYS` stays unset |
| Evidence retention | Mechanism exists and is disabled | Says so |
| Blocks | Implemented, enforced both ways | Guideline kept |

The registration section (§ד) and the pre-publication checklist (§ה) of the draft are product
requirements, not user-facing text; they are implemented (§ד) and tracked here (§ה).

## Open before release — needs your decision or a lawyer

Every item below appears in the documents as a `[[…]]` marker. `openItemsOf()` lists them; the
draft banner counts them.

1. **Operator identity and contact.** Legal name, registration number, address, a working support
   address, a privacy address, a security address, and realistic response times. (Terms §1, §2,
   §7; Privacy header, §1, §5, §7.)
2. **Minimum age.** The draft proposes 18+. Nothing enforces or states an age today. Deciding it
   also means deciding how a known minor's account is handled. (Terms §1; Privacy §7.)
3. **Effective dates and legal review.** Both documents carry no effective date; the Privacy Policy
   needs the legal basis per purpose and per target country; the Terms need governing law and
   forum. An Israeli lawyer versed in privacy, digital and consumer law, plus any other target
   jurisdictions, must review before release.
4. **Deployment data inventory.** Hosting provider, reverse proxy, SMTP provider, where the AI
   model runs and who can reach it, whether an external map-tile provider is configured, and any
   transfers outside Israel / the EEA. All deployment-specific; the code cannot know them.
5. **Retention periods.** For accounts, letters and journey history; expired token rows; public
   opening records; technical and support logs; and for moderation evidence (rejected cases,
   revoked violations). The retention engine exists and is off; `docs/ARCHITECTURE.md` carries
   recommended values.
6. **Appeal deadline** (and whether old violations ever stop counting towards a ban). The product
   has no deadline; the documents say so and leave it open.
7. **Deletion process.** No self-service deletion exists. A manual process — identity check,
   backups, the relationship between deletion and evidence of an open report — must be defined
   before the Privacy Policy promises anything.
8. **Merge dependency.** The moderation clauses (reporting, one case per letter, admin decisions,
   the warning/suspension/ban ladder, one appeal, report rate limits) describe
   `feature/reporting-and-moderation`, which is not on `main` yet. They are correct for that
   branch and listed on each document under "depends on". Do not release before it merges.
9. **Language.** The texts are Hebrew inside an English interface. Whether an English version is
   needed, and which one prevails, is a product and legal question.

## Releasing, when the time comes

1. Resolve every `[[…]]` in `packages/shared/src/policies.ts`; `pnpm --filter @mib/shared test`
   fails while a released document still has one.
2. Set each document's `status` to `'released'`, its `version` to a release number (`1.0`), and
   `effectiveAt`.
3. Ship. From that build, registration in production opens; every existing account is asked to
   accept on its next sign-in and is blocked from everything else until it does or signs out.
4. Later changes: bump `version`, set a new `effectiveAt`. Everyone is asked again; earlier
   acceptances stay on record as history.

`MIB_POLICIES_PREVIEW_RELEASED=true` (development only) treats the shipped draft as released so
the existing-account path can be seen in a browser. It has no effect in production.
