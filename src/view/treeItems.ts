import * as vscode from 'vscode';
import { getStaleAfterDays } from '../state/config';
import { CheckStatus, PrCheck, PrReviewer, PrSummary, Vote } from '../azure/pullRequests';
import { ChangedFile, FileChange } from '../azure/diff';
import { prDecorationUri } from './prDecorations';

export type Node =
  | ProjectNode
  | PullRequestNode
  | ReviewerNode
  | CheckNode
  | ThreadsNode
  | FilesNode
  | FileChangeNode
  | MessageNode;

/** Top-level group: one subscribed project, showing every active PR in it. */
export class ProjectNode extends vscode.TreeItem {
  readonly kind = 'project' as const;
  constructor(
    public readonly projectId: string,
    name: string,
    forYou: number,
    open: number,
    expand: boolean
  ) {
    super(
      name,
      expand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.id = `project:${projectId}`;
    this.contextValue = 'project';
    this.description =
      forYou > 0 ? `${forYou} for you · ${open} open` : `${open} open`;
    this.iconPath = new vscode.ThemeIcon('project');
  }
}

/** Optional per-PR detail filled in lazily after the list loads (or on expand). */
export interface PrDetails {
  checks?: PrCheck[];
  unresolved?: number;
  totalThreads?: number;
}

export class PullRequestNode extends vscode.TreeItem {
  readonly kind = 'pr' as const;
  details: PrDetails = {};

