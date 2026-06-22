import * as vscode from 'vscode';

const SECTION = 'azurePullRequests';

export interface Subscription {
  projectId: string;
  projectName: string;
  order: number;
}

/** Whose pull-request changes to surface a desktop notification for. */
export type NotifyMode = 'off' | 'mine' | 'all';

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

export function getOrganizationUrl(): string {
  return (cfg().get<string>('organizationUrl') ?? '').replace(/\/+$/, '');
}

export async function setOrganizationUrl(url: string): Promise<void> {
  await cfg().update('organizationUrl', url.replace(/\/+$/, ''), vscode.ConfigurationTarget.Global);
}

export function getSubscriptions(): Subscription[] {
  const raw = cfg().get<Subscription[]>('subscriptions') ?? [];
  return [...raw].sort((a, b) => a.order - b.order);
}

export async function setSubscriptions(subs: Subscription[]): Promise<void> {
  const normalized = subs.map((s, i) => ({ ...s, order: i }));
  await cfg().update('subscriptions', normalized, vscode.ConfigurationTarget.Global);
}

export function getReviewIncludeVoted(): boolean {
  return cfg().get<boolean>('reviewIncludeVoted') ?? false;
}

export function getIncludeDrafts(): boolean {
  return cfg().get<boolean>('includeDrafts') ?? true;
}

export function getPollSeconds(): number {
  const n = cfg().get<number>('pollSeconds') ?? 30;
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : 30;
}

export function getNotifyMode(): NotifyMode {
  const v = cfg().get<string>('notifyOnPr') ?? 'mine';
  return v === 'off' || v === 'all' ? v : 'mine';
}

export function getActionsEnabled(): boolean {
  return cfg().get<boolean>('enableActions') ?? false;
}

export async function setActionsEnabled(v: boolean): Promise<void> {
  await cfg().update('enableActions', v, vscode.ConfigurationTarget.Global);
}

/** Base URL for the OpenAI-compatible Polish fallback, e.g. https://api.openai.com/v1. */
export function getAiBaseUrl(): string {
  return (cfg().get<string>('ai.baseUrl') ?? '').trim().replace(/\/+$/, '');
}

/** Model id for the OpenAI-compatible Polish fallback, e.g. gpt-4o-mini. */
export function getAiModel(): string {
  return (cfg().get<string>('ai.model') ?? '').trim();
}

export function getStaleAfterDays(): number {
  const n = cfg().get<number>('staleAfterDays') ?? 7;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
