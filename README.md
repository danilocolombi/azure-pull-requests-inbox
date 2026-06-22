# Azure Pull Requests Inbox

**Your Azure DevOps pull requests, in VS Code's sidebar — the ones on your plate, one click away.**

A real inbox, not a list. Pull requests are grouped by what they need from *you* —
**Needs my review** and **My pull requests** — across every project you subscribe to. Each
row shows live status at a glance: your vote, branch-policy/check results, unresolved comment
count, and merge-conflict state. Expand a PR to see reviewers, checks, and threads inline; open
the conversation panel to read and reply. Vote, comment, and complete or abandon — right from
the editor.

This is the pull-request sibling to
[Azure Boards Inbox](https://marketplace.visualstudio.com/items?itemName=danilocolombi.azure-boards-inbox)
and
[Azure Pipelines Inbox](https://marketplace.visualstudio.com/items?itemName=danilocolombi.azure-pipelines-inbox),
and shares their stack and conventions.

## Features

- **Two buckets, every project** — *Needs my review* (you're a reviewer and haven't voted yet)
  and *My pull requests* (you opened them), pulled from all subscribed projects at once. The
  activity-bar badge and status bar show how many are waiting on your review.
- **Status at a glance** — each row shows `project/repo · status · your vote · checks · 💬 unresolved`,
  with draft, conflict, and stale markers. Icons turn green/red/orange as votes and checks land.
- **Expand for detail** — reviewers and their votes, branch-policy/build checks, and a thread
  summary, fetched lazily and refreshed in place.
- **Conversation panel** — read the discussion (rendered Markdown), reply to a thread or start a
  new one, with a Markdown composer, live preview, and optional **Polish with AI** using your
  own model (Copilot via `vscode.lm`, or any OpenAI-compatible endpoint you configure).
- **Vote & finish from the editor** — Approve / Approve with suggestions / Wait / Reject / Reset,
  plus Complete (merge) and Abandon for your own PRs.
- **Read-only by default** — sign in with a read-only token; the extension only asks for a
  **Code (Read & Write)** token the first time you take a write action.
- **Desktop notifications** — a toast when a new PR lands in your review queue, or when your own
  PR is approved or gets changes requested (configurable: off / mine / all).
- **Works in Cursor, VSCodium, Windsurf** — published to the VS Code Marketplace and Open VSX.

## Quick start

1. Click the **Azure Pull Requests** icon in the activity bar → **Sign in**.
2. Paste your organization URL (e.g. `https://dev.azure.com/contoso`) and a Personal Access
   Token. A read-only token (**Code: Read** + **Project and Team: Read**) is enough to browse,
   review, and get notified.
3. **Manage Subscriptions** and pick the projects whose pull requests you want to see.

To vote, comment, or complete a PR, just do it — the first write action prompts you to swap in a
**Code (Read & Write)** token (a superset, so all read features keep working).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `azurePullRequests.organizationUrl` | `""` | Azure DevOps organization URL. |
| `azurePullRequests.subscriptions` | `[]` | Subscribed projects (managed via the command). |
| `azurePullRequests.reviewIncludeVoted` | `false` | Keep PRs in *Needs my review* after you've voted. |
| `azurePullRequests.includeDrafts` | `true` | Show your draft PRs in *My pull requests*. |
| `azurePullRequests.pollSeconds` | `30` | Refresh interval while the inbox is visible (min 10). |
| `azurePullRequests.notifyOnPr` | `mine` | Desktop notifications: `off` / `mine` / `all`. |
| `azurePullRequests.enableActions` | `false` | Set automatically after your first successful write action. |
| `azurePullRequests.ai.baseUrl` | `""` | OpenAI-compatible base URL for *Polish with AI*. |
| `azurePullRequests.ai.model` | `""` | Model id for the *Polish with AI* fallback. |
| `azurePullRequests.staleAfterDays` | `7` | Flag PRs with no activity for this many days (0 = off). |

## How it works

Azure DevOps has no public push API, so — like its own web UI — this extension polls. While the
inbox is visible it re-fetches your review queue and your open PRs (a single
`getPullRequestsByProject` call per project, which returns reviewers and votes inline), then
fills in branch-policy checks and unresolved-comment counts in the background. Polling stops when
the view is hidden. All data goes through
[`azure-devops-node-api`](https://www.npmjs.com/package/azure-devops-node-api); your PAT is kept
in VS Code's encrypted `SecretStorage`.

## Development

```sh
npm install
npm run build      # esbuild production bundle → dist/extension.js
npm run watch      # esbuild watch; required for F5 Extension Development Host
npm run compile    # tsc --noEmit — the type-check (esbuild does not type-check)
npm run lint
```

Press **F5** to launch the Extension Development Host.

## License

MIT
