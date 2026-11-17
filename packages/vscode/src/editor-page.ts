/**
 * The page of a ProvenFlow editor tab: a webview whose only content is a frame of the editor that
 * `pflow serve` runs on 127.0.0.1. The page passes messages between the extension and the editor
 * (the editor's side is packages/app/src/app/host-frame.ts): those from the frame go to the
 * extension, the extension's go to the frame. No `vscode` import here.
 */

/** The first line `pflow serve` writes (packages/server/src/commands/serve.ts). */
const SERVE_BANNER = /ProvenFlow editor at (http:\/\/127\.0\.0\.1:\d+\/)/;

/** The editor's address in what `pflow serve` printed so far, once it is there. */
export function editorUrlOf(output: string): string | undefined {
    return SERVE_BANNER.exec(output)?.[1];
}

/** The editor's address for a VS Code tab: the editor then talks to the extension (host-frame.ts). */
export function framedEditorUrl(url: string): string {
    return `${url}?host=vscode`;
}

/** The HTML of an editor tab. `nonce` allows its one script and style, and nothing else runs. */
export function editorPageHtml(url: string, nonce: string): string {
    const origin = new URL(url).origin;
    const csp = [`default-src 'none'`, `frame-src ${origin}`, `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; display: block; }</style>
</head>
<body>
<iframe id="editor" title="ProvenFlow editor" src="${framedEditorUrl(url)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const frame = document.getElementById('editor');
const origin = ${JSON.stringify(origin)};
window.addEventListener('message', event => {
    if (event.source === frame.contentWindow) {
        if (event.origin === origin) vscode.postMessage(event.data);
    } else frame.contentWindow.postMessage(event.data, origin);
});
</script>
</body>
</html>
`;
}
