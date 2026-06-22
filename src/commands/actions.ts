import * as vscode from 'vscode';
import { AuthService } from '../auth/authService';
import { resetUserCache } from '../azure/pullRequests';
import { AzureClient, isUnauthorized } from '../azure/client';
import { getActionsEnabled, setActionsEnabled } from '../state/config';

/**
 * Walk the user through replacing the stored token with a Code (Read & Write) one, then
 * invalidate the memoized connection/user and record that actions are enabled. The write
 * PAT is a superset of a read PAT, so it replaces the stored one with no loss of reads.
 */
async function promptWriteUpgrade(
  auth: AuthService,
  client: AzureClient,
  message: string
): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(message, { modal: true }, 'Update Token');
  if (choice !== 'Update Token') return false;

  if (!(await auth.promptWritePat())) return false;
  client.invalidate();
  resetUserCache();
  await setActionsEnabled(true);
  return true;
}

/** Explicit opt-in via the "Enable Write Actions" command (the up-front path). */
export async function enableActions(auth: AuthService, client: AzureClient): Promise<boolean> {
  const ok = await promptWriteUpgrade(
    auth,
    client,
    'Voting, commenting, and completing pull requests needs a Personal Access Token with Code ' +
      '(Read & Write). This is a one-time setup — update your token now to enable these actions?'
  );
  if (ok) void vscode.window.showInformationMessage('Azure Pull Requests: write actions enabled.');
  return ok;
}

/**
 * Optimistic gate for write actions (vote / comment / complete / abandon): the call is
 * tried with the current token first. If it succeeds, the token already has Code
 * (Read & Write), so the setting is flipped silently. Only when Azure rejects the call as
 * unauthorized is the user walked through the write-PAT upgrade, after which the call is
 * retried once. Returns undefined when the user backed out or the action failed (already
 * reported to the user).
 */
export async function runWriteAction<T>(
  auth: AuthService,
  client: AzureClient,
  action: string,
  attempt: () => Promise<T>
): Promise<T | undefined> {
  try {
    const value = await attempt();
    if (!getActionsEnabled()) await setActionsEnabled(true);
    return value;
  } catch (err) {
    if (!isUnauthorized(err)) {
      reportActionError(err, action);
      return undefined;
    }
  }
  const upgraded = await promptWriteUpgrade(
    auth,
    client,
    `Could not ${action}: your token doesn't have the Code (Read & Write) scope. ` +
      'This is a one-time setup — update your token now to continue?'
  );
  if (!upgraded) return undefined;
  try {
    return await attempt();
  } catch (err) {
    reportActionError(err, action);
    return undefined;
  }
}

export function reportActionError(err: unknown, action: string): void {
  if (isUnauthorized(err)) {
    void vscode.window.showErrorMessage(
      `Could not ${action}: your token lacks Code (Read & Write). Run "Azure Pull Requests: Enable Write Actions" to update it.`
    );
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`Could not ${action}: ${msg}`);
}
