// The sandbox.html document. The host allowlist travels in an inert JSON script block so the
// proxy script itself stays a constant (and cacheable) string.

import { PROXY_SCRIPT } from './generated/proxy-script.ts';

/** JSON that is safe inside a <script> element: no "</script", no "<!--", no U+2028/2029 surprises. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/[\u2028]/g, '\\u2028')
    .replace(/[\u2029]/g, '\\u2029');
}

export function sandboxHtml(hostOrigins: readonly string[]): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="color-scheme" content="light dark">',
    '<title>Fixwright sandbox</title>',
    '<style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}</style>',
    '</head>',
    '<body>',
    `<script type="application/json" id="fixwright-hosts">${scriptSafeJson(hostOrigins)}</script>`,
    `<script>${PROXY_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
