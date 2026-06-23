import * as vscode from 'vscode';
import { AzureClient } from '../azure/client';
import { ChangedFile, getItemTextAt } from '../azure/diff';

export const DIFF_SCHEME = 'azurepr';

/**
 * Serves file contents for the diff editor as read-only virtual documents. Each URI encodes
 * the repo, project, file path, and the commit to read at; the body is fetched on demand via
 * the Git API (empty when the path doesn't exist at that commit — e.g. one side of an add or
 * delete). VS Code computes the actual diff between the two documents.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly client: AzureClient) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const repoId = q.get('repo') ?? '';
    const project = q.get('project') ?? '';
    const commit = q.get('commit') ?? '';
    const path = uri.path; // the file path, kept human-readable in the editor title
    return getItemTextAt(this.client, repoId, project, path, commit);
  }
}

function blobUri(
  repoId: string,
  project: string,
  path: string,
  commit: string,
  side: 'base' | 'source'
): vscode.Uri {
  const query = new URLSearchParams({ repo: repoId, project, commit, side }).toString();
  return vscode.Uri.from({ scheme: DIFF_SCHEME, path, query });
}

/** Open the native side-by-side diff for one changed file (merge base ↔ source tip). */
export async function openFileDiff(
  file: ChangedFile,
  baseCommit: string,
  sourceCommit: string,
  repoId: string,
  project: string,
  prId: number
): Promise<void> {
  const left = blobUri(repoId, project, file.path, baseCommit, 'base');
  const right = blobUri(repoId, project, file.path, sourceCommit, 'source');
  const name = file.path.split('/').pop() ?? file.path;
  await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (PR #${prId})`, {
    preview: true
  });
}
