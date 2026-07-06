import * as vscode from 'vscode';
import { PrRelationship, PrSummary } from '../azure/pullRequests';

/**
 * PR rows carry a resourceUri on this scheme purely so a FileDecorationProvider can style
 * them: decorations are the only way to tint a tree item's *label* (icons alone are too
 * subtle when most rows are other people's PRs). The relationship travels in the query.
 */
export const PR_DECORATION_SCHEME = 'azurepr-item';

export function prDecorationUri(pr: PrSummary): vscode.Uri {
  return vscode.Uri.from({
    scheme: PR_DECORATION_SCHEME,
    path: `/pr/${pr.id}`,
    query: `rel=${pr.relationship}`
  });
}

export class PrDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== PR_DECORATION_SCHEME) return undefined;
    const rel = new URLSearchParams(uri.query).get('rel') as PrRelationship | null;
    switch (rel) {
      case 'review':
        return {
          badge: '●',
          color: new vscode.ThemeColor('charts.blue'),
          tooltip: 'Needs your review'
        };
      case 'other':
        return { color: new vscode.ThemeColor('disabledForeground') };
      default:
        // 'mine' keeps the default label color and stands out against dimmed 'other' rows.
        return undefined;
    }
  }
}
