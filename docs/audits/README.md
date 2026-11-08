# Audit reports

Two independent audits of SeaYou, kept here as historical records. Their content is exactly
as committed on their own branches; nothing in these folders has been edited since.

| Folder | Audited commit | Source branch and commit | Verdict |
| --- | --- | --- | --- |
| `pre-deployment-readiness/` | `5ba32c2` | `audit/pre-deployment-readiness` at `9b70f90` | NO-GO, 100 findings |
| `pre-production-rerun/` | `a04526f` | `audit/pre-production-rerun` at `26977d0` | NO-GO on 3 P1s, 55 findings |

Line numbers, file paths and statuses in the reports describe the audited commit, not the
current code. What has been fixed since, and how, is tracked in
[`docs/REMEDIATION.md`](../REMEDIATION.md); the closure of every re-audit finding is in its
"Re-audit closure" section.
