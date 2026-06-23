import * as vscode from 'vscode';
import { AzureClient, isUnauthorized } from '../azure/client';
import { getPrChangedFiles, PrDiff } from '../azure/diff';
import {
  countUnresolved,
  getChecks,
  getMyId,
  getThreads,
  listPullRequests,
  PrBucketKind,
  PrSummary
} from '../azure/pullRequests';
import {
  getIncludeDrafts,
  getReviewIncludeVoted,
  getSubscriptions
} from '../state/config';
import {
  BucketNode,
  CheckNode,
  FileChangeNode,
  FilesNode,
  MessageNode,
  Node,
  PrDetails,
  PullRequestNode,
  ReviewerNode,
  ThreadsNode
} from './treeItems';

const DETAIL_CONCURRENCY = 5;

export class PrTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Fires after a data refresh (the set/status of PRs may have changed). */
  private readonly _onDidChangeData = new vscode.EventEmitter<PrSummary[]>();
  readonly onDidChangeData = this._onDidChangeData.event;

  private signedIn = false;
  private buckets: Record<PrBucketKind, PullRequestNode[]> = { review: [], mine: [] };
  private errorMessage: string | undefined;
  private detailCache = new Map<number, PrDetails>();
  private diffCache = new Map<number, PrDiff>();

  constructor(
    private readonly client: AzureClient,
    private readonly onAuthError: (hasError: boolean) => void
  ) {}

  setSignedIn(signedIn: boolean): void {
    this.signedIn = signedIn;
    if (!signedIn) {
      this.buckets = { review: [], mine: [] };
      this.detailCache.clear();
      this.diffCache.clear();
    }
  }

  /** Number of PRs awaiting the user's review — the actionable inbox count. */
  getReviewCount(): number {
    return this.buckets.review.length;
  }

  getAllSummaries(): PrSummary[] {
    return [...this.buckets.review, ...this.buckets.mine].map((n) => n.pr);
  }

  /** Drop a PR from the local model after a vote/complete so the tree updates instantly. */
  removeFromReview(id: number): void {
    this.buckets.review = this.buckets.review.filter((n) => n.pr.id !== id);
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this.detailCache.clear();
    this.diffCache.clear();
    void this.refreshData();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): vscode.ProviderResult<Node[]> {
    if (!this.signedIn) return [];
    if (!element) {
      if (getSubscriptions().length === 0) return [];
      if (this.errorMessage) return [new MessageNode(this.errorMessage, 'error')];
      return [
        new BucketNode('review', this.buckets.review.length),
        new BucketNode('mine', this.buckets.mine.length)
      ];
    }
    if (element instanceof BucketNode) {
      const nodes = this.buckets[element.bucket];
      if (nodes.length === 0) return [new MessageNode('(none)')];
      return nodes;
    }
    if (element instanceof PullRequestNode) {
      return this.prChildren(element);
    }
    if (element instanceof FilesNode) {
      return this.fileChildren(element);
    }
    return [];
  }

  private prChildren(node: PullRequestNode): Node[] {
    const children: Node[] = [];
    for (const r of node.pr.reviewers.filter((rv) => !rv.isContainer)) {
      children.push(new ReviewerNode(r));
    }
    for (const c of node.details.checks ?? []) children.push(new CheckNode(c));
    children.push(new ThreadsNode(node));
    children.push(new FilesNode(node.pr, this.diffCache.get(node.pr.id)?.files.length));
    return children;
  }

  /** Lazily fetch the changed files for a PR the first time its Files group is expanded. */
  private async fileChildren(node: FilesNode): Promise<Node[]> {
    const pr = node.pr;
    let diff = this.diffCache.get(pr.id);
    if (!diff) {
      try {
        diff = await getPrChangedFiles(this.client, pr.repoId, pr.id, pr.projectName);
        this.diffCache.set(pr.id, diff);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [new MessageNode(msg, 'error')];
      }
    }
    if (diff.files.length === 0) return [new MessageNode('(no file changes)')];
    return diff.files.map((f) => new FileChangeNode(f, diff!.baseCommit, diff!.sourceCommit, pr));
  }

  /**
   * Re-fetch both buckets across all subscriptions. The list call returns reviewers (and
   * thus votes) inline; checks and unresolved-comment counts are then filled in lazily in
   * the background and pushed into the rows as they arrive.
   */
  async refreshData(): Promise<void> {
    if (!this.signedIn || getSubscriptions().length === 0) {
      this._onDidChangeData.fire([]);
      this._onDidChangeTreeData.fire();
      return;
    }

    let myId: string | undefined;
    try {
      myId = await getMyId(this.client);
    } catch (err) {
      return this.handleError(err);
    }
    if (!myId) {
      this.errorMessage = 'Could not resolve your Azure DevOps identity.';
      this._onDidChangeTreeData.fire();
      return;
    }

    const subs = getSubscriptions();
    try {
      const [reviewLists, mineLists] = await Promise.all([
        Promise.all(subs.map((s) => listPullRequests(this.client, s, 'review', myId!))),
        Promise.all(subs.map((s) => listPullRequests(this.client, s, 'mine', myId!)))
      ]);
      this.errorMessage = undefined;
      this.onAuthError(false);

      let review = reviewLists.flat().filter((p) => p.authorId !== myId && !p.isDraft);
      if (!getReviewIncludeVoted()) review = review.filter((p) => p.myVote === 0);
      let mine = mineLists.flat();
      if (!getIncludeDrafts()) mine = mine.filter((p) => !p.isDraft);

      review.sort(byNewest);
      mine.sort(byNewest);

      this.buckets = {
        review: review.map((p) => this.toNode(p)),
        mine: mine.map((p) => this.toNode(p))
      };
      this._onDidChangeData.fire(this.getAllSummaries());
      this._onDidChangeTreeData.fire();

      void this.loadDetails([...this.buckets.review, ...this.buckets.mine], myId);
    } catch (err) {
      this.handleError(err);
    }
  }

  private toNode(pr: PrSummary): PullRequestNode {
    const node = new PullRequestNode(pr);
    const cached = this.detailCache.get(pr.id);
    if (cached) node.setDetails(cached);
    return node;
  }

  /** Fetch checks + thread counts for each PR with bounded concurrency, updating rows. */
  private async loadDetails(nodes: PullRequestNode[], myId: string): Promise<void> {
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < nodes.length) {
        const node = nodes[i++];
        const pr = node.pr;
        try {
          const [checks, threads] = await Promise.all([
            getChecks(this.client, pr.projectName, pr.projectId, pr.id),
            getThreads(this.client, pr.repoId, pr.id, pr.projectName, myId)
          ]);
          const details: PrDetails = {
            checks,
            unresolved: countUnresolved(threads),
            totalThreads: threads.length
          };
          this.detailCache.set(pr.id, details);
          node.setDetails(details);
          this._onDidChangeTreeData.fire(node);
        } catch {
          // details are decorative; ignore per-PR failures
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, nodes.length) }, worker));
  }

  private handleError(err: unknown): void {
    if (isUnauthorized(err)) {
      this.onAuthError(true);
      this.errorMessage = undefined;
    } else {
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
    this._onDidChangeTreeData.fire();
  }
}

function byNewest(a: PrSummary, b: PrSummary): number {
  return (b.createdDate?.getTime() ?? 0) - (a.createdDate?.getTime() ?? 0);
}
