import {
  GitPullRequest,
  GitPullRequestSearchCriteria,
  IdentityRefWithVote,
  PullRequestAsyncStatus,
  PullRequestStatus,
  CommentThreadStatus,
  CommentType
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PolicyEvaluationRecord, PolicyEvaluationStatus } from 'azure-devops-node-api/interfaces/PolicyInterfaces';
import { AzureClient } from './client';
import { getOrganizationUrl, Subscription } from '../state/config';

/** The signed-in user's relationship to a pull request; drives sort order and styling. */
export type PrRelationship = 'review' | 'mine' | 'other';
export type PrStatus = 'active' | 'completed' | 'abandoned' | 'unknown';
export type CheckStatus = 'approved' | 'rejected' | 'running' | 'queued' | 'notApplicable' | 'broken';

/** Azure DevOps reviewer vote values. */
export const Vote = {
  approved: 10,
  approvedWithSuggestions: 5,
  noVote: 0,
  waitingForAuthor: -5,
  rejected: -10
} as const;

export interface PrReviewer {
  id: string;
  name: string;
  vote: number;
  isRequired: boolean;
  isContainer: boolean;
}

export interface PrSummary {
  relationship: PrRelationship;
  id: number;
  title: string;
  projectId: string;
  projectName: string;
  repoId: string;
  repoName: string;
  sourceBranch?: string;
  targetBranch?: string;
  isDraft: boolean;
  status: PrStatus;
  authorName: string;
  authorId: string;
  myVote: number;
  hasConflicts: boolean;
  createdDate?: Date;
  reviewers: PrReviewer[];
  url: string;
}

export interface PrCheck {
  name: string;
  status: CheckStatus;
  isBlocking: boolean;
}

export interface PrComment {
  author: string;
  content: string;
  publishedDate?: Date;
  isMine: boolean;
}

export interface PrThread {
  id: number;
  status: CommentThreadStatus;
  resolved: boolean;
  filePath?: string;
  comments: PrComment[];
}

// --- identity ----------------------------------------------------------------

let cachedUserId: string | undefined;

export function resetUserCache(): void {
  cachedUserId = undefined;
}

export async function getMyId(client: AzureClient): Promise<string | undefined> {
  if (cachedUserId) return cachedUserId;
  const conn = await client.get();
  const data = await conn.connect();
  cachedUserId = data.authenticatedUser?.id;
  return cachedUserId;
}

// --- listing -----------------------------------------------------------------

const PAGE_SIZE = 100;
/** Safety cap per project so a huge org can't stall the refresh loop. */
export const MAX_PRS_PER_PROJECT = 500;

/**
 * List every active pull request in one project. `getPullRequestsByProject` searches
 * across every repository in the project, so there is no need to enumerate repositories,
 * and reviewers (with votes) come back inline — the user's relationship to each PR is
 * derived locally from that. Pages until exhausted or MAX_PRS_PER_PROJECT.
 */
export async function listAllPullRequests(
  client: AzureClient,
  sub: Subscription,
  myId: string,
  reviewIncludeVoted: boolean
): Promise<PrSummary[]> {
  const conn = await client.get();
  const git = await conn.getGitApi();
  const criteria: GitPullRequestSearchCriteria = { status: PullRequestStatus.Active };
  const all: GitPullRequest[] = [];
  for (let skip = 0; skip < MAX_PRS_PER_PROJECT; skip += PAGE_SIZE) {
    const page = await git.getPullRequestsByProject(sub.projectName, criteria, undefined, skip, PAGE_SIZE);
    all.push(...(page ?? []));
    if (!page || page.length < PAGE_SIZE) break;
  }
  return all
    .map((pr) => toSummary(pr, sub, myId, reviewIncludeVoted))
    .filter((p): p is PrSummary => !!p);
}

/**
 * `mine` = I created it. `review` = I'm an individual (non-container) reviewer on someone
 * else's non-draft PR and — unless reviewIncludeVoted — haven't voted yet. Everything else
 * in the project is `other`. Team/group reviewer entries come back as containers without
 * expanded membership, so a PR assigned to you only via a team lands in `other`.
 */
export function deriveRelationship(
  s: Pick<PrSummary, 'authorId' | 'isDraft' | 'reviewers' | 'myVote'>,
  myId: string,
  reviewIncludeVoted: boolean
): PrRelationship {
  if (s.authorId === myId) return 'mine';
  const me = s.reviewers.find((r) => !r.isContainer && r.id === myId);
  if (me && !s.isDraft && (reviewIncludeVoted || me.vote === 0)) return 'review';
  return 'other';
}

