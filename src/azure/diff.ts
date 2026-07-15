import {
  GitVersionDescriptor,
  GitVersionType,
  VersionControlChangeType
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AzureClient } from './client';

export type FileChange = 'add' | 'edit' | 'delete' | 'rename';

export interface ChangedFile {
  path: string;
  change: FileChange;
  /** For renames: the path on the base side of the diff. */
  originalPath?: string;
}

export interface PrDiff {
  baseCommit: string;
  sourceCommit: string;
  files: ChangedFile[];
}

/** A file larger than this is truncated when fetched for a diff/prompt. */
const MAX_FILE_BYTES = 256 * 1024;

/**
 * List the files a pull request changes, plus the two commits to diff between: the source
 * branch tip and the merge base (`commonRefCommit`), so the diff shows only the PR's own
 * changes — matching what Azure DevOps renders in its web "Files" tab.
 */
export async function getPrChangedFiles(
  client: AzureClient,
  repoId: string,
  prId: number,
  project: string
): Promise<PrDiff> {
  const conn = await client.get();
  const git = await conn.getGitApi();
  const iterations = await git.getPullRequestIterations(repoId, prId, project);
  const last = iterations?.[iterations.length - 1];
  if (!last?.id) return { baseCommit: '', sourceCommit: '', files: [] };

  const baseCommit = last.commonRefCommit?.commitId ?? last.targetRefCommit?.commitId ?? '';
  const sourceCommit = last.sourceRefCommit?.commitId ?? '';

  const changes = await git.getPullRequestIterationChanges(repoId, prId, last.id, project);
  const files: ChangedFile[] = [];
  for (const c of changes?.changeEntries ?? []) {
    const path = c.item?.path;
    // Skip folders (gitObjectType folder) and entries without a path.
    if (!path || c.item?.isFolder) continue;
    const change = decodeChange(c.changeType);
    files.push({
      path,
      change,
      originalPath: change === 'rename' ? c.sourceServerItem : undefined
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { baseCommit, sourceCommit, files };
}

/**
 * Fetch a file's text at a specific commit. Returns '' when the path doesn't exist at that
 * commit (e.g. the base side of an added file, or the source side of a deleted file), which
 * is exactly what the diff viewer wants for one-sided changes. Content is capped.
 */
export async function getItemTextAt(
  client: AzureClient,
  repoId: string,
  project: string,
  path: string,
  commitId: string
): Promise<string> {
  if (!commitId) return '';
  try {
    const conn = await client.get();
    const git = await conn.getGitApi();
    const versionDescriptor: GitVersionDescriptor = {
      version: commitId,
      versionType: GitVersionType.Commit
    };
    const stream = await git.getItemText(
      repoId,
      path,
      project,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      versionDescriptor,
      true
    );
    const text = await streamToString(stream);
    return text.length > MAX_FILE_BYTES
      ? text.slice(0, MAX_FILE_BYTES) + '\n… (truncated)\n'
      : text;
  } catch {
    return '';
  }
}

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (c) => {
      chunks.push(Buffer.from(c));
      size += c.length;
      // stop pulling absurdly large blobs
      if (size > MAX_FILE_BYTES * 2) (stream as { destroy?: () => void }).destroy?.();
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function decodeChange(type: VersionControlChangeType | undefined): FileChange {
  const t = type ?? 0;
  if (t & VersionControlChangeType.Delete) return 'delete';
  if (t & VersionControlChangeType.Add) return 'add';
  if (t & (VersionControlChangeType.Rename | VersionControlChangeType.SourceRename)) return 'rename';
  return 'edit';
}
