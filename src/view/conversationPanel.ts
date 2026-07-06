import * as vscode from 'vscode';
import { AuthService } from '../auth/authService';
import { AzureClient } from '../azure/client';
import { addComment, setVote } from '../azure/prActions';
import { getMyId, getThreads, PrSummary } from '../azure/pullRequests';
import { runWriteAction } from '../commands/actions';
import { isAiAvailable, OpenAiFallback, polishDraft } from '../commands/polish';
import { getAiBaseUrl, getAiModel } from '../state/config';
import { markdownToHtml } from '../util/markdown';
import { PullRequestNode } from './treeItems';

interface CommentDto {
  author: string;
  dateLabel: string;
  body: string;
  isMine: boolean;
}

interface ThreadDto {
  id: number;
  resolved: boolean;
  filePath?: string;
  comments: CommentDto[];
}

interface Header {
  id: number;
  title: string;
  repo: string;
  branches: string;
  url: string;
  myVote: number;
  isReviewer: boolean;
}

type State =
  | { kind: 'empty' }
  | { kind: 'loading'; header: Header }
  | { kind: 'loaded'; header: Header; threads: ThreadDto[] }
  | { kind: 'error'; header: Header; message: string };

export class ConversationPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private requestId = 0;
  private lastState: State = { kind: 'empty' };
  private current: PrSummary | undefined;
  private aiAvailable: boolean | undefined;

  constructor(
    private readonly client: AzureClient,
    private readonly auth: AuthService,
    private readonly onChanged: () => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderHtml(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'submitComment') {
        void this.handleSubmit(String(msg.text ?? ''), Number(msg.id), optionalNumber(msg.threadId));
      } else if (msg.type === 'vote') {
        void this.handleVote(Number(msg.id), Number(msg.value));
      } else if (msg.type === 'polish') {
        void this.handlePolish(String(msg.text ?? ''));
      } else if (msg.type === 'previewRequest') {
        this.handlePreview(String(msg.text ?? ''));
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.postCapabilities();
        this.postState(this.lastState);
      }
    });
    void this.postCapabilities();
    this.postState(this.lastState);
  }

  clear(): void {
    this.requestId++;
    this.current = undefined;
    this.setState({ kind: 'empty' });
  }

  refreshComposer(): void {
    this.aiAvailable = undefined;
    void this.postCapabilities();
  }

  private async getFallback(): Promise<OpenAiFallback | undefined> {
    const apiKey = await this.auth.getAiApiKey();
    const baseUrl = getAiBaseUrl();
    const model = getAiModel();
    if (apiKey && baseUrl && model) return { apiKey, baseUrl, model };
    return undefined;
  }

  async showFor(node: PullRequestNode): Promise<void> {
    const pr = node.pr;
    const id = ++this.requestId;
    this.current = pr;
    const header = toHeader(pr);
    this.setState({ kind: 'loading', header });
    if (this.view) this.view.show?.(true);
    try {
      const myId = (await getMyId(this.client)) ?? '';
      const threads = await getThreads(this.client, pr.repoId, pr.id, pr.projectName, myId);
      if (id !== this.requestId) return;
      const dtos: ThreadDto[] = threads.map((t) => ({
        id: t.id,
        resolved: t.resolved,
        filePath: t.filePath,
        comments: t.comments.map((c) => ({
          author: c.author,
          dateLabel: relativeDate(c.publishedDate),
          body: markdownToHtml(c.content),
          isMine: c.isMine
        }))
      }));
      this.setState({ kind: 'loaded', header, threads: dtos });
    } catch (err) {
      if (id !== this.requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ kind: 'error', header, message });
    }
  }

  private async handleSubmit(text: string, id: number, threadId: number | undefined): Promise<void> {
    const pr = this.current;
    const trimmed = text.trim();
    if (!pr || pr.id !== id || !trimmed) return;
    const ok = await runWriteAction(this.auth, this.client, 'post the comment', () =>
      addComment(this.client, pr.repoId, pr.id, trimmed, threadId)
    );
    if (ok === undefined) {
      this.post({ type: 'composerError', message: 'Comment was not posted.' });
      return;
    }
    this.post({ type: 'composerReset' });
    this.onChanged();
    await this.showFor(new PullRequestNode(pr));
  }

  private async handleVote(id: number, value: number): Promise<void> {
    const pr = this.current;
    if (!pr || pr.id !== id) return;
    const myId = await getMyId(this.client);
    if (!myId) return;
    const ok = await runWriteAction(this.auth, this.client, 'set your vote', () =>
      setVote(this.client, pr.repoId, pr.id, myId, value)
    );
    if (ok === undefined) return;
    pr.myVote = value;
    this.onChanged();
    if (this.lastState.kind === 'loaded' || this.lastState.kind === 'loading') {
      this.setState({ ...this.lastState, header: { ...this.lastState.header, myVote: value } });
    }
  }

  private async handlePolish(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const result = await polishDraft(trimmed, await this.getFallback());
      if (result === undefined) {
        this.post({
          type: 'composerError',
          message: 'No AI model available. Run "Azure Pull Requests: Set AI API Key" to use your own model.'
        });
        this.aiAvailable = false;
        void this.postCapabilities();
        return;
      }
      this.post({ type: 'polishResult', text: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'composerError', message });
    }
  }

  private handlePreview(text: string): void {
    const html = text.trim() ? markdownToHtml(text) : '';
    this.post({ type: 'preview', html });
  }

  private async postCapabilities(): Promise<void> {
    if (this.aiAvailable === undefined) this.aiAvailable = await isAiAvailable(await this.getFallback());
    this.post({ type: 'capabilities', canPolish: this.aiAvailable });
  }

  private setState(state: State): void {
    this.lastState = state;
    this.postState(state);
  }

  private postState(state: State): void {
    this.post({ type: 'state', state });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }
}

