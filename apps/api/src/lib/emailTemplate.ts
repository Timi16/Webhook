// One layout for every email the service sends, in the dashboard's colours. It uses tables and
// inline styles only, because that is what mail clients render reliably, and no images, so
// nothing is blocked or tracked. Every email also has a plain-text version.

export interface EmailContent {
  /** The line shown next to the subject in an inbox list. */
  preview: string;
  heading: string;
  /** Plain sentences. They are escaped, never treated as HTML. */
  paragraphs: string[];
  /** A one-time code, shown large. */
  code?: string;
  button?: { label: string; url: string };
  /** Small print under the main content. */
  footnote?: string;
}

const INK = "#1B1209";
const MUTED = "#5E5040";
const PAPER = "#FFFDF8";
const BACKGROUND = "#FFF4E6";
const ORANGE = "#E8480C";
const YELLOW = "#FFC633";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderEmail(content: EmailContent): { html: string; text: string } {
  const paragraphs = content.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font:400 16px/1.6 ${FONT};color:${INK};">${escapeHtml(p)}</p>`,
    )
    .join("");
  const code = content.code
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="background:${YELLOW};border:2px solid ${INK};border-radius:14px;padding:14px 22px;font:700 32px/1 ${MONO};letter-spacing:8px;color:${INK};">${escapeHtml(content.code)}</td></tr></table>`
    : "";
  const button = content.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="background:${ORANGE};border:2px solid ${INK};border-radius:999px;"><a href="${escapeHtml(content.button.url)}" style="display:inline-block;padding:13px 26px;font:700 16px/1 ${FONT};color:${INK};text-decoration:none;">${escapeHtml(content.button.label)}</a></td></tr></table><p style="margin:0 0 16px;font:400 13px/1.6 ${FONT};color:${MUTED};">If the button doesn't work, copy this link into your browser:<br><a href="${escapeHtml(content.button.url)}" style="color:${MUTED};word-break:break-all;">${escapeHtml(content.button.url)}</a></p>`
    : "";
  const footnote = content.footnote
    ? `<p style="margin:16px 0 0;padding-top:16px;border-top:2px dashed #EADBC6;font:400 13px/1.6 ${FONT};color:${MUTED};">${escapeHtml(content.footnote)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(content.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${BACKGROUND};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BACKGROUND};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding:0 4px 20px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="background:${ORANGE};border-radius:7px;width:28px;height:28px;text-align:center;font:800 18px/28px ${FONT};color:${PAPER};">w</td>
<td style="padding-left:10px;font:800 20px/28px ${FONT};letter-spacing:-0.5px;color:${INK};">webhook</td>
<td style="padding-left:10px;"><span style="background:${YELLOW};border-radius:4px;padding:2px 6px;font:500 11px/1.4 ${MONO};color:${INK};">testnet</span></td>
</tr></table>
</td></tr>
<tr><td style="background:${PAPER};border:2px solid ${INK};border-radius:22px;padding:28px 28px 24px;">
<h1 style="margin:0 0 16px;font:800 24px/1.2 ${FONT};letter-spacing:-0.5px;color:${INK};">${escapeHtml(content.heading)}</h1>
${paragraphs}${code}${button}${footnote}
</td></tr>
<tr><td style="padding:18px 4px 0;font:400 12px/1.6 ${FONT};color:${MUTED};">
Webhook · payment webhooks for Stellar Testnet. No real money moves.<br>
We will never ask for a secret key (S…). Never share one with anyone.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    ...content.paragraphs,
    ...(content.code ? [content.code] : []),
    ...(content.button ? [content.button.url] : []),
    ...(content.footnote ? [content.footnote] : []),
  ].join("\n\n");

  return { html, text };
}
