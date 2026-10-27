import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export type BranchRow = {
  name: string;
  current: boolean;
  detail: string;
  title: string;
  removable?: boolean;
};

export interface BranchSource {
  readonly rows: readonly BranchRow[];
  readonly message: string;
  readonly onDidChange: vscode.Event<void>;
  refresh(): void;
  switchTo(name: string): Promise<void>;
  deleteBranch?(name: string): Promise<void>;
}

export class BranchListPanel
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly source: BranchSource,
    private readonly countNoun: string,
  ) {
    this.subscription = source.onDidChange(() => {
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
    view.webview.html = documentHtml(view.webview, render(this.source));
    this.applyBadge();
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.source.refresh();
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
    const count = this.source.rows.length;
    this.view.badge =
      count > 0
        ? {
            value: count,
            tooltip: `${count} ${count === 1 ? this.countNoun : `${this.countNoun}s`}`,
          }
        : undefined;
  }

  private postRows(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: "rows",
      html: render(this.source),
    });
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }
    const body = message as { type?: unknown; branch?: unknown };
    if (body.type === "switch" && typeof body.branch === "string") {
      void this.source.switchTo(body.branch);
      return;
    }
    if (
      body.type === "delete" &&
      typeof body.branch === "string" &&
      this.source.deleteBranch
    ) {
      void this.source.deleteBranch(body.branch);
    }
  }
}

function render(source: BranchSource): string {
  if (source.rows.length === 0) {
    return `<div class="message">${escapeHtml(source.message)}</div>`;
  }
  const removable = typeof source.deleteBranch === "function";
  return source.rows.map((row) => renderRow(row, removable)).join("");
}

function renderRow(row: BranchRow, removable: boolean): string {
  const current = row.current ? " current" : "";
  const desc = row.detail
    ? `<span class="desc">${escapeHtml(row.detail)}</span>`
    : "";
  const name = escapeHtml(row.name);
  const remove =
    removable && row.removable !== false
      ? `<button type="button" class="remove" data-delete="1" data-branch="${name}" title="Delete branch" aria-label="Delete branch">${TRASH_ICON}</button>`
      : "";
  return `<div class="row${current}" role="treeitem" tabindex="0" data-branch="${name}" title="${escapeHtml(row.title)}" aria-current="${row.current ? "true" : "false"}"><span class="label">${name}</span>${desc}${remove}</div>`;
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
  .row { padding: 0 4px 0 8px; cursor: pointer; user-select: none; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.current {
    background: var(--vscode-list-inactiveSelectionBackground);
    color: var(--vscode-list-inactiveSelectionForeground);
  }
  .row:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .label, .desc, .message {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label { flex: 0 1 auto; min-width: 0; }
  .row.current .label { font-weight: 600; }
  .desc {
    margin-left: 8px;
    flex: 0 10000 auto;
    min-width: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .remove {
    margin-left: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border: 0;
    padding: 0;
    width: 22px;
    height: 22px;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
  }
  .remove svg { width: 16px; height: 16px; }
  .remove:hover, .remove:focus { color: var(--vscode-icon-foreground); }
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

    function choose(row) {
      const branch = row.getAttribute("data-branch");
      if (!branch || row.classList.contains("current")) return;
      vscode.postMessage({ type: "switch", branch });
    }

    list.addEventListener("click", (event) => {
      const target = fromEvent(event.target);
      const remove = target && target.closest("[data-delete]");
      if (remove) {
        const branch = remove.getAttribute("data-branch");
        if (branch) vscode.postMessage({ type: "delete", branch });
        return;
      }
      const row = target && target.closest(".row[data-branch]");
      if (row) choose(row);
    });

    list.addEventListener("keydown", (event) => {
      const target = fromEvent(event.target);
      const row = target && target.closest(".row[data-branch]");
      if (!row) return;
      if (event.key === "Enter" || event.key === " ") {
        if (target && target.closest("[data-delete]")) return;
        event.preventDefault();
        choose(row);
        return;
      }
      const rows = [...list.querySelectorAll(".row[data-branch]")];
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
      const branch = active && active.getAttribute ? active.getAttribute("data-branch") : "";
      const top = list.scrollTop;
      list.innerHTML = message.html;
      list.scrollTop = top;
      if (!branch) return;
      const next = [...list.querySelectorAll(".row[data-branch]")].find(
        (row) => row.getAttribute("data-branch") === branch,
      );
      if (next) next.focus();
    });
  </script>
</body>
</html>`;
}

const TRASH_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.2 1.2h3.6l.4.6H14v1.4H2V1.8h3.8l.4-.6zM3.2 4h9.6l-.7 9.2a1 1 0 0 1-1 .8H4.9a1 1 0 0 1-1-.8L3.2 4zm2.3 1.4.4 6.6h1.2l-.4-6.6H5.5zm3.6 0-.4 6.6h1.2l.4-6.6H9.1z"/></svg>';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
