# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code / Cursor extension ("Azure Pull Requests Inbox", id `azure-pull-requests-inbox`,
command/config namespace `azurePullRequests.*`) that shows **every active Azure DevOps pull
request** in your subscribed projects in an activity-bar tree, grouped by project, with the ones
that need your review or are yours sorted first and visually highlighted (file decorations), plus
a conversation webview for reading and replying. It is a companion to the author's published
`azure-boards-inbox` and `azure-pipelines-inbox` extensions and mirrors their stack and conventions.

## Commands

```sh
npm install
npm run build      # esbuild production bundle → dist/extension.js (minified, no sourcemap)
npm run watch      # esbuild watch; required for F5 Extension Development Host debugging
npm run compile    # tsc --noEmit — the type-check; esbuild does NOT type-check
npm run lint       # eslint src --ext ts
```

Press **F5** to launch the Extension Development Host. There is no test suite; `npm run compile`
+ `npm run lint` are the full local verification. esbuild strips types without checking them, so
**always run `npm run compile`** — a passing build does not mean the types are sound.

## Architecture

`activate()` in [src/extension.ts](src/extension.ts) wires the service graph, the tree view + the
conversation webview + the status bar, and every command and the config-change listener.

**Service graph:**
- `AuthService` ([src/auth/authService.ts](src/auth/authService.ts)) — PAT in `context.secrets`;
  org URL in settings. "Signed in" = PAT present AND org URL set. `promptWritePat()` overwrites the
  PAT with a Code (Read & Write) one for the opt-in write actions (a superset, so reads keep working).
  Also stores the OpenAI-compatible AI key for Polish.
- `AzureClient` ([src/azure/client.ts](src/azure/client.ts)) — wraps `azure-devops-node-api`, one
  cached `WebApi` keyed by org URL + PAT fingerprint, 30s socket timeout. `invalidate()` after any
  sign-in/PAT change. `isUnauthorized(err)` classifies 401/403 + Azure TF error codes.
- `PrTreeProvider` ([src/view/prTreeProvider.ts](src/view/prTreeProvider.ts)) — the
  `TreeDataProvider`. `refreshData()` fetches **all** active PRs per subscribed project in one paged
  `getPullRequestsByProject` call (no reviewer/creator criteria; reviewers/votes come back inline,
  capped at `MAX_PRS_PER_PROJECT`), derives each PR's relationship locally, sorts each project group
  review → mine → other (then newest), then fills checks + unresolved-comment counts via
  `loadDetails()` (bounded concurrency) — eagerly only for review/mine rows; `other` rows load
  details on first expand. Emits `onDidChangeData` (drives the badge + notifications, both of which
  ignore `other` rows). `markVoted()` re-derives a PR's relationship locally right after a vote.
- `ConversationPanel` ([src/view/conversationPanel.ts](src/view/conversationPanel.ts)) — a
  `WebviewViewProvider` (CSP + nonce, HTML inline) showing the selected PR's threads, a vote bar, and
  a Markdown composer with live preview and Polish with AI. Updated on tree selection or the
  `openConversation` command.
- `PollController` ([src/poll/pollController.ts](src/poll/pollController.ts)) — single self-stopping
  timer that calls `provider.refreshData()` while the inbox is visible (PRs change slowly, so there
  is nothing to "tail" — it just re-fetches). Re-armed via `setVisible(true)`.

**Relationship rules** (`deriveRelationship` in [src/azure/pullRequests.ts](src/azure/pullRequests.ts)):
`mine` = I created it; `review` = I'm an individual (non-container) reviewer on someone else's
non-draft PR and (unless `reviewIncludeVoted`) haven't voted; everything else is `other`. Team/group
reviewer entries are containers without expanded membership, so team-only assignments land in
`other`. `includeDrafts: false` hides all drafts. PR IDs are organization-wide unique, so they key
the detail cache and tree node ids directly.

**Azure API** lives in [src/azure/pullRequests.ts](src/azure/pullRequests.ts) (list via
`getPullRequestsByProject`; checks via `PolicyApi.getPolicyEvaluations` on the
`vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}` artifact; threads via `git.getThreads`, system
threads filtered out) and [src/azure/prActions.ts](src/azure/prActions.ts) (`createPullRequestReviewer`
for votes, `createThread`/`createComment` for comments, `updatePullRequest` for complete/abandon).
`getMyId`/`resetUserCache` memoize the signed-in identity from `conn.connect()`.

**Write actions are read-only-first.** All writes go through `runWriteAction()` in
[src/commands/actions.ts](src/commands/actions.ts): the call is tried optimistically with the current
token; success silently flips `azurePullRequests.enableActions`, and only an unauthorized rejection
prompts for a Code (Read & Write) PAT (then retries once). Mirror this for any new write op.

**Config** is centralized in [src/state/config.ts](src/state/config.ts) — typed getters/setters, all
`ConfigurationTarget.Global` / `application` scope. Don't call `getConfiguration` elsewhere.

**Tree node types** ([src/view/treeItems.ts](src/view/treeItems.ts)): `ProjectNode` → `PullRequestNode`
→ `ReviewerNode` / `CheckNode` / `ThreadsNode`, plus `MessageNode`. This file owns all
status/vote → icon/label formatting. `contextValue`s (`pr.review`, `pr.mine`, `pr.other`) drive the
`when` clauses for the menu contributions in `package.json`. Relationship *label* styling (blue +
`●` badge for review, dimmed for other) comes from the `FileDecorationProvider` in
[src/view/prDecorations.ts](src/view/prDecorations.ts), keyed off each row's `azurepr-item:` resourceUri.

## Publishing

Push a `v*.*.*` git tag (matching `version` in `package.json`) to trigger
[.github/workflows/publish.yml](.github/workflows/publish.yml): type-check, build, package the
`.vsix`, dual-publish to the **VS Code Marketplace** (`VSCE_PAT`) and **Open VSX** (`OVSX_PAT` — what
Cursor/VSCodium/Windsurf install from), then attach the `.vsix` to a GitHub Release. The Marketplace
icon `media/icon.png` is generated by `node scripts/gen-icon.js` (pure Node, no deps).
