import * as vscode from 'vscode';
import { AzureClient, isUnauthorized } from '../azure/client';
import { getPrChangedFiles, PrDiff } from '../azure/diff';
import {
  countUnresolved,
  deriveRelationship,
  getChecks,
  getMyId,
  getThreads,
  listAllPullRequests,
  MAX_PRS_PER_PROJECT,
  PrRelationship,
  PrSummary
} from '../azure/pullRequests';
import {
  getIncludeDrafts,
  getReviewIncludeVoted,
  getSubscriptions,
  Subscription
} from '../state/config';
import {
  CheckNode,
  FileChangeNode,
  FilesNode,
  MessageNode,
  Node,
  PrDetails,
  ProjectNode,
  PullRequestNode,
  ReviewerNode,
  ThreadsNode
} from './treeItems';

const DETAIL_CONCURRENCY = 5;

interface ProjectGroup {
  sub: Subscription;
  nodes: PullRequestNode[];
  truncated: boolean;
}

export class PrTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Fires after a data refresh (the set/status of PRs may have changed). */
  private readonly _onDidChangeData = new vscode.EventEmitter<PrSummary[]>();
  readonly onDidChangeData = this._onDidChangeData.event;

  private signedIn = false;
  private groups: ProjectGroup[] = [];
  private myId: string | undefined;
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
      this.groups = [];
      this.detailCache.clear();
      this.diffCache.clear();
    }
  }

  /** Number of PRs awaiting the user's review — the actionable inbox count. */
  getReviewCount(): number {
    return this.allNodes().filter((n) => n.pr.relationship === 'review').length;
  }

  getAllSummaries(): PrSummary[] {
    return this.allNodes().map((n) => n.pr);
  }

  /**
   * Reflect a just-cast vote immediately: update the local summary, re-derive the
   * relationship (voting normally demotes a PR out of the review queue), and re-sort its
   * project group. The follow-up refresh confirms against the server.
   */
  markVoted(id: number, vote: number): void {
    if (!this.myId) return;
    for (const group of this.groups) {
      const node = group.nodes.find((n) => n.pr.id === id);
      if (!node) continue;
      const pr = node.pr;
      pr.myVote = vote;
      const me = pr.reviewers.find((r) => !r.isContainer && r.id === this.myId);
      if (me) me.vote = vote;
      pr.relationship = deriveRelationship(pr, this.myId, getReviewIncludeVoted());
      group.nodes = group.nodes
        .filter((n) => n.pr.id !== id)
        .concat(this.toNode(pr));
      group.nodes.sort((a, b) => byRelationshipThenNewest(a.pr, b.pr));
      this._onDidChangeData.fire(this.getAllSummaries());
      this._onDidChangeTreeData.fire();
      return;
    }
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
      return this.groups.map((g) => {
        const forYou = g.nodes.filter((n) => n.pr.relationship === 'review').length;
        const expand = g.nodes.some((n) => n.pr.relationship !== 'other');
        return new ProjectNode(g.sub.projectId, g.sub.projectName, forYou, g.nodes.length, expand);
      });
    }
    if (element instanceof ProjectNode) {
      const group = this.groups.find((g) => g.sub.projectId === element.projectId);
      if (!group || group.nodes.length === 0) return [new MessageNode('(no open pull requests)')];
      if (group.truncated) {
        return [...group.nodes, new MessageNode(`(showing first ${MAX_PRS_PER_PROJECT})`)];
      }
      return group.nodes;
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
    // 'other' rows skip the eager detail pass; fetch checks/threads on first expand.
    if (node.pr.relationship === 'other' && !this.detailCache.has(node.pr.id) && this.myId) {
      void this.loadDetails([node], this.myId);
    }
    const children: Node[] = [];
    for (const r of node.pr.reviewers.filter((rv) => !rv.isContainer)) {
      children.push(new ReviewerNode(r));
    }
    for (const c of node.details.checks ?? []) children.push(new CheckNode(c));
    children.push(new ThreadsNode(node));
    children.push(new FilesNode(node.pr, this.diffCache.get(node.pr.id)?.files.length));
    return children;
  }

  /** Fetch (and cache until the next refresh) the changed files for a PR. */
  async getDiff(pr: PrSummary): Promise<PrDiff> {
    let diff = this.diffCache.get(pr.id);
    if (!diff) {
      diff = await getPrChangedFiles(this.client, pr.repoId, pr.id, pr.projectName);
      this.diffCache.set(pr.id, diff);
    }
    return diff;
  }

  /** Lazily fetch the changed files for a PR the first time its Files group is expanded. */
  private async fileChildren(node: FilesNode): Promise<Node[]> {
    const pr = node.pr;
    let diff: PrDiff;
    try {
      diff = await this.getDiff(pr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [new MessageNode(msg, 'error')];
    }
    if (diff.files.length === 0) return [new MessageNode('(no file changes)')];
    return diff.files.map((f) => new FileChangeNode(f, diff.baseCommit, diff.sourceCommit, pr));
  }

  /**
   * Re-fetch every active PR across all subscriptions (one paged call per project) and
   * derive each PR's relationship to the user locally. The list call returns reviewers
   * (and thus votes) inline; checks and unresolved-comment counts are then filled in
   * lazily in the background — eagerly only for rows that concern the user.
   */
  async refreshData(): Promise<void> {
    if (!this.signedIn || getSubscriptions().length === 0) {
      this._onDidChangeData.fire([]);
      this._onDidChangeTreeData.fire();
      return;
    }

    try {
      this.myId = await getMyId(this.client);
    } catch (err) {
      return this.handleError(err);
    }
    const myId = this.myId;
    if (!myId) {
      this.errorMessage = 'Could not resolve your Azure DevOps identity.';
      this._onDidChangeTreeData.fire();
      return;
    }

    const subs = getSubscriptions();
    const includeVoted = getReviewIncludeVoted();
    try {
      const lists = await Promise.all(
        subs.map((s) => listAllPullRequests(this.client, s, myId, includeVoted))
      );
      this.errorMessage = undefined;
      this.onAuthError(false);

      const includeDrafts = getIncludeDrafts();
      this.groups = subs.map((sub, i) => {
        let prs = lists[i];
        if (!includeDrafts) prs = prs.filter((p) => !p.isDraft);
        prs.sort(byRelationshipThenNewest);
        return {
          sub,
          nodes: prs.map((p) => this.toNode(p)),
          truncated: lists[i].length >= MAX_PRS_PER_PROJECT
        };
      });
      this._onDidChangeData.fire(this.getAllSummaries());
      this._onDidChangeTreeData.fire();

      void this.loadDetails(
        this.allNodes().filter((n) => n.pr.relationship !== 'other'),
        myId
      );
    } catch (err) {
      this.handleError(err);
    }
  }

  private allNodes(): PullRequestNode[] {
    return this.groups.flatMap((g) => g.nodes);
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

const RELATIONSHIP_RANK: Record<PrRelationship, number> = { review: 0, mine: 1, other: 2 };

function byRelationshipThenNewest(a: PrSummary, b: PrSummary): number {
  const rank = RELATIONSHIP_RANK[a.relationship] - RELATIONSHIP_RANK[b.relationship];
  if (rank !== 0) return rank;
  return (b.createdDate?.getTime() ?? 0) - (a.createdDate?.getTime() ?? 0);
}
