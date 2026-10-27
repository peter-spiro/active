import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { favoritePlace, Favorites } from "./favorites";

export class FavoritesPanel
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly favorites: Favorites) {
    this.subscription = favorites.onDidChange(() => {
      this.postRows();
      this.applyBadge();
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = documentHtml(view.webview, renderRows(this.favorites));
    this.applyBadge();
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.webview.onDidReceiveMessage((message: unknown) => {
      this.onMessage(message);
    });
  }

  private applyBadge(): void {
    if (!this.view) {
      return;
    }
    const count = this.favorites.count;
    this.view.badge =
      count > 0
        ? {
            value: count,
            tooltip: count === 1 ? "1 favorite" : `${count} favorites`,
          }
        : undefined;
  }

  private postRows(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: "rows",
      html: renderRows(this.favorites),
    });
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }
    const body = message as { type?: unknown; uri?: unknown };
    if (typeof body.uri !== "string") {
      return;
    }
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(body.uri);
    } catch {
      return;
    }
    if (body.type === "remove") {
      this.favorites.remove(uri);
      return;
    }
    if (body.type === "open") {
      if (this.favorites.isFolder(uri)) {
        const inside = vscode.workspace.getWorkspaceFolder(uri);
        void vscode.commands.executeCommand(
          inside ? "revealInExplorer" : "revealFileInOS",
          uri,
        );
        return;
      }
      void vscode.commands.executeCommand("vscode.open", uri);
    }
  }
}

function renderRows(favorites: Favorites): string {
  const items = favorites.list();
  if (items.length === 0) {
    return `<div class="message">Star an open file, right-click a workspace folder, or use Add Folder for a folder anywhere.</div>`;
  }
  return items.map((uri) => renderRow(uri, favorites.isFolder(uri))).join("");
}

function renderRow(uri: vscode.Uri, folder: boolean): string {
  const place = favoritePlace(uri);
  const id = escapeHtml(uri.toString());
  const description = place.dir
    ? `<span class="desc">${escapeHtml(place.dir)}</span>`
    : "";
  const icon = folder ? FOLDER_ICON : FILE_ICON;
  return `<div class="row" role="treeitem" tabindex="0" data-uri="${id}" title="${escapeHtml(place.tooltip)}"><span class="icon">${icon}</span><span class="label">${escapeHtml(place.name)}</span>${description}<button type="button" class="close" data-remove="1" data-uri="${id}" title="Remove from Favorites" aria-label="Remove from Favorites">${CLOSE_ICON}</button></div>`;
}

function documentHtml(webview: vscode.Webview, rows: string): string {
  const nonce = randomBytes(16).toString("hex");
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--vscode-sideBar-background);
  }
  #list { height: 100%; overflow: auto; padding-top: 2px; }
  .row, .message {
    display: flex;
    align-items: center;
    min-width: 0;
    height: 22px;
    line-height: 22px;
  }
  .row { padding-right: 4px; cursor: pointer; user-select: none; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .icon, .close svg {
    flex: none;
    width: 16px;
    height: 16px;
  }
  .icon { margin-left: 8px; display: flex; }
  .label, .desc, .message {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label {
    margin-left: 6px;
    flex: 0 1 auto;
    min-width: 0;
  }
  .desc {
    margin-left: 8px;
    flex: 0 10000 auto;
    min-width: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .close {
    margin-left: auto;
    display: none;
    border: 0;
    padding: 0;
    width: 22px;
    height: 22px;
    background: transparent;
    color: var(--vscode-icon-foreground);
    cursor: pointer;
  }
  .row:hover .close, .row:focus .close, .close:focus {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .message {
    padding: 4px 12px;
    color: var(--vscode-descriptionForeground);
    height: auto;
    white-space: normal;
  }
</style>
</head>
<body>
  <div id="list" role="tree">${rows}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById("list");

    function fromEvent(target) {
      if (target instanceof Element) return target;
      return target && target.parentElement ? target.parentElement : null;
    }

    list.addEventListener("click", (event) => {
      const target = fromEvent(event.target);
      if (!target) return;
      const remove = target.closest("[data-remove]");
      if (remove) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: "remove", uri: remove.getAttribute("data-uri") });
        return;
      }
      const row = target.closest(".row[data-uri]");
      if (!row) return;
      vscode.postMessage({ type: "open", uri: row.getAttribute("data-uri") });
    });

    list.addEventListener("keydown", (event) => {
      const target = fromEvent(event.target);
      const row = target && target.closest(".row[data-uri]");
      if (!row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        vscode.postMessage({ type: "open", uri: row.getAttribute("data-uri") });
        return;
      }
      const rows = [...list.querySelectorAll(".row[data-uri]")];
      const index = rows.indexOf(row);
      if (event.key === "ArrowDown" && rows[index + 1]) {
        event.preventDefault();
        rows[index + 1].focus();
      } else if (event.key === "ArrowUp" && rows[index - 1]) {
        event.preventDefault();
        rows[index - 1].focus();
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.type !== "rows") return;
      const active = document.activeElement;
      const uri = active && active.getAttribute ? active.getAttribute("data-uri") : "";
      const top = list.scrollTop;
      list.innerHTML = message.html;
      list.scrollTop = top;
      if (!uri) return;
      const next = [...list.querySelectorAll(".row[data-uri]")].find(
        (row) => row.getAttribute("data-uri") === uri,
      );
      if (next) next.focus();
    });
  </script>
</body>
</html>`;
}

const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M4 1.6h5.1L12.4 5v9.4H4z"/><path fill="none" stroke="currentColor" stroke-width="1.2" d="M9 1.6V5h3.4"/></svg>';

const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1.6 3.2h4.7l1.2 1.4h6.9v8.2H1.6z"/></svg>';

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M4 4l8 8M12 4 4 12"/></svg>';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