  constructor(public readonly pr: PrSummary) {
    super('', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `pr:${pr.id}`;
    this.apply();
  }

  setDetails(details: PrDetails): void {
    this.details = details;
    this.apply();
  }

  private apply(): void {
    const pr = this.pr;
    this.label = `#${pr.id}  ${pr.title}`;
    this.description = describe(pr, this.details);
    this.iconPath = prIcon(pr);
    this.resourceUri = prDecorationUri(pr);
    this.contextValue = `pr.${pr.relationship}`;
    this.tooltip = prTooltip(pr, this.details);
    // Clicking opens the PR's diffs in the editor; the conversation panel follows the
    // tree selection separately, so both update from a single click.
    this.command = {
      command: 'azurePullRequests.viewChanges',
      title: 'View Changes',
      arguments: [this]
    };
  }
}

export class ReviewerNode extends vscode.TreeItem {
  readonly kind = 'reviewer' as const;
  constructor(reviewer: PrReviewer) {
    super(reviewer.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'reviewer';
    this.description = voteLabel(reviewer.vote) + (reviewer.isRequired ? ' · required' : '');
    this.iconPath = voteIcon(reviewer.vote);
  }
}

export class CheckNode extends vscode.TreeItem {
  readonly kind = 'check' as const;
  constructor(check: PrCheck) {
    super(check.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'check';
    this.description = checkLabel(check.status) + (check.isBlocking ? '' : ' · optional');
    this.iconPath = checkIcon(check.status);
  }
}

export class ThreadsNode extends vscode.TreeItem {
  readonly kind = 'threads' as const;
  constructor(node: PullRequestNode) {
    const unresolved = node.details.unresolved ?? 0;
    const total = node.details.totalThreads ?? 0;
    super(
      total === 0 ? 'No comments yet' : `${unresolved} unresolved of ${total} thread${total > 1 ? 's' : ''}`,
      vscode.TreeItemCollapsibleState.None
    );
    this.contextValue = 'threads';
    this.iconPath = new vscode.ThemeIcon(
      'comment-discussion',
      unresolved > 0 ? color('charts.orange') : undefined
    );
    this.command = {
      command: 'azurePullRequests.openConversation',
      title: 'Open Conversation',
      arguments: [node]
    };
  }
}

export class FilesNode extends vscode.TreeItem {
  readonly kind = 'files' as const;
  constructor(
    public readonly pr: PrSummary,
    count?: number
  ) {
    super('Files', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `files:${pr.id}`;
    this.contextValue = 'files';
    this.iconPath = new vscode.ThemeIcon('files');
    if (typeof count === 'number') this.description = `${count}`;
  }
}

export class FileChangeNode extends vscode.TreeItem {
  readonly kind = 'fileChange' as const;
  constructor(
    file: ChangedFile,
    baseCommit: string,
    sourceCommit: string,
    pr: PrSummary
  ) {
    super(file.path.split('/').pop() ?? file.path, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'fileChange';
    this.description = trimDir(file.path);
    this.resourceUri = vscode.Uri.parse('azurepr-file:/' + file.path);
    this.iconPath = fileChangeIcon(file.change);
    this.tooltip = `${file.path} (${file.change})`;
    this.command = {
      command: 'azurePullRequests.openFileDiff',
      title: 'Open Diff',
      arguments: [{ file, baseCommit, sourceCommit, repoId: pr.repoId, project: pr.projectName, prId: pr.id }]
    };
  }
}

export class MessageNode extends vscode.TreeItem {
  readonly kind = 'message' as const;
  constructor(label: string, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'message';
    if (icon) this.iconPath = new vscode.ThemeIcon(icon);
  }
}

// ---------- formatting helpers ----------

function color(id: string): vscode.ThemeColor {
  return new vscode.ThemeColor(id);
}

function trimDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

function fileChangeIcon(change: FileChange): vscode.ThemeIcon {
  switch (change) {
    case 'add':
      return new vscode.ThemeIcon('diff-added', color('charts.green'));
    case 'delete':
      return new vscode.ThemeIcon('diff-removed', color('charts.red'));
    case 'rename':
      return new vscode.ThemeIcon('diff-renamed', color('charts.blue'));
    default:
      return new vscode.ThemeIcon('diff-modified', color('charts.yellow'));
  }
}

function describe(pr: PrSummary, d: PrDetails): string {
  const parts: string[] = [pr.repoName];
  if (pr.relationship !== 'mine') parts.push(pr.authorName);
  if (pr.isDraft) parts.push('draft');
  else if (pr.status !== 'active') parts.push(pr.status);
  if (pr.hasConflicts) parts.push('⚠ conflicts');

  if (pr.relationship === 'review') {
    const v = voteLabel(pr.myVote);
    if (v) parts.push(v);
  } else {
    parts.push(approvalSummary(pr.reviewers));
  }

  if (d.checks && d.checks.length > 0) parts.push(checksSummary(d.checks));
  if (d.unresolved && d.unresolved > 0) parts.push(`💬 ${d.unresolved}`);

  const stale = staleLabel(pr.createdDate);
  if (stale) parts.push(stale);

  return parts.join('  ·  ');
}

function approvalSummary(reviewers: PrReviewer[]): string {
  const people = reviewers.filter((r) => !r.isContainer);
  if (people.some((r) => r.vote === Vote.rejected)) return '✗ changes requested';
  if (people.some((r) => r.vote === Vote.waitingForAuthor)) return '⧗ waiting';
  const approved = people.filter((r) => r.vote >= Vote.approvedWithSuggestions).length;
  if (people.length === 0) return 'no reviewers';
  return approved === people.length ? `✓ ${approved} approved` : `${approved}/${people.length} approved`;
}

function voteLabel(vote: number): string {
  switch (vote) {
    case Vote.approved:
      return '✓ approved';
    case Vote.approvedWithSuggestions:
      return '✓ approved w/ suggestions';
    case Vote.waitingForAuthor:
      return '⧗ waiting';
    case Vote.rejected:
      return '✗ rejected';
    default:
      return '';
  }
}

function checksSummary(checks: PrCheck[]): string {
  const blocking = checks.filter((c) => c.isBlocking);
  const failing = blocking.filter((c) => c.status === 'rejected' || c.status === 'broken').length;
  const pending = blocking.filter((c) => c.status === 'running' || c.status === 'queued').length;
  if (failing > 0) return `✗ ${failing} check${failing > 1 ? 's' : ''} failing`;
  if (pending > 0) return `⧗ ${pending} check${pending > 1 ? 's' : ''} running`;
  if (blocking.length > 0) return '✓ checks';
  return '';
}

function staleLabel(created: Date | undefined): string {
  const threshold = getStaleAfterDays();
  if (!threshold || !created) return '';
  const days = Math.floor((Date.now() - created.getTime()) / 86_400_000);
  return days >= threshold ? `stale ${days}d` : '';
}

function prIcon(pr: PrSummary): vscode.ThemeIcon {
  if (pr.isDraft) return new vscode.ThemeIcon('git-pull-request-draft', color('disabledForeground'));
  if (pr.status === 'abandoned') return new vscode.ThemeIcon('git-pull-request-closed', color('disabledForeground'));
  if (pr.status === 'completed') return new vscode.ThemeIcon('git-merge', color('testing.iconPassed'));
  // State colors are reserved for rows that concern the user; 'other' rows stay recessive.
  if (pr.relationship === 'other') return new vscode.ThemeIcon('git-pull-request', color('disabledForeground'));
  if (pr.hasConflicts) return new vscode.ThemeIcon('git-pull-request', color('charts.orange'));
  if (pr.myVote === Vote.rejected) return new vscode.ThemeIcon('git-pull-request', color('testing.iconFailed'));
  if (pr.myVote >= Vote.approvedWithSuggestions)
    return new vscode.ThemeIcon('git-pull-request', color('testing.iconPassed'));
  return new vscode.ThemeIcon('git-pull-request', color('charts.blue'));
}

function voteIcon(vote: number): vscode.ThemeIcon {
  switch (vote) {
    case Vote.approved:
    case Vote.approvedWithSuggestions:
      return new vscode.ThemeIcon('check', color('testing.iconPassed'));
    case Vote.waitingForAuthor:
      return new vscode.ThemeIcon('clock', color('charts.orange'));
    case Vote.rejected:
      return new vscode.ThemeIcon('close', color('testing.iconFailed'));
    default:
      return new vscode.ThemeIcon('account', color('disabledForeground'));
  }
}

function checkLabel(status: CheckStatus): string {
  switch (status) {
    case 'approved':
      return 'passed';
    case 'rejected':
      return 'failed';
    case 'broken':
      return 'error';
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
    default:
      return 'n/a';
  }
}

function checkIcon(status: CheckStatus): vscode.ThemeIcon {
  switch (status) {
    case 'approved':
      return new vscode.ThemeIcon('pass-filled', color('testing.iconPassed'));
    case 'rejected':
    case 'broken':
      return new vscode.ThemeIcon('error', color('testing.iconFailed'));
    case 'running':
      return new vscode.ThemeIcon('sync~spin', color('charts.blue'));
    case 'queued':
      return new vscode.ThemeIcon('clock', color('charts.yellow'));
    default:
      return new vscode.ThemeIcon('circle-outline', color('disabledForeground'));
  }
}

function prTooltip(pr: PrSummary, d: PrDetails): vscode.MarkdownString {
  const lines: string[] = [`**#${pr.id}  ${pr.title}**`, `${pr.projectName} / ${pr.repoName}`];
  if (pr.sourceBranch && pr.targetBranch) lines.push(`${pr.sourceBranch} → ${pr.targetBranch}`);
  lines.push(`By ${pr.authorName}`);
  if (pr.relationship === 'review') {
    const v = voteLabel(pr.myVote);
    lines.push(`Your vote: ${v || 'none yet'}`);
  } else {
    lines.push(approvalSummary(pr.reviewers));
  }
  if (d.checks && d.checks.length > 0) lines.push(checksSummary(d.checks));
  if (pr.hasConflicts) lines.push('⚠ Merge conflicts');
  return new vscode.MarkdownString(lines.join('\n\n'));
}
