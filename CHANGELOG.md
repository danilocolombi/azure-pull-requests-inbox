# Changelog

## Unreleased

- **See diffs** — each PR now has a **Files** group; clicking a file opens a native VS Code
  side-by-side diff against the PR's merge base (via a read-only `azurepr:` virtual document).
- **Review with AI** and **Copy PR for AI** — bundle the PR title, description, and a capped
  unified diff for an in-editor AI review (Copilot / OpenAI-compatible) or hand-off to Claude
  Code / Copilot Chat.
- Fix: notifications no longer flood when you first add subscriptions or sign back in (the
  "seen" state re-seeds silently after sign-in/out and subscription changes).
- Drafts no longer appear in the *Needs my review* bucket.

## 0.1.0

Initial release.

- **Needs my review** and **My pull requests** buckets across all subscribed projects.
- Row status: project/repo, draft/conflict markers, your vote, branch-policy checks, and
  unresolved-comment counts.
- Expandable per-PR detail: reviewers and votes, checks, and a thread summary.
- Conversation panel: read threads (rendered Markdown), reply or start a thread, Markdown
  composer with live preview and optional Polish with AI.
- Write actions, read-only-first: Approve / Approve with suggestions / Wait / Reject / Reset,
  Complete (merge), and Abandon — the first write action prompts for a Code (Read & Write) token.
- Configurable desktop notifications for new review requests and votes on your PRs.
- Dual-published to the VS Code Marketplace and Open VSX.
