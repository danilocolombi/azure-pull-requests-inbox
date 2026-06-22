import {
  Comment,
  CommentThreadStatus,
  CommentType,
  GitPullRequest,
  PullRequestStatus
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AzureClient } from './client';

/** Set the signed-in user's vote on a pull request. */
export async function setVote(
  client: AzureClient,
  repoId: string,
  prId: number,
  reviewerId: string,
  vote: number
): Promise<void> {
  const conn = await client.get();
  const git = await conn.getGitApi();
  await git.createPullRequestReviewer({ vote }, repoId, prId, reviewerId);
}

/** Reply to an existing thread, or open a new top-level discussion thread. */
export async function addComment(
  client: AzureClient,
  repoId: string,
  prId: number,
  content: string,
  threadId?: number
): Promise<void> {
  const conn = await client.get();
  const git = await conn.getGitApi();
  if (threadId !== undefined) {
    const comment: Comment = { content, commentType: CommentType.Text };
    await git.createComment(comment, repoId, prId, threadId);
    return;
  }
  await git.createThread(
    {
      comments: [{ content, commentType: CommentType.Text }],
      status: CommentThreadStatus.Active
    },
    repoId,
    prId
  );
}

/** Complete (merge) a pull request using the current source-branch tip. */
export async function completePullRequest(
  client: AzureClient,
  repoId: string,
  prId: number,
  deleteSourceBranch: boolean
): Promise<void> {
  const conn = await client.get();
  const git = await conn.getGitApi();
  // Completing needs the commit the PR is being merged from; fetch the live PR for it.
  const pr = await git.getPullRequestById(prId);
  const update: GitPullRequest = {
    status: PullRequestStatus.Completed,
    lastMergeSourceCommit: pr.lastMergeSourceCommit,
    completionOptions: { deleteSourceBranch }
  };
  await git.updatePullRequest(update, repoId, prId);
}

/** Abandon a pull request. */
export async function abandonPullRequest(
  client: AzureClient,
  repoId: string,
  prId: number
): Promise<void> {
  const conn = await client.get();
  const git = await conn.getGitApi();
  await git.updatePullRequest({ status: PullRequestStatus.Abandoned }, repoId, prId);
}
