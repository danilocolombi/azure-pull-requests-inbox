# Changelog

## 0.3.0

- **Click a PR to review its diff** — selecting a PR in the inbox now opens every changed file
  in VS Code's multi-file diff editor (a GitHub-style "Files changed" page) against the PR's
  merge base, while the conversation panel keeps following the selection. "Open Conversation"
  remains on the row's inline actions and right-click menu, alongside the new **View Changes**.
- Renamed files now diff against their old path instead of appearing as full additions (in both
  the new multi-file view and the per-file diffs under **Files**).

## 0.2.1

- **Dependency updates**: azure-devops-node-api 15, marked 18 (aligned with Azure Boards Inbox),
  TypeScript 6, ESLint 10 (flat config). Wrapped errors from AI features now carry the original
  error as `cause` for better diagnostics. No user-facing changes.

## 0.2.0

The inbox now shows the whole team's activity, not just yours.

- **All PRs, grouped by project** — every active pull request in each subscribed project is
  listed (paged, up to 500 per project), replacing the previous *Needs my review* /
  *My pull requests* buckets.
- **Yours stand out** — PRs needing your review are sorted first with a blue label and ● badge,
  your own PRs follow at normal weight, and everyone else's are dimmed. The activity-bar badge,
  status bar, and notifications still track only what needs you.
- Project groups show `N for you · M open` and auto-expand only when something concerns you.
- Rows now show the repo and author (the project prefix moved to the group header).
- Voting demotes a PR to a dimmed row in place instead of removing it from the tree.
- Checks and unresolved-comment counts load eagerly only for PRs that concern you; other rows
  fetch them on first expand, so the wider view doesn't multiply polling traffic.
- `includeDrafts: false` now hides all drafts (others' drafts show dimmed by default);
  `reviewIncludeVoted` now controls highlighting rather than list membership.
- Known limitation: a PR where you're a reviewer only via a team appears as a regular (dimmed)
  row — Azure DevOps returns team reviewers without expanded membership.

## 0.1.0

Initial release.

- **Needs my review** and **My pull requests** buckets across all subscribed projects.
- Row status: project/repo, draft/conflict markers, your vote, branch-policy checks, and
  unresolved-comment counts.
- Expandable per-PR detail: reviewers and votes, checks, a thread summary, and a **Files** group
  whose entries open a native VS Code side-by-side diff against the PR's merge base (via a
  read-only `azurepr:` virtual document).
- **Review with AI** and **Copy PR for AI** — bundle the PR title, description, and a capped
  unified diff for an in-editor AI review (Copilot / OpenAI-compatible) or hand-off to Claude
  Code / Copilot Chat.
- Conversation panel: read threads (rendered Markdown), reply or start a thread, Markdown
  composer with live preview and optional Polish with AI.
- Write actions, read-only-first: Approve / Approve with suggestions / Wait / Reject / Reset,
  Complete (merge), and Abandon — the first write action prompts for a Code (Read & Write) token.
- Configurable desktop notifications for new review requests and votes on your PRs.
- Dual-published to the VS Code Marketplace and Open VSX.
