import * as vscode from 'vscode';
import { AuthService } from './auth/authService';
import { AzureClient } from './azure/client';
import { PrSummary, resetUserCache, Vote } from './azure/pullRequests';
import { enableActions } from './commands/actions';
import {
  abandon,
  complete,
  copyBranchName,
  copyId,
  copyUrl,
  openInBrowser,
  vote
} from './commands/prActions';
import { copyPrForAi, reviewWithAi } from './commands/review';
import { manageSubscriptions } from './commands/subscriptions';
import { DiffContentProvider, DIFF_SCHEME, openFileDiff } from './view/diffProvider';
import { PollController } from './poll/pollController';
import { getNotifyMode, getSubscriptions } from './state/config';
import { ConversationPanel } from './view/conversationPanel';
import { PrTreeProvider } from './view/prTreeProvider';
import { PullRequestNode } from './view/treeItems';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const auth = new AuthService(context.secrets);
  const client = new AzureClient(auth);

  const setAuthErrorContext = (hasError: boolean) =>
    vscode.commands.executeCommand('setContext', 'azurePullRequests.authError', hasError);
  const provider = new PrTreeProvider(client, (hasError) => void setAuthErrorContext(hasError));
  const panel = new ConversationPanel(client, auth, () => provider.refresh());
  const poll = new PollController(provider);
  context.subscriptions.push({ dispose: () => poll.dispose() });

  const view = vscode.window.createTreeView('azurePullRequests.inbox', {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: false
  });
  context.subscriptions.push(view);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('azurePullRequests.conversation', panel)
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new DiffContentProvider(client))
  );

  // Update the conversation panel as the user moves through the inbox.
  context.subscriptions.push(
    view.onDidChangeSelection((e) => {
      const node = e.selection.find((n): n is PullRequestNode => n instanceof PullRequestNode);
      if (node) void panel.showFor(node);
    })
  );

  poll.setVisible(view.visible);
  context.subscriptions.push(view.onDidChangeVisibility((e) => poll.setVisible(e.visible)));

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'azurePullRequests.inbox.focus';
  context.subscriptions.push(statusBar);

  const updateStatusBar = async () => {
    if (!(await auth.isSignedIn()) || getSubscriptions().length === 0) {
      statusBar.hide();
      view.badge = undefined;
      return;
    }
    const toReview = provider.getReviewCount();
    if (toReview === 0) {
      statusBar.hide();
      view.badge = undefined;
      return;
    }
    statusBar.text = `$(git-pull-request) ${toReview} to review`;
    statusBar.tooltip = `${toReview} pull request${toReview > 1 ? 's' : ''} awaiting your review`;
    statusBar.show();
    view.badge = { value: toReview, tooltip: `${toReview} to review` };
  };

  // --- notifications ---------------------------------------------------------
  let seededNotify = false;
  let prevReviewIds = new Set<number>();
  let prevMineSig = new Map<number, string>();

  const mineSignature = (s: PrSummary): string => {
    const people = s.reviewers.filter((r) => !r.isContainer);
    const approved = people.filter((r) => r.vote >= Vote.approvedWithSuggestions).length;
    const rejected = people.some((r) => r.vote === Vote.rejected);
    const waiting = people.some((r) => r.vote === Vote.waitingForAuthor);
    return `${approved}|${rejected ? 'r' : ''}${waiting ? 'w' : ''}`;
  };

  const notify = (summaries: PrSummary[]) => {
    const mode = getNotifyMode();
    const review = summaries.filter((s) => s.bucket === 'review');
    const mine = summaries.filter((s) => s.bucket === 'mine');
    const reviewIds = new Set(review.map((s) => s.id));
    const mineSig = new Map(mine.map((s) => [s.id, mineSignature(s)]));

    if (seededNotify && mode !== 'off') {
      for (const s of review) {
        if (!prevReviewIds.has(s.id)) {
          void vscode.window
            .showInformationMessage(`Needs your review: #${s.id} ${s.title}`, 'Open in Azure DevOps')
            .then((c) => {
              if (c) void vscode.env.openExternal(vscode.Uri.parse(s.url));
            });
        }
      }
      for (const s of mine) {
        const before = prevMineSig.get(s.id);
        const now = mineSig.get(s.id);
        if (before === undefined || before === now) continue;
        const people = s.reviewers.filter((r) => !r.isContainer);
        const msg = people.some((r) => r.vote === Vote.rejected)
          ? `Changes requested on your PR #${s.id} ${s.title}`
          : people.length > 0 && people.every((r) => r.vote >= Vote.approvedWithSuggestions)
            ? `Your PR #${s.id} ${s.title} was approved`
            : `New review activity on your PR #${s.id} ${s.title}`;
        void vscode.window.showInformationMessage(msg, 'Open in Azure DevOps').then((c) => {
          if (c) void vscode.env.openExternal(vscode.Uri.parse(s.url));
        });
      }
    }
    prevReviewIds = reviewIds;
    prevMineSig = mineSig;
    seededNotify = true;
  };

  // After sign-in/out or a subscription change, re-seed silently on the next data fetch so a
  // freshly populated inbox doesn't toast for every PR that was already there.
  const resetNotifyState = () => {
    seededNotify = false;
    prevReviewIds = new Set();
    prevMineSig = new Map();
  };

  context.subscriptions.push(
    provider.onDidChangeData((summaries) => {
      notify(summaries);
      void updateStatusBar();
    })
  );

  const refreshContext = async () => {
    const signedIn = await auth.isSignedIn();
    provider.setSignedIn(signedIn);
    await vscode.commands.executeCommand('setContext', 'azurePullRequests.signedIn', signedIn);
    await vscode.commands.executeCommand(
      'setContext',
      'azurePullRequests.noSubscriptions',
      getSubscriptions().length === 0
    );
    await updateStatusBar();
  };

  const refreshAll = () => {
    resetNotifyState();
    panel.clear();
    provider.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('azurePullRequests.signIn', async () => {
      if (await auth.promptSignIn()) {
        client.invalidate();
        resetUserCache();
        await refreshContext();
        refreshAll();
        vscode.window.showInformationMessage('Azure Pull Requests: signed in.');
      }
    }),

    vscode.commands.registerCommand('azurePullRequests.updatePat', async () => {
      if (await auth.promptUpdatePat()) {
        client.invalidate();
        resetUserCache();
        await refreshContext();
        refreshAll();
        vscode.window.showInformationMessage('Azure Pull Requests: access token updated.');
      }
    }),

    vscode.commands.registerCommand('azurePullRequests.signOut', async () => {
      await auth.clearPat();
      client.invalidate();
      resetUserCache();
      await refreshContext();
      refreshAll();
      vscode.window.showInformationMessage('Azure Pull Requests: signed out.');
    }),

    vscode.commands.registerCommand('azurePullRequests.refresh', async () => {
      await refreshContext();
      refreshAll();
    }),

    vscode.commands.registerCommand('azurePullRequests.manageSubscriptions', async () => {
      if (!(await auth.isSignedIn())) {
        const choice = await vscode.window.showWarningMessage('Sign in to Azure DevOps first.', 'Sign In');
        if (choice === 'Sign In') await vscode.commands.executeCommand('azurePullRequests.signIn');
        return;
      }
      await manageSubscriptions(client);
      await refreshContext();
      refreshAll();
    }),

    vscode.commands.registerCommand('azurePullRequests.openConversation', async (node) => {
      if (node instanceof PullRequestNode) {
        await panel.showFor(node);
        await vscode.commands.executeCommand('azurePullRequests.conversation.focus');
      }
    }),
    vscode.commands.registerCommand('azurePullRequests.openInBrowser', openInBrowser),
    vscode.commands.registerCommand('azurePullRequests.reviewWithAi', (node) =>
      reviewWithAi(client, auth, node)
    ),
    vscode.commands.registerCommand('azurePullRequests.copyPrForAi', (node) =>
      copyPrForAi(client, node)
    ),
    vscode.commands.registerCommand(
      'azurePullRequests.openFileDiff',
      (arg: {
        file: import('./azure/diff').ChangedFile;
        baseCommit: string;
        sourceCommit: string;
        repoId: string;
        project: string;
        prId: number;
      }) => {
        if (arg?.file) {
          return openFileDiff(arg.file, arg.baseCommit, arg.sourceCommit, arg.repoId, arg.project, arg.prId);
        }
      }
    ),
    vscode.commands.registerCommand('azurePullRequests.copyBranchName', copyBranchName),
    vscode.commands.registerCommand('azurePullRequests.copyUrl', copyUrl),
    vscode.commands.registerCommand('azurePullRequests.copyId', copyId),

    vscode.commands.registerCommand('azurePullRequests.approve', (node) =>
      vote(auth, client, provider, node, Vote.approved)
    ),
    vscode.commands.registerCommand('azurePullRequests.approveWithSuggestions', (node) =>
      vote(auth, client, provider, node, Vote.approvedWithSuggestions)
    ),
    vscode.commands.registerCommand('azurePullRequests.wait', (node) =>
      vote(auth, client, provider, node, Vote.waitingForAuthor)
    ),
    vscode.commands.registerCommand('azurePullRequests.reject', (node) =>
      vote(auth, client, provider, node, Vote.rejected)
    ),
    vscode.commands.registerCommand('azurePullRequests.resetVote', (node) =>
      vote(auth, client, provider, node, Vote.noVote)
    ),

    vscode.commands.registerCommand('azurePullRequests.complete', (node) =>
      complete(auth, client, provider, node)
    ),
    vscode.commands.registerCommand('azurePullRequests.abandon', (node) =>
      abandon(auth, client, provider, node)
    ),

    vscode.commands.registerCommand('azurePullRequests.setAiApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'AI API Key (OpenAI-compatible)',
        prompt: 'Stored securely. Used by "Polish with AI" when no built-in editor model is available.',
        password: true,
        ignoreFocusOut: true
      });
      if (key === undefined) return;
      await auth.setAiApiKey(key.trim());
      panel.refreshComposer();
      vscode.window.showInformationMessage('Azure Pull Requests: AI API key saved.');
    }),

    vscode.commands.registerCommand('azurePullRequests.enableActions', async () => {
      if (await enableActions(auth, client)) await refreshContext();
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('azurePullRequests')) return;
      await refreshContext();
      if (e.affectsConfiguration('azurePullRequests.pollSeconds')) poll.restart();
      if (
        e.affectsConfiguration('azurePullRequests.subscriptions') ||
        e.affectsConfiguration('azurePullRequests.reviewIncludeVoted') ||
        e.affectsConfiguration('azurePullRequests.includeDrafts') ||
        e.affectsConfiguration('azurePullRequests.staleAfterDays')
      ) {
        if (e.affectsConfiguration('azurePullRequests.subscriptions')) resetNotifyState();
        provider.refresh();
      }
      if (
        e.affectsConfiguration('azurePullRequests.ai.baseUrl') ||
        e.affectsConfiguration('azurePullRequests.ai.model')
      ) {
        panel.refreshComposer();
      }
    })
  );

  await refreshContext();
}

export function deactivate(): void {
  // PollController is disposed via context.subscriptions.
}
