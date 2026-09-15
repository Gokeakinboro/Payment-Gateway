---
name: feedback-claude-file-output-location
description: "HARD RULE (Goke 2026-09-15): every Claude deliverable file goes in a CLAUDE folder on the Desktop (C:\\Users\\Goke\\Desktop\\CLAUDE\\), never loose on the Desktop."
metadata:
  node_type: memory
  type: feedback
---

**HARD RULE — stated by Goke 2026-09-15, asked to be "hard coded".**

> "All claude download files should be placed inside the CLAUDE FOLDER on my desktop
> and not on the desktop directly."

## The rule
Every file Claude produces **for Goke** lands in a **`CLAUDE` folder**, never loose on
the Desktop.

- **Local sessions** (his machine — Windows, user `Goke`):
  `C:\Users\Goke\Desktop\CLAUDE\`. Create it if absent. Never write a deliverable
  straight to `C:\Users\Goke\Desktop\`.
- **Remote / web sessions**: no desktop exists in the container — write deliverables
  into a `CLAUDE/` subfolder of the session scratchpad before handing them over.
- **Scope:** deliverables only — generated PDFs, XLSX, DOCX, PNGs, reports, filled
  forms, exports, screenshots. Repo files keep their proper repo paths.

## Why it kept happening
His Desktop is already the working root for several checkouts and loose artefacts
(`Desktop\Payment-Gateway`, `Desktop\Paylode\paylode-full`, `Desktop\paylode-gateway`,
`Desktop\Rail Cost.xlsx`, `Desktop\Paylode\Palmpay_gateway\paylode-keys\`). Dropping
generated files next to those makes it hard to tell what Claude produced from what he
maintains. The `CLAUDE` folder is the separation.

## Honest limit — don't paper over it
The **download location** used by the browser / Claude desktop app is a machine-side
setting. A remote session cannot change it, and no repo rule overrides it: a file Goke
downloads from a web session goes wherever his client is configured to put it. When
that's the cause, **say so and point at the setting** — never silently save elsewhere
and imply the rule was honoured.

For this rule to apply across **all** projects (not just Payment-Gateway), it also
needs to live in his LOCAL global config on his own machine:
`C:\Users\Goke\.claude\CLAUDE.md`. A remote container cannot write that file.

## Where it is hard-coded
- `CLAUDE.md` → section "File output — where Claude's deliverables go" (checked in, so
  it loads for every session working in this repo, local or remote).
- This memory file.

Related: [[feedback-user-workstyle]], [[project-paylode-dev-deploy]].