function toHeader(pr: PrSummary): Header {
  return {
    id: pr.id,
    title: pr.title,
    repo: `${pr.projectName}/${pr.repoName}`,
    branches: pr.sourceBranch && pr.targetBranch ? `${pr.sourceBranch} → ${pr.targetBranch}` : '',
    url: pr.url,
    myVote: pr.myVote,
    isReviewer: pr.relationship === 'review' || pr.reviewers.some((r) => r.vote !== 0)
  };
}

function optionalNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function relativeDate(d: Date | undefined): string {
  if (!d) return '';
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function renderHtml(webview: vscode.Webview): string {
  const n = nonce();
  const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 10px; }
  .empty, .muted { color: var(--vscode-descriptionForeground); }
  .header { padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border, transparent); margin-bottom: 8px; }
  .header .title { font-weight: 600; }
  .header .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 2px; }
  .header a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .header a:hover { text-decoration: underline; }
  .votebar { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .votebar button { border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, rgba(128,128,128,0.35))); background: transparent; color: var(--vscode-foreground); border-radius: 4px; padding: 3px 9px; cursor: pointer; font-size: 0.9em; }
  .votebar button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  .votebar button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .votebar button:disabled { opacity: 0.5; cursor: default; }
  .thread { padding: 8px 10px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 6px; background: var(--vscode-textBlockQuote-background, transparent); }
  .thread + .thread { margin-top: 8px; }
  .thread.resolved { opacity: 0.7; }
  .thread .file { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; word-break: break-all; }
  .thread .badge { font-size: 0.75em; padding: 0 5px; border-radius: 8px; margin-left: 6px; }
  .badge.open { background: var(--vscode-charts-orange, #d18616); color: #fff; }
  .badge.done { background: var(--vscode-charts-green, #388a34); color: #fff; }
  .comment + .comment { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.25)); }
  .comment .meta-row { display: flex; align-items: baseline; }
  .comment .who { font-weight: 600; }
  .comment .when { color: var(--vscode-descriptionForeground); margin-left: 6px; font-size: 0.85em; }
  .comment .body { margin-top: 6px; word-break: break-word; }
  .comment .body > *:first-child { margin-top: 0; }
  .comment .body > *:last-child { margin-bottom: 0; }
  .comment .body p { margin: 0 0 6px; }
  .comment .body ul, .comment .body ol { margin: 0 0 6px; padding-left: 20px; }
  .comment .body img { max-width: 100%; height: auto; border-radius: 4px; display: block; margin: 6px 0; }
  .comment .body a { color: var(--vscode-textLink-foreground); }
  .comment .body code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 0 3px; border-radius: 3px; }
  .comment .body pre { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 6px 8px; border-radius: 4px; overflow-x: auto; }
  .comment .body pre code { background: none; padding: 0; }
  .reply { margin-top: 6px; }
  .reply a { color: var(--vscode-textLink-foreground); font-size: 0.85em; cursor: pointer; }
  .error { color: var(--vscode-errorForeground); }
  #composer { margin-top: 14px; border-top: 1px solid var(--vscode-panel-border, transparent); padding-top: 10px; }
  #replyTo { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  #replyTo a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .toolbar { display: flex; gap: 2px; margin-bottom: 4px; }
  .toolbar button { background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 0.9em; min-width: 26px; }
  .toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
  #draft { width: 100%; box-sizing: border-box; resize: none; overflow-y: auto; min-height: 90px; max-height: 360px; line-height: 1.45; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent)); border-radius: 4px; padding: 6px 8px; }
  #draft:focus { outline: 1px solid var(--vscode-focusBorder); }
  #previewLabel { margin-top: 8px; }
  #preview { margin-top: 4px; padding: 6px 8px; border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 4px; word-break: break-word; }
  #preview > *:first-child { margin-top: 0; }
  #preview > *:last-child { margin-bottom: 0; }
  .composer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  .composer-actions button { border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: var(--vscode-font-size); }
  .composer-actions button:disabled { opacity: 0.5; cursor: default; }
  .composer-actions button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .composer-actions button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .composer-actions button.ghost { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, rgba(128,128,128,0.35))); display: inline-flex; align-items: center; gap: 5px; }
  .composer-actions button.ghost:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .composer-actions .spacer { flex: 1; }
  #composer-msg { margin-top: 6px; font-size: 0.9em; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 4px; }
