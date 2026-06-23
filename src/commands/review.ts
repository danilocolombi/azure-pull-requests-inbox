import * as vscode from 'vscode';
import { AuthService } from '../auth/authService';
import { AzureClient } from '../azure/client';
import { getItemTextAt, getPrChangedFiles } from '../azure/diff';
import { PrSummary } from '../azure/pullRequests';
import { getAiBaseUrl, getAiModel } from '../state/config';
import { buildUnifiedDiff } from '../util/unifiedDiff';
import { PullRequestNode } from '../view/treeItems';
import { OpenAiFallback, reviewWithModel } from './polish';

/** Stop adding diffs to the bundle past this, so a huge PR can't blow the prompt budget. */
const MAX_BUNDLE_BYTES = 60 * 1024;
const MAX_FILES = 60;

function asPr(node: unknown): PullRequestNode | undefined {
  return node instanceof PullRequestNode ? node : undefined;
}

async function getFallback(auth: AuthService): Promise<OpenAiFallback | undefined> {
  const apiKey = await auth.getAiApiKey();
  const baseUrl = getAiBaseUrl();
  const model = getAiModel();
  if (apiKey && baseUrl && model) return { apiKey, baseUrl, model };
  return undefined;
}

/**
 * Assemble a Markdown bundle describing the pull request — title, description, branches, the
 * changed-file list, and capped per-file unified diffs — suitable as an AI review prompt.
 */
export async function buildPrBundle(client: AzureClient, pr: PrSummary): Promise<string> {
  const conn = await client.get();
  const git = await conn.getGitApi();
  const full = await git.getPullRequestById(pr.id).catch(() => undefined);
  const description = full?.description?.trim();

  const { baseCommit, sourceCommit, files } = await getPrChangedFiles(
    client,
    pr.repoId,
    pr.id,
    pr.projectName
  );

  const out: string[] = [
    `# Pull Request #${pr.id}: ${pr.title}`,
    `**Repository:** ${pr.projectName}/${pr.repoName}`,
    `**Branches:** ${pr.sourceBranch ?? '?'} → ${pr.targetBranch ?? '?'}`,
    `**Author:** ${pr.authorName}`,
    ''
  ];
  if (description) out.push('## Description', '', description, '');

  out.push(`## Changed files (${files.length})`, '');
  for (const f of files) out.push(`- \`${f.path}\` (${f.change})`);
  out.push('', '## Diff', '');

  let bytes = out.join('\n').length;
  let truncated = false;
  let shown = 0;
  for (const f of files) {
    if (shown >= MAX_FILES || bytes >= MAX_BUNDLE_BYTES) {
      truncated = true;
      break;
    }
    if (f.change === 'rename') continue; // path-only change, no content diff worth showing
    const [oldText, newText] = await Promise.all([
      f.change === 'add' ? Promise.resolve('') : getItemTextAt(client, pr.repoId, pr.projectName, f.path, baseCommit),
      f.change === 'delete' ? Promise.resolve('') : getItemTextAt(client, pr.repoId, pr.projectName, f.path, sourceCommit)
    ]);
    const diff = buildUnifiedDiff(oldText, newText, f.path);
    if (!diff) continue;
    const block = '```diff\n' + diff + '```\n';
    bytes += block.length;
    out.push(block);
    shown++;
  }
  if (truncated) out.push(`\n_(diff truncated — ${files.length - shown} more file(s) not shown)_`);

  return out.join('\n');
}

/** Run an AI review of the PR and open the result as a Markdown preview. */
export async function reviewWithAi(
  client: AzureClient,
  auth: AuthService,
  node: unknown
): Promise<void> {
  const pr = asPr(node)?.pr;
  if (!pr) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Reviewing PR #${pr.id} with AI…` },
    async () => {
      try {
        const bundle = await buildPrBundle(client, pr);
        const review = await reviewWithModel(bundle, await getFallback(auth));
        if (review === undefined) {
          void vscode.window.showErrorMessage(
            'No AI model available. Use a build with Copilot, or run "Azure Pull Requests: Set AI API Key".'
          );
          return;
        }
        const content = `# AI Review — PR #${pr.id}: ${pr.title}\n\n${review}\n`;
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
        await vscode.window.showTextDocument(doc, { preview: true });
        await vscode.commands.executeCommand('markdown.showPreview');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Could not review the pull request: ${msg}`);
      }
    }
  );
}

/** Copy the PR bundle to the clipboard to hand to Claude Code / Copilot Chat. */
export async function copyPrForAi(client: AzureClient, node: unknown): Promise<void> {
  const pr = asPr(node)?.pr;
  if (!pr) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Preparing PR #${pr.id} for AI…` },
    async () => {
      try {
        const bundle = await buildPrBundle(client, pr);
        await vscode.env.clipboard.writeText(bundle);
        void vscode.window.showInformationMessage(
          `Copied PR #${pr.id} (title, description, and diff) — paste it into Claude Code or Copilot Chat.`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Could not prepare the pull request: ${msg}`);
      }
    }
  );
}
