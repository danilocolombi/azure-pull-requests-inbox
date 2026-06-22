import { marked } from 'marked';

/**
 * Render Markdown to HTML for display in a webview. Azure DevOps pull-request
 * comments are stored as Markdown, and the composer also lets people type Markdown,
 * so the same renderer serves both reading and live preview. `breaks: true`
 * preserves the single line breaks people type.
 *
 * The output is shown inside a CSP-locked webview (no inline scripts, no remote
 * script-src), and we additionally strip the few active constructs the CSP doesn't
 * already neutralize so a hostile comment body can't smuggle anything in.
 */
export function markdownToHtml(markdown: string): string {
  const html = marked.parse(markdown.trim(), { gfm: true, breaks: true, async: false });
  return sanitizeHtml((html as string).trim());
}

/** Strip the handful of active constructs the webview CSP doesn't already neutralize. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href)\s*=\s*("\s*(?:javascript|vbscript):[^"]*"|'\s*(?:javascript|vbscript):[^']*')/gi, '$1="#"');
}