</style>
</head>
<body>
<div id="root"><div class="empty">Select a pull request to see its conversation.</div></div>
<div id="composer" hidden>
  <div class="votebar" id="votebar">
    <button data-vote="10" title="Approve">👍 Approve</button>
    <button data-vote="5" title="Approve with suggestions">👍 With suggestions</button>
    <button data-vote="-5" title="Wait for author">⏳ Wait</button>
    <button data-vote="-10" title="Reject">👎 Reject</button>
    <button data-vote="0" title="Reset vote">Reset</button>
  </div>
  <div id="replyTo" hidden></div>
  <div class="toolbar">
    <button data-md="bold" title="Bold"><b>B</b></button>
    <button data-md="italic" title="Italic"><i>I</i></button>
    <button data-md="code" title="Inline code">&lt;/&gt;</button>
    <button data-md="ul" title="Bulleted list">&#8226;</button>
    <button data-md="ol" title="Numbered list">1.</button>
    <button data-md="link" title="Link">&#128279;</button>
  </div>
  <textarea id="draft" rows="5" placeholder="Write a comment… Markdown supported."></textarea>
  <div id="previewLabel" class="hint" hidden>Preview</div>
  <div id="preview" hidden></div>
  <div class="composer-actions">
    <button id="polishBtn" class="ghost" title="Rewrite your draft using your own configured AI model" hidden><span>&#10024;</span> Polish</button>
    <span class="spacer"></span>
    <button id="commentBtn" class="primary">Comment</button>
  </div>
  <div class="hint">Ctrl/Cmd+Enter to comment.</div>
  <div id="composer-msg" class="error" hidden></div>
