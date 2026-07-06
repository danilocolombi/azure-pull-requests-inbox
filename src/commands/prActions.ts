import * as vscode from 'vscode';
import { AuthService } from '../auth/authService';
import { AzureClient } from '../azure/client';
import { abandonPullRequest, completePullRequest, setVote } from '../azure/prActions';
import { getMyId } from '../azure/pullRequests';
import { PrTreeProvider } from '../view/prTreeProvider';
import { PullRequestNode } from '../view/treeItems';
import { runWriteAction } from './actions';

function asPr(node: unknown): PullRequestNode | undefined {
  return node instanceof PullRequestNode ? node : undefined;
}

export function openInBrowser(node: unknown): void {
  const pr = asPr(node);
  if (pr) void vscode.env.openExternal(vscode.Uri.parse(pr.pr.url));
}

export async function copyBranchName(node: unknown): Promise<void> {
  const pr = asPr(node);
  if (!pr?.pr.sourceBranch) return;
  await vscode.env.clipboard.writeText(pr.pr.sourceBranch);
  void vscode.window.showInformationMessage(`Copied: ${pr.pr.sourceBranch}`);
}

export async function copyUrl(node: unknown): Promise<void> {
  const pr = asPr(node);
  if (!pr) return;
  await vscode.env.clipboard.writeText(pr.pr.url);
  void vscode.window.showInformationMessage('Copied pull request URL.');
}

export async function copyId(node: unknown): Promise<void> {
  const pr = asPr(node);
  if (!pr) return;
  await vscode.env.clipboard.writeText(`!${pr.pr.id}`);
  void vscode.window.showInformationMessage(`Copied: !${pr.pr.id}`);
}

export async function vote(
  auth: AuthService,
  client: AzureClient,
  provider: PrTreeProvider,
  node: unknown,
  value: number
): Promise<void> {
  const pr = asPr(node);
  if (!pr) return;
  const myId = await getMyId(client);
  if (!myId) {
    void vscode.window.showErrorMessage('Could not resolve your Azure DevOps identity.');
    return;
  }
  const ok = await runWriteAction(auth, client, 'set your vote', () =>
    setVote(client, pr.pr.repoId, pr.pr.id, myId, value)
  );
  if (ok === undefined) return;
  // Leaving a vote usually demotes the PR out of the review queue; reflect that at once.
  provider.markVoted(pr.pr.id, value);
  provider.refresh();
}

export async function complete(
  auth: AuthService,
  client: AzureClient,
  provider: PrTreeProvider,
  node: unknown
): Promise<void> {
  const pr = asPr(node);
  if (!pr) return;
  const choice = await vscode.window.showWarningMessage(
    `Complete (merge) pull request #${pr.pr.id} "${pr.pr.title}"?`,
    { modal: true },
    'Complete',
    'Complete & delete branch'
  );
  if (choice !== 'Complete' && choice !== 'Complete & delete branch') return;
  const deleteBranch = choice === 'Complete & delete branch';
  const ok = await runWriteAction(auth, client, 'complete the pull request', () =>
    completePullRequest(client, pr.pr.repoId, pr.pr.id, deleteBranch)
  );
  if (ok === undefined) return;
  void vscode.window.showInformationMessage(`Pull request #${pr.pr.id} completed.`);
  provider.refresh();
}

export async function abandon(
  auth: AuthService,
  client: AzureClient,
  provider: PrTreeProvider,
  node: unknown
): Promise<void> {
  const pr = asPr(node);
  if (!pr) return;
  const choice = await vscode.window.showWarningMessage(
    `Abandon pull request #${pr.pr.id} "${pr.pr.title}"?`,
    { modal: true },
    'Abandon'
  );
  if (choice !== 'Abandon') return;
  const ok = await runWriteAction(auth, client, 'abandon the pull request', () =>
    abandonPullRequest(client, pr.pr.repoId, pr.pr.id)
  );
  if (ok === undefined) return;
  void vscode.window.showInformationMessage(`Pull request #${pr.pr.id} abandoned.`);
  provider.refresh();
}