function toSummary(
  pr: GitPullRequest,
  sub: Subscription,
  myId: string,
  reviewIncludeVoted: boolean
): PrSummary | undefined {
  if (pr.pullRequestId === undefined) return undefined;
  const repoName = pr.repository?.name ?? '';
  const reviewers: PrReviewer[] = (pr.reviewers ?? []).map((r: IdentityRefWithVote) => ({
    id: r.id ?? '',
    name: r.displayName ?? 'Reviewer',
    vote: r.vote ?? 0,
    isRequired: !!r.isRequired,
    isContainer: !!r.isContainer
  }));
  const mine = reviewers.find((r) => r.id === myId);
  const orgUrl = getOrganizationUrl();
  const base = {
    authorId: pr.createdBy?.id ?? '',
    isDraft: !!pr.isDraft,
    reviewers,
    myVote: mine?.vote ?? 0
  };
  return {
    ...base,
    relationship: deriveRelationship(base, myId, reviewIncludeVoted),
    id: pr.pullRequestId,
    title: pr.title ?? `Pull Request ${pr.pullRequestId}`,
    projectId: sub.projectId,
    projectName: sub.projectName,
    repoId: pr.repository?.id ?? '',
    repoName,
    sourceBranch: stripRefHead(pr.sourceRefName),
    targetBranch: stripRefHead(pr.targetRefName),
    status: mapStatus(pr.status),
    authorName: pr.createdBy?.displayName ?? 'Unknown',
    hasConflicts: pr.mergeStatus === PullRequestAsyncStatus.Conflicts,
    createdDate: pr.creationDate ? new Date(pr.creationDate) : undefined,
    url: repoName
      ? `${orgUrl}/${encodeURIComponent(sub.projectName)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`
      : `${orgUrl}/${encodeURIComponent(sub.projectName)}/_pullrequest/${pr.pullRequestId}`
  };
}

// --- branch policies / checks ------------------------------------------------

/**
 * Fetch the branch-policy evaluations (min reviewers, build validation, comment
 * resolution, required reviewers, …) for a pull request. This is the single source of
 * truth for the "checks" badge. Returns [] on any failure — checks are decorative.
 */
export async function getChecks(
  client: AzureClient,
  projectName: string,
  projectId: string,
  prId: number
): Promise<PrCheck[]> {
  try {
    const conn = await client.get();
    const policy = await conn.getPolicyApi();
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
    const records = await policy.getPolicyEvaluations(projectName, artifactId);
    return (records ?? [])
      .map((r: PolicyEvaluationRecord): PrCheck | undefined => {
        const name = r.configuration?.type?.displayName ?? 'Policy';
        if (r.status === PolicyEvaluationStatus.NotApplicable) return undefined;
        return {
          name,
          status: mapCheckStatus(r.status),
          isBlocking: !!r.configuration?.isBlocking
        };
      })
      .filter((c): c is PrCheck => !!c);
  } catch {
    return [];
  }
}

// --- comment threads ---------------------------------------------------------

/**
 * Fetch the discussion threads on a pull request, dropping system threads (vote/ref-update
 * notices) and resolved/empty ones from the count but keeping them available for display.
 */
export async function getThreads(
  client: AzureClient,
  repoId: string,
  prId: number,
  projectName: string,
  myId: string
): Promise<PrThread[]> {
  const conn = await client.get();
  const git = await conn.getGitApi();
  const raw = await git.getThreads(repoId, prId, projectName);
  const threads: PrThread[] = [];
  for (const t of raw ?? []) {
    if (t.isDeleted) continue;
    const comments: PrComment[] = (t.comments ?? [])
      .filter((c) => !c.isDeleted && c.commentType !== CommentType.System && (c.content ?? '').trim())
      .map((c) => ({
        author: c.author?.displayName ?? 'Unknown',
        content: c.content ?? '',
        publishedDate: c.publishedDate ? new Date(c.publishedDate) : undefined,
        isMine: c.author?.id === myId
      }));
    if (comments.length === 0) continue;
    threads.push({
      id: t.id ?? 0,
      status: t.status ?? CommentThreadStatus.Unknown,
      resolved: isResolved(t.status),
      filePath: t.threadContext?.filePath,
      comments
    });
  }
  return threads;
}

export function countUnresolved(threads: PrThread[]): number {
  return threads.filter((t) => !t.resolved).length;
}

// --- mappers -----------------------------------------------------------------

function mapStatus(status: PullRequestStatus | undefined): PrStatus {
  switch (status) {
    case PullRequestStatus.Active:
      return 'active';
    case PullRequestStatus.Completed:
      return 'completed';
    case PullRequestStatus.Abandoned:
      return 'abandoned';
    default:
      return 'unknown';
  }
}

function mapCheckStatus(status: PolicyEvaluationStatus | undefined): CheckStatus {
  switch (status) {
    case PolicyEvaluationStatus.Approved:
      return 'approved';
    case PolicyEvaluationStatus.Rejected:
      return 'rejected';
    case PolicyEvaluationStatus.Running:
      return 'running';
    case PolicyEvaluationStatus.Queued:
      return 'queued';
    case PolicyEvaluationStatus.Broken:
      return 'broken';
    default:
      return 'notApplicable';
  }
}

function isResolved(status: CommentThreadStatus | undefined): boolean {
  switch (status) {
    case CommentThreadStatus.Fixed:
    case CommentThreadStatus.Closed:
    case CommentThreadStatus.WontFix:
    case CommentThreadStatus.ByDesign:
      return true;
    default:
      return false; // Active / Pending / Unknown are treated as open
  }
}

export function stripRefHead(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.replace(/^refs\/heads\//, '');
}