</div>
<script nonce="${n}">
  const TICK = '\\u0060';
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const composer = document.getElementById('composer');
  const votebar = document.getElementById('votebar');
  const replyTo = document.getElementById('replyTo');
  const draft = document.getElementById('draft');
  const preview = document.getElementById('preview');
  const previewLabel = document.getElementById('previewLabel');
  const commentBtn = document.getElementById('commentBtn');
  const polishBtn = document.getElementById('polishBtn');
  const msgEl = document.getElementById('composer-msg');
  let previewTimer = null;

  let caps = { canPolish: false };
  let stateLoaded = false;
  let currentId = null;
  let isReviewer = false;
  let busy = false;
  let replyThreadId = null;

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderHeader(h) {
    return '<div class="header">'
      + '<div class="title">#' + h.id + ' ' + escapeHtml(h.title) + '</div>'
      + '<div class="meta">' + escapeHtml(h.repo) + (h.branches ? ' · ' + escapeHtml(h.branches) : '')
      + ' · <a href="' + escapeHtml(h.url) + '">Open in Azure DevOps</a></div>'
      + '</div>';
  }
  function renderThreads(threads) {
    if (threads.length === 0) return '<div class="empty">No comments yet. Start the conversation below.</div>';
    return threads.map(t => {
      const badge = t.resolved
        ? '<span class="badge done">resolved</span>'
        : '<span class="badge open">open</span>';
      const file = t.filePath ? '<div class="file">' + escapeHtml(t.filePath) + '</div>' : '';
      const comments = t.comments.map(c =>
        '<div class="comment">'
        + '<div class="meta-row"><span class="who">' + escapeHtml(c.author) + '</span><span class="when">' + escapeHtml(c.dateLabel) + '</span></div>'
        + '<div class="body">' + c.body + '</div>'
        + '</div>'
      ).join('');
      return '<div class="thread' + (t.resolved ? ' resolved' : '') + '">'
        + file
        + '<div class="meta-row"><span class="who">Thread</span>' + badge + '</div>'
        + comments
        + '<div class="reply"><a data-reply="' + t.id + '">Reply</a></div>'
        + '</div>';
    }).join('');
  }
  function setReply(id) {
    replyThreadId = id;
    if (id) {
      replyTo.hidden = false;
      replyTo.innerHTML = 'Replying to thread #' + id + ' · <a id="cancelReply">cancel</a>';
      const c = document.getElementById('cancelReply');
      if (c) c.addEventListener('click', () => setReply(null));
      draft.focus();
    } else {
      replyTo.hidden = true;
      replyTo.innerHTML = '';
    }
  }
  function updateVotebar(myVote) {
    Array.prototype.forEach.call(votebar.querySelectorAll('button'), (b) => {
      b.classList.toggle('active', Number(b.getAttribute('data-vote')) === myVote);
    });
    votebar.hidden = !isReviewer;
  }
  function setMsg(text, isError) {
    if (!text) { msgEl.hidden = true; msgEl.textContent = ''; return; }
    msgEl.hidden = false;
    msgEl.textContent = text;
    msgEl.className = isError ? 'error' : 'muted';
  }
  function setBusy(b) {
    busy = b;
    commentBtn.disabled = b;
    polishBtn.disabled = b;
  }
  function render(state) {
    if (state.kind === 'empty') {
      root.innerHTML = '<div class="empty">Select a pull request to see its conversation.</div>';
      stateLoaded = false; currentId = null; composer.hidden = true;
      return;
    }
    if (state.kind === 'loading') {
      root.innerHTML = renderHeader(state.header) + '<div class="muted">Loading…</div>';
      stateLoaded = false;
    } else if (state.kind === 'loaded') {
      root.innerHTML = renderHeader(state.header) + renderThreads(state.threads);
      stateLoaded = true;
      if (currentId !== state.header.id) {
        currentId = state.header.id;
        clearDraft(); setMsg(''); setReply(null);
      }
      bindReplyLinks();
    } else if (state.kind === 'error') {
      root.innerHTML = renderHeader(state.header) + '<div class="error">' + escapeHtml(state.message) + '</div>';
      stateLoaded = false;
    }
    isReviewer = !!state.header.isReviewer;
    composer.hidden = !stateLoaded && state.kind !== 'loading';
    composer.hidden = state.kind === 'empty';
    updateVotebar(state.header.myVote);
    polishBtn.hidden = !caps.canPolish;
  }
  function bindReplyLinks() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-reply]'), (a) => {
      a.addEventListener('click', () => setReply(Number(a.getAttribute('data-reply'))));
    });
  }

  function autoGrow() {
    draft.style.height = 'auto';
    draft.style.height = Math.min(draft.scrollHeight + 2, 360) + 'px';
  }
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const t = draft.value;
      if (!t.trim()) { preview.hidden = true; previewLabel.hidden = true; preview.innerHTML = ''; return; }
      vscode.postMessage({ type: 'previewRequest', text: t });
    }, 250);
  }
  function clearDraft() {
    draft.value = '';
    draft.style.height = '';
    preview.hidden = true; previewLabel.hidden = true; preview.innerHTML = '';
  }
  function insertAt(start, end, text, selStart, selEnd) {
    draft.focus();
    draft.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
      draft.setRangeText(text, start, end, 'end');
    }
    if (selStart != null) draft.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
    autoGrow(); schedulePreview();
  }
  function surround(before, after, placeholder) {
    const start = draft.selectionStart, end = draft.selectionEnd;
    const sel = end > start ? draft.value.slice(start, end) : placeholder;
    const inner = start + before.length;
    insertAt(start, end, before + sel + after, inner, inner + sel.length);
  }
  function prefixLines(makePrefix) {
    const start = draft.selectionStart, end = draft.selectionEnd;
    const sel = end > start ? draft.value.slice(start, end) : 'item';
    const out = sel.split('\\n').map((l, i) => makePrefix(i) + l).join('\\n');
    insertAt(start, end, out);
  }
  function applyMd(kind) {
    if (kind === 'bold') surround('**', '**', 'bold');
    else if (kind === 'italic') surround('*', '*', 'italic');
    else if (kind === 'code') surround(TICK, TICK, 'code');
    else if (kind === 'link') surround('[', '](url)', 'text');
    else if (kind === 'ul') prefixLines(() => '- ');
    else if (kind === 'ol') prefixLines((i) => (i + 1) + '. ');
  }
  Array.prototype.forEach.call(document.querySelectorAll('.toolbar button'), (b) => {
    b.addEventListener('click', () => applyMd(b.getAttribute('data-md')));
  });
  Array.prototype.forEach.call(votebar.querySelectorAll('button'), (b) => {
    b.addEventListener('click', () => {
      if (busy || currentId == null) return;
      vscode.postMessage({ type: 'vote', id: currentId, value: Number(b.getAttribute('data-vote')) });
    });
  });

  function submit() {
    if (busy) return;
    const text = draft.value.trim();
    if (!text || currentId == null) return;
    setBusy(true);
    setMsg('Posting…', false);
    vscode.postMessage({ type: 'submitComment', text: draft.value, id: currentId, threadId: replyThreadId || undefined });
  }
  function polish() {
    if (busy) return;
    const text = draft.value.trim();
    if (!text) return;
    setBusy(true);
    setMsg('Polishing with your AI model…', false);
    vscode.postMessage({ type: 'polish', text: draft.value });
  }
  commentBtn.addEventListener('click', submit);
  polishBtn.addEventListener('click', polish);
  draft.addEventListener('input', () => { autoGrow(); schedulePreview(); });
  draft.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'state') {
      render(m.state);
    } else if (m.type === 'capabilities') {
      caps = { canPolish: !!m.canPolish };
      polishBtn.hidden = !caps.canPolish;
    } else if (m.type === 'composerReset') {
      clearDraft(); setBusy(false); setMsg(''); setReply(null);
    } else if (m.type === 'composerError') {
      setBusy(false); setMsg(m.message || 'Something went wrong.', true);
    } else if (m.type === 'preview') {
      if (m.html) { preview.innerHTML = m.html; preview.hidden = false; previewLabel.hidden = false; }
      else { preview.hidden = true; previewLabel.hidden = true; preview.innerHTML = ''; }
    } else if (m.type === 'polishResult') {
      draft.focus();
      draft.setSelectionRange(0, draft.value.length);
      if (!document.execCommand('insertText', false, m.text)) draft.value = m.text;
      autoGrow(); schedulePreview();
      setBusy(false);
      setMsg('Polished — review and post.', false);
    }
  });
</script>
</body>
</html>`;
}
