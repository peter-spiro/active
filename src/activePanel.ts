import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  ActiveFilesProvider,
  BRANCH_STATUS_SCHEME,
  type ActiveItem,
  type PanelKind,
} from "./activeFilesProvider";
import { Favorites } from "./favorites";

const OPEN_COMMANDS = new Set(["vscode.open", "activeFiles.openDiff"]);
const DISK_SCHEMES = new Set(["file", "vscode-remote", "vscode-vfs"]);

type RowIcon = "file" | "folder" | "warning" | "loading" | "none";

type Row = {
  kind: "file" | "dir" | "message";
  label: string;
  description: string;
  tooltip: string;
  depth: number;
  icon: RowIcon;
  tone?: string;
  command?: string;
  uri?: string;
  removable: boolean;
  deleted: boolean;
  disk: boolean;
  diff: boolean;
  tree: boolean;
  dirId?: string;
  folderUri?: string;
  favorite?: boolean;
};

export class ActivePanel
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private badge: vscode.ViewBadge | undefined;
  private activeFile = "";
  private readonly visibility = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this.visibility.event;

  private readonly favoriteSub: vscode.Disposable;

  constructor(
    private readonly provider: ActiveFilesProvider,
    private readonly kind: PanelKind,
    private readonly favorites: Favorites,
  ) {
    provider.onDidChangeTreeData(() => {
      this.postRows();
      this.applyBadge();
    });
    this.favoriteSub = favorites.onDidChange(() => {
      this.postRows();
    });
  }

  dispose(): void {
    this.favoriteSub.dispose();
    this.visibility.dispose();
  }

  collapseAll(): void {
    this.post({ type: "collapseAll" });
  }

  setActiveFile(uri: string | undefined): void {
    if (this.kind !== "diffs") {
      return;
    }
    const next = uri ?? "";
    if (next === this.activeFile) {
      return;
    }
    this.activeFile = next;
    this.post({ type: "active", uri: next });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = documentHtml(
      view.webview,
      this.provider.filterText(this.kind),
      renderRows(this.provider, this.kind, this.favorites),
      this.canMoveFiles(),
      this.activeFile,
    );
    this.applyBadge();
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.onDidChangeVisibility(() => {
      this.visibility.fire(view.visible);
    });
    view.webview.onDidReceiveMessage((message: unknown) => {
      this.onMessage(message);
    });
  }

  private applyChrome(): void {
    if (!this.view) {
      return;
    }
    this.view.description = "";
    this.view.badge = this.badge;
  }

  private applyBadge(): void {
    const count = this.provider.count(this.kind);
    this.badge =
      count > 0
        ? {
            value: count,
            tooltip: `${count} ${countNoun(this.kind, count)}`,
          }
        : undefined;
    this.applyChrome();
  }

  private postRows(): void {
    this.post({
      type: "rows",
      html: renderRows(this.provider, this.kind, this.favorites),
      move: this.canMoveFiles(),
    });
  }

  private canMoveFiles(): boolean {
    return (
      this.kind === "diffs" && this.provider.layoutMode(this.kind) === "tree"
    );
  }

  private post(message: unknown): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }
    const body = message as {
      type?: unknown;
      value?: unknown;
      command?: unknown;
      uri?: unknown;
      name?: unknown;
      folder?: unknown;
    };
    if (body.type === "filter" && typeof body.value === "string") {
      this.provider.setFilter(this.kind, body.value);
      return;
    }
    if (
      body.type === "move" &&
      typeof body.uri === "string" &&
      typeof body.folder === "string"
    ) {
      if (!this.canMoveFiles()) {
        return;
      }
      let file: vscode.Uri;
      let folder: vscode.Uri;
      try {
        file = vscode.Uri.parse(body.uri);
        folder = vscode.Uri.parse(body.folder);
      } catch {
        return;
      }
      void moveIntoFolder(file, folder).then((moved) => {
        if (moved) {
          void this.provider.refresh(this.kind);
        }
      });
      return;
    }
    if (body.type === "copyFolderName" && typeof body.name === "string") {
      void vscode.env.clipboard.writeText(body.name);
      return;
    }
    if (body.type === "copyFolderPath" && typeof body.folder === "string") {
      let folderUri: vscode.Uri;
      try {
        folderUri = vscode.Uri.parse(body.folder);
      } catch {
        return;
      }
      void vscode.env.clipboard.writeText(fullPath(folderUri));
      return;
    }
    if (
      (body.type === "addFavorite" || body.type === "removeFavorite") &&
      typeof body.folder === "string"
    ) {
      let folderUri: vscode.Uri;
      try {
        folderUri = vscode.Uri.parse(body.folder);
      } catch {
        return;
      }
      if (body.type === "addFavorite") {
        this.favorites.add(folderUri, true);
      } else {
        this.favorites.remove(folderUri);
      }
      return;
    }
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
      this.provider.remove(uri);
      return;
    }
    if (body.type === "copyName") {
      void vscode.env.clipboard.writeText(fileName(uri));
      return;
    }
    if (body.type === "copyPath") {
      void vscode.env.clipboard.writeText(fullPath(uri));
      return;
    }
    if (body.type === "open") {
      void vscode.commands.executeCommand("activeFiles.openFile", uri);
      return;
    }
    if (body.type === "delete") {
      void deleteFile(uri).then((deleted) => {
        if (deleted) {
          void this.provider.refresh(this.kind);
        }
      });
      return;
    }
    if (body.type === "rename" && typeof body.name === "string") {
      void renameFile(uri, body.name);
      return;
    }
    if (
      body.type === "run" &&
      typeof body.command === "string" &&
      OPEN_COMMANDS.has(body.command)
    ) {
      void vscode.commands.executeCommand(body.command, uri);
    }
  }
}

function countNoun(kind: PanelKind, count: number): string {
  if (kind === "diffs") {
    return count === 1 ? "changed file" : "changed files";
  }
  return count === 1 ? "edited file" : "edited files";
}

function renderRows(
  provider: ActiveFilesProvider,
  kind: PanelKind,
  favorites: Favorites,
): string {
  const rows = collectRows(provider, kind, favorites);
  if (rows.length === 0) {
    const text =
      kind === "diffs"
        ? provider.viewingCommit
          ? `No files changed in ${provider.branchBaseLabel}.`
          : `No files differ from ${provider.branchBaseLabel} on this branch.`
        : "Edit a file and it will show up here.";
    return `<div class="message">${escapeHtml(text)}</div>`;
  }
  return rows.map(renderRow).join("");
}

function collectRows(
  provider: ActiveFilesProvider,
  kind: PanelKind,
  favorites: Favorites,
): Row[] {
  const rows: Row[] = [];
  const showDiff = kind === "diffs";
  const tree = provider.layoutMode(kind) === "tree";
  const walk = (parent: ActiveItem | undefined, depth: number): void => {
    for (const child of provider.getChildren(parent, kind)) {
      const favorite =
        child.kind === "dir" && !!child.uri && favorites.isFolder(child.uri);
      rows.push(
        toRow(
          child,
          provider.getTreeItem(child, kind),
          depth,
          showDiff,
          tree,
          favorite,
        ),
      );
      if (child.kind === "dir") {
        walk(child, depth + 1);
      }
    }
  };
  walk(undefined, 0);
  return rows;
}

function toRow(
  element: ActiveItem,
  item: vscode.TreeItem,
  depth: number,
  showDiff: boolean,
  tree: boolean,
  favorite: boolean,
): Row {
  if (element.kind === "message") {
    return {
      kind: "message",
      label: element.label,
      description: "",
      tooltip: "",
      depth: 0,
      icon:
        element.icon === "loading"
          ? "loading"
          : element.icon === "warning"
            ? "warning"
            : "none",
      removable: false,
      deleted: false,
      disk: false,
      diff: false,
      tree: false,
      favorite: false,
    };
  }
  const command = item.command?.command;
  return {
    kind: element.kind,
    label: itemText(item.label),
    description: typeof item.description === "string" ? item.description : "",
    tooltip: tooltipText(item.tooltip),
    depth,
    icon: element.kind === "dir" ? "folder" : "file",
    tone:
      item.resourceUri?.scheme === BRANCH_STATUS_SCHEME
        ? item.resourceUri.query
        : undefined,
    command: command && OPEN_COMMANDS.has(command) ? command : undefined,
    uri: element.kind === "file" ? element.uri.toString() : undefined,
    removable: item.contextValue === "activeFile",
    deleted: item.contextValue === "branchFileDeleted",
    disk: element.kind === "file" && DISK_SCHEMES.has(element.uri.scheme),
    diff: showDiff && element.kind === "file",
    tree,
    dirId: element.kind === "dir" ? element.id : undefined,
    folderUri:
      element.kind === "dir" && element.uri
        ? element.uri.toString()
        : undefined,
    favorite,
  };
}

function renderRow(row: Row): string {
  if (row.kind === "message") {
    return `<div class="message">${iconSvg(row.icon)}<span>${escapeHtml(row.label)}</span></div>`;
  }
  const uri = row.uri ? ` data-uri="${escapeHtml(row.uri)}"` : "";
  const command = row.command
    ? ` data-command="${escapeHtml(row.command)}"`
    : "";
  const flags = `${row.deleted ? ' data-deleted="1"' : ""}${row.disk ? ' data-disk="1"' : ""}`;
  const focus = row.uri || row.dirId ? ' tabindex="0"' : "";
  const tone = row.tone ? ` ${escapeHtml(row.tone)}` : "";
  const indent = row.tree ? row.depth * 16 : row.depth * 12;
  const depth = row.tree ? ` data-depth="${row.depth}"` : "";
  const dir = row.dirId
    ? ` data-dir="${escapeHtml(row.dirId)}"${row.folderUri ? ` data-folder="${escapeHtml(row.folderUri)}"` : ""}${row.favorite ? ' data-favorite="1"' : ""} aria-expanded="true"`
    : "";
  const draggable =
    row.tree && row.diff && row.uri && !row.deleted ? ' draggable="true"' : "";
  const remove =
    row.removable && row.uri
      ? `<button type="button" class="close" data-remove="1" data-uri="${escapeHtml(row.uri)}" title="Remove from Recent" aria-label="Remove from Recent">${iconSvg("close")}</button>`
      : "";
  const diff =
    row.diff && row.uri
      ? `<button type="button" class="diff" data-diff="1" data-uri="${escapeHtml(row.uri)}" title="Show diff" aria-label="Show diff">${iconSvg("diff")}</button>`
      : "";
  const description = row.description
    ? `<span class="desc">${escapeHtml(row.description)}</span>`
    : "";
  return `<div class="row" role="treeitem"${uri}${command}${flags}${focus}${depth}${dir}${draggable} title="${escapeHtml(row.tooltip)}"><span class="indent" style="width:${indent}px"></span><span class="icon${tone}">${iconSvg(row.icon)}</span><span class="label${tone}">${escapeHtml(row.label)}</span>${description}${diff}${remove}</div>`;
}

function itemText(value: string | vscode.TreeItemLabel | undefined): string {
  if (!value) {
    return "";
  }
  return typeof value === "string" ? value : value.label;
}

function tooltipText(
  value: string | vscode.MarkdownString | undefined,
): string {
  if (!value) {
    return "";
  }
  return typeof value === "string" ? value : value.value;
}

function documentHtml(
  webview: vscode.Webview,
  filter: string,
  rows: string,
  movable: boolean,
  activeFile: string,
): string {
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
    display: flex;
    flex-direction: column;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--vscode-sideBar-background);
  }
  #list { flex: 1; overflow: auto; padding-top: 2px; }
  .row, .message {
    display: flex;
    align-items: center;
    min-width: 0;
    height: 22px;
    line-height: 22px;
  }
  .row { padding-right: 4px; cursor: default; user-select: none; }
  .row[data-command], .row[data-dir] { cursor: pointer; }
  .row[draggable="true"] { cursor: grab; }
  .row.dragging { opacity: 0.4; }
  .row.drop-target {
    background: var(--vscode-list-dropBackground, var(--vscode-list-hoverBackground));
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .row[hidden] { display: none; }
  .row:hover, .row.menu-target { background: var(--vscode-list-hoverBackground); }
  .row.menu-target, .row.current {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  .row:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .indent { flex: none; }
  .icon, .message svg, .close svg, .diff svg {
    flex: none;
    width: 16px;
    height: 16px;
  }
  .icon { margin-left: 4px; display: flex; }
  .icon.new, .label.new { color: var(--vscode-charts-green); }
  .icon.modified, .label.modified { color: var(--vscode-charts-orange); }
  .icon.deleted, .label.deleted { color: var(--vscode-charts-red); }
  .label, .desc, .message span {
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
  .row:hover .close, .row:focus .close, .row.menu-target .close, .close:focus { display: flex; align-items: center; justify-content: center; }
  .diff {
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
  .diff:hover, .diff:focus { color: var(--vscode-icon-foreground); }
  .row.renaming .desc, .row.renaming .close, .row.renaming .diff { display: none; }
  .rename {
    margin-left: 6px;
    flex: 1;
    min-width: 0;
    height: 18px;
    box-sizing: border-box;
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-focusBorder);
    padding: 0 3px;
    user-select: text;
  }
  #menu {
    position: fixed;
    z-index: 20;
    min-width: 168px;
    margin: 0;
    padding: 4px 0;
    background: var(--vscode-menu-background, var(--vscode-dropdown-background));
    color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border, transparent));
    box-shadow: 0 2px 8px var(--vscode-widget-shadow);
  }
  #menu[hidden] { display: none; }
  #menu button {
    display: block;
    width: 100%;
    margin: 0;
    padding: 3px 12px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  #menu button[hidden], #menu .sep[hidden] { display: none; }
  #menu button:hover, #menu button:focus {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
    outline: none;
  }
  #menu .sep {
    height: 1px;
    margin: 4px 0;
    background: var(--vscode-menu-separatorBackground, var(--vscode-contrastBorder, rgba(128, 128, 128, 0.4)));
  }
  .message { padding: 4px 12px; color: var(--vscode-descriptionForeground); gap: 6px; height: auto; }
  .message svg.spin { animation: spin 1s linear infinite; }
  #filterbar {
    flex: none;
    padding: 4px 6px 6px;
    border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent));
    background: var(--vscode-sideBar-background);
  }
  #filter {
    width: 100%;
    box-sizing: border-box;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    font: inherit;
    padding: 3px 6px;
  }
  #filter::placeholder { color: var(--vscode-input-placeholderForeground); }
  #filter:focus {
    outline: 1px solid var(--vscode-focusBorder);
    border-color: var(--vscode-focusBorder);
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div id="list" role="tree" data-move="${movable ? "1" : ""}" data-active="${escapeHtml(activeFile)}">${rows}</div>
  <form id="filterbar" role="search">
    <input id="filter" type="text" spellcheck="false" autocomplete="off" aria-label="Filter files" placeholder="Filter (glob)" value="${escapeHtml(filter)}" />
  </form>
  <div id="menu" role="menu" hidden>
    <button type="button" role="menuitem" data-action="copyFolderName" hidden>Copy folder name</button>
    <button type="button" role="menuitem" data-action="copyFolderPath" hidden>Copy folder path</button>
    <button type="button" role="menuitem" data-action="addFavorite" hidden>Add to Favorites</button>
    <button type="button" role="menuitem" data-action="removeFavorite" hidden>Remove from Favorites</button>
    <button type="button" role="menuitem" data-action="copyName">Copy filename</button>
    <button type="button" role="menuitem" data-action="copyPath">Copy full path</button>
    <div class="sep"></div>
    <button type="button" role="menuitem" data-action="open">Open file</button>
    <button type="button" role="menuitem" data-action="rename">Rename file</button>
    <button type="button" role="menuitem" data-action="delete">Delete file</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById("list");
    const filter = document.getElementById("filter");
    const form = document.getElementById("filterbar");
    form.addEventListener("submit", (event) => event.preventDefault());
    filter.addEventListener("input", () => {
      vscode.postMessage({ type: "filter", value: filter.value });
    });
    const menu = document.getElementById("menu");
    let menuRow = null;
    let swallowClick = false;

    function fromEvent(target) {
      if (target instanceof Element) return target;
      return target && target.parentElement ? target.parentElement : null;
    }

    function hideMenu() {
      menu.hidden = true;
      if (menuRow) menuRow.classList.remove("menu-target");
      menuRow = null;
    }

    function activate(row) {
      const command = row.getAttribute("data-command");
      const uri = row.getAttribute("data-uri");
      if (!command || !uri) return;
      vscode.postMessage({ type: "run", command, uri });
    }

    function showMenu(row, x, y) {
      if (menuRow && menuRow !== row) menuRow.classList.remove("menu-target");
      menuRow = row;
      row.classList.add("menu-target");
      const folder = row.hasAttribute("data-dir");
      const deleted = row.hasAttribute("data-deleted");
      const disk = row.hasAttribute("data-disk");
      menu.querySelector('[data-action="copyFolderName"]').hidden = !folder;
      const canFavorite = folder && row.hasAttribute("data-folder");
      const saved = row.hasAttribute("data-favorite");
      menu.querySelector('[data-action="copyFolderPath"]').hidden =
        !folder || !row.hasAttribute("data-folder");
      menu.querySelector('[data-action="addFavorite"]').hidden =
        !canFavorite || saved;
      menu.querySelector('[data-action="removeFavorite"]').hidden =
        !canFavorite || !saved;
      menu.querySelector('[data-action="copyName"]').hidden = folder;
      menu.querySelector('[data-action="copyPath"]').hidden = folder;
      menu.querySelector('[data-action="open"]').hidden = folder || deleted;
      menu.querySelector('[data-action="rename"]').hidden = folder || deleted || !disk;
      menu.querySelector('[data-action="delete"]').hidden = folder || deleted || !disk;
      menu.querySelector(".sep").hidden = folder || deleted;
      menu.style.left = x + "px";
      menu.style.top = y + "px";
      menu.hidden = false;
      const rect = menu.getBoundingClientRect();
      const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
      const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
      menu.style.left = left + "px";
      menu.style.top = top + "px";
    }

    function validName(value) {
      return !!value && value !== "." && value !== ".." && !/[\\\\/]/.test(value);
    }

    function startRename(row) {
      if (row.querySelector(".rename")) return;
      const label = row.querySelector(".label");
      if (!label) return;
      const name = label.textContent || "";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "rename";
      input.value = name;
      input.spellcheck = false;
      input.setAttribute("aria-label", "Rename file");
      row.classList.add("renaming");
      label.replaceWith(input);
      input.focus();
      const dot = name.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : name.length);
      let finished = false;
      const restore = () => {
        if (input.isConnected) input.replaceWith(label);
        row.classList.remove("renaming");
      };
      const finish = (commit) => {
        if (finished) return;
        const next = input.value;
        if (commit && !validName(next)) return;
        finished = true;
        restore();
        if (commit && next !== name) {
          vscode.postMessage({
            type: "rename",
            uri: row.getAttribute("data-uri"),
            name: next,
          });
        }
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener("blur", () => {
        if (finished) return;
        if (!validName(input.value)) finish(false);
        else finish(true);
      });
      input.addEventListener("click", (event) => event.stopPropagation());
    }

    list.addEventListener("click", (event) => {
      if (ignoreClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target = fromEvent(event.target);
      if (!target) return;
      const remove = target.closest("[data-remove]");
      if (remove) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: "remove", uri: remove.getAttribute("data-uri") });
        return;
      }
      const diff = target.closest("[data-diff]");
      if (diff) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({
          type: "run",
          command: "activeFiles.openDiff",
          uri: diff.getAttribute("data-uri"),
        });
        return;
      }
      if (target.closest(".rename")) return;
      const folder = target.closest(".row[data-dir]");
      if (folder) {
        toggleFolder(folder);
        return;
      }
      const row = target.closest(".row[data-uri]");
      if (!row) return;
      activate(row);
    });
    list.addEventListener("contextmenu", (event) => {
      const target = fromEvent(event.target);
      if (!target || target.closest(".rename")) return;
      const row = target.closest(".row[data-dir], .row[data-uri]");
      if (!row) return;
      event.preventDefault();
      showMenu(row, event.clientX, event.clientY);
    });
    menu.addEventListener("contextmenu", (event) => event.preventDefault());
    menu.addEventListener("click", (event) => {
      const target = fromEvent(event.target);
      const button = target && target.closest("[data-action]");
      if (!button || !menuRow) return;
      const action = button.getAttribute("data-action");
      const row = menuRow;
      const uri = row.getAttribute("data-uri");
      hideMenu();
      if (action === "rename") {
        startRename(row);
        return;
      }
      if (action === "copyFolderName") {
        const label = row.querySelector(".label");
        vscode.postMessage({
          type: "copyFolderName",
          name: label ? label.textContent || "" : "",
        });
        return;
      }
      if (action === "copyFolderPath") {
        vscode.postMessage({
          type: "copyFolderPath",
          folder: row.getAttribute("data-folder"),
        });
        return;
      }
      if (action === "addFavorite" || action === "removeFavorite") {
        vscode.postMessage({
          type: action,
          folder: row.getAttribute("data-folder"),
        });
        return;
      }
      vscode.postMessage({ type: action, uri });
    });
    window.addEventListener("mousedown", (event) => {
      if (menu.hidden) return;
      const target = fromEvent(event.target);
      if (target && target.closest("#menu")) return;
      hideMenu();
      if (event.button === 0) swallowClick = true;
    }, true);
    window.addEventListener("click", (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    window.addEventListener("keydown", (event) => {
      if (menu.hidden || event.key !== "Escape") return;
      event.preventDefault();
      hideMenu();
    });
    list.addEventListener("scroll", () => {
      if (!menu.hidden) hideMenu();
    });
    let activeFile = list.getAttribute("data-active") || "";

    function markActive() {
      for (const row of list.querySelectorAll(".row.current")) {
        row.classList.remove("current");
        row.removeAttribute("aria-current");
      }
      if (!activeFile) return;
      for (const row of list.querySelectorAll(".row[data-uri]")) {
        if (row.getAttribute("data-uri") !== activeFile) continue;
        row.classList.add("current");
        row.setAttribute("aria-current", "true");
      }
    }

    markActive();
    const collapsed = new Set();

    function applyTree() {
      const rows = [...list.querySelectorAll(".row")];
      const closed = [];
      for (const row of rows) {
        const depth = Number(row.getAttribute("data-depth") || "0");
        while (closed.length && closed[closed.length - 1] >= depth) closed.pop();
        row.hidden = closed.length > 0;
        if (row.hidden || !row.hasAttribute("data-dir")) continue;
        const id = row.getAttribute("data-dir");
        const isCollapsed = collapsed.has(id);
        row.classList.toggle("collapsed", isCollapsed);
        row.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
        if (isCollapsed) closed.push(depth);
      }
    }

    function toggleFolder(row) {
      const id = row.getAttribute("data-dir");
      if (!id) return;
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      applyTree();
      if (!row.hidden) row.focus();
    }

    function collapseAll() {
      for (const row of list.querySelectorAll(".row[data-dir]")) {
        const id = row.getAttribute("data-dir");
        if (id) collapsed.add(id);
      }
      applyTree();
    }

    list.addEventListener("keydown", (event) => {
      if (fromEvent(event.target)?.closest(".rename")) return;
      const rows = [...list.querySelectorAll(".row[data-uri], .row[data-dir]")].filter((row) => !row.hidden);
      const index = rows.indexOf(document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (index === -1) return;
        event.preventDefault();
        const next = event.key === "ArrowDown" ? index + 1 : index - 1;
        rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
      } else if (event.key === "Enter" && index !== -1) {
        event.preventDefault();
        if (rows[index].hasAttribute("data-dir")) toggleFolder(rows[index]);
        else activate(rows[index]);
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        index !== -1 &&
        rows[index].hasAttribute("data-dir")
      ) {
        const isCollapsed = rows[index].classList.contains("collapsed");
        if (event.key === "ArrowLeft" && !isCollapsed) {
          event.preventDefault();
          toggleFolder(rows[index]);
        } else if (event.key === "ArrowRight" && isCollapsed) {
          event.preventDefault();
          toggleFolder(rows[index]);
        }
      }
    });
    window.addEventListener("message", (event) => {
      if (!event.data) return;
      if (event.data.type === "active") {
        activeFile = typeof event.data.uri === "string" ? event.data.uri : "";
        markActive();
        return;
      }
      if (event.data.type === "collapseAll") {
        collapseAll();
        return;
      }
      if (event.data.type !== "rows") return;
      hideMenu();
      if (typeof event.data.move === "boolean") {
        list.setAttribute("data-move", event.data.move ? "1" : "");
      }
      const top = list.scrollTop;
      list.innerHTML = event.data.html;
      list.scrollTop = top;
      applyTree();
      markActive();
    });

    let ignoreClick = false;

    function canMove() {
      return list.getAttribute("data-move") === "1";
    }

    function clearDrop() {
      list.querySelectorAll(".dragging, .drop-target").forEach((row) => {
        row.classList.remove("dragging", "drop-target");
      });
    }

    function dropFolder(target) {
      const element = fromEvent(target);
      return element && element.closest(".row[data-folder]");
    }

    list.addEventListener("dragstart", (event) => {
      if (!canMove() || !event.dataTransfer) return;
      const target = fromEvent(event.target);
      if (!target || target.closest(".rename, [data-diff], [data-remove]")) {
        event.preventDefault();
        return;
      }
      const row = target.closest(".row[draggable='true']");
      if (!row) return;
      const uri = row.getAttribute("data-uri");
      if (!uri) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData("text/plain", uri);
      event.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
      ignoreClick = true;
    });

    list.addEventListener("dragover", (event) => {
      if (!canMove()) return;
      const folder = dropFolder(event.target);
      list.querySelectorAll(".drop-target").forEach((row) => {
        if (row !== folder) row.classList.remove("drop-target");
      });
      if (!folder) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      folder.classList.add("drop-target");
    });

    list.addEventListener("drop", (event) => {
      if (!canMove()) return;
      const folder = dropFolder(event.target);
      const uri = event.dataTransfer && event.dataTransfer.getData("text/plain");
      const folderUri = folder && folder.getAttribute("data-folder");
      clearDrop();
      if (!folder || !uri || !folderUri) return;
      event.preventDefault();
      vscode.postMessage({ type: "move", uri, folder: folderUri });
    });

    list.addEventListener("dragend", () => {
      clearDrop();
      setTimeout(() => {
        ignoreClick = false;
      }, 0);
    });
  </script>
</body>
</html>`;
}

function iconSvg(icon: RowIcon | "close" | "diff"): string {
  if (icon === "none") {
    return "";
  }
  const spin = icon === "loading" ? " spin" : "";
  return `<svg class="${spin}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${SVG[icon]}</svg>`;
}

const SVG: Record<Exclude<RowIcon, "none"> | "close" | "diff", string> = {
  file: '<path fill="none" stroke="currentColor" stroke-width="1.2" d="M4 1.6h5.1L12.4 5v9.4H4z"/><path fill="none" stroke="currentColor" stroke-width="1.2" d="M9 1.6V5h3.4"/>',
  folder: '<path fill="currentColor" d="M1.6 3.2h4.7l1.2 1.4h6.9v8.2H1.6z"/>',
  warning:
    '<path fill="currentColor" d="M8 1.8 15 14.2H1L8 1.8zm0 4.2.1 4.2h-.2L8 6zm0 6.3a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4z"/>',
  loading:
    '<path fill="none" stroke="currentColor" stroke-width="1.6" d="M8 2.2a5.8 5.8 0 1 1-4.1 1.7"/>',
  close:
    '<path fill="none" stroke="currentColor" stroke-width="1.4" d="M4 4l8 8M12 4 4 12"/>',
  diff: '<path fill="currentColor" d="M5.5 2H2.5C1.673 2 1 2.673 1 3.5V12.5C1 13.327 1.673 14 2.5 14H5.5C6.327 14 7 13.327 7 12.5V3.5C7 2.673 6.327 2 5.5 2ZM2.5 3H5.5C5.775 3 6 3.224 6 3.5V5H2V3.5C2 3.224 2.225 3 2.5 3ZM5.5 13H2.5C2.225 13 2 12.776 2 12.5V6H6V12.5C6 12.776 5.775 13 5.5 13ZM13.5 2H10.5C9.673 2 9 2.673 9 3.5V12.5C9 13.327 9.673 14 10.5 14H13.5C14.327 14 15 13.327 15 12.5V3.5C15 2.673 14.327 2 13.5 2ZM10.5 3H13.5C13.775 3 14 3.224 14 3.5V8H10V3.5C10 3.224 10.225 3 10.5 3ZM13.5 13H10.5C10.225 13 10 12.776 10 12.5V10H14V12.5C14 12.776 13.775 13 13.5 13Z"/>',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fileName(uri: vscode.Uri): string {
  const slash = uri.path.lastIndexOf("/");
  const name = slash >= 0 ? uri.path.slice(slash + 1) : uri.path;
  return name || uri.toString(true);
}

function fullPath(uri: vscode.Uri): string {
  if (uri.scheme === "file" || uri.scheme === "vscode-remote") {
    return uri.fsPath;
  }
  return uri.toString(true);
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  const slash = uri.path.lastIndexOf("/");
  const path = slash > 0 ? uri.path.slice(0, slash) : "/";
  return uri.with({ path, query: "", fragment: "" });
}

async function deleteFile(uri: vscode.Uri): Promise<boolean> {
  const name = fileName(uri);
  const useTrash =
    vscode.workspace.getConfiguration("files").get("enableTrash") !== false;
  const confirm =
    vscode.workspace.getConfiguration("explorer").get("confirmDelete") !==
    false;
  if (confirm) {
    const action = useTrash ? "Move to Trash" : "Delete";
    const picked = await vscode.window.showWarningMessage(
      `Are you sure you want to delete '${name}'?`,
      { modal: true },
      action,
    );
    if (picked !== action) {
      return false;
    }
  }
  try {
    await vscode.workspace.fs.delete(uri, { useTrash, recursive: false });
    return true;
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    ) {
      return true;
    }
    void vscode.window.showErrorMessage(
      failureText(error, `Could not delete ${name}.`),
    );
    return false;
  }
}

async function moveIntoFolder(
  file: vscode.Uri,
  folder: vscode.Uri,
): Promise<boolean> {
  const name = fileName(file);
  if (!DISK_SCHEMES.has(file.scheme) || file.scheme !== folder.scheme) {
    void vscode.window.showErrorMessage("This file can't be moved from here.");
    return false;
  }
  let folderStat: vscode.FileStat;
  try {
    folderStat = await vscode.workspace.fs.stat(folder);
  } catch {
    void vscode.window.showErrorMessage("That folder is not available.");
    return false;
  }
  if ((folderStat.type & vscode.FileType.Directory) === 0) {
    return false;
  }
  const target = vscode.Uri.joinPath(folder, name);
  if (
    target.toString() === file.toString() ||
    parentUri(file).toString() === folder.toString()
  ) {
    return false;
  }
  try {
    try {
      await vscode.workspace.fs.stat(target);
      void vscode.window.showErrorMessage(
        `A file named '${name}' already exists.`,
      );
      return false;
    } catch (error) {
      if (
        !(error instanceof vscode.FileSystemError) ||
        error.code !== "FileNotFound"
      ) {
        throw error;
      }
    }
    await vscode.workspace.fs.rename(file, target, { overwrite: false });
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(
      failureText(error, `Could not move ${name}.`),
    );
    return false;
  }
}

async function renameFile(uri: vscode.Uri, requested: string): Promise<void> {
  const next = requested.trim();
  const current = fileName(uri);
  if (!next || next === "." || next === ".." || /[\\/]/.test(next)) {
    void vscode.window.showErrorMessage("Enter a file name.");
    return;
  }
  if (next === current || !DISK_SCHEMES.has(uri.scheme)) {
    if (next !== current) {
      void vscode.window.showErrorMessage(
        "This file can't be renamed from here.",
      );
    }
    return;
  }
  const target = vscode.Uri.joinPath(parentUri(uri), next);
  const caseOnly =
    current.localeCompare(next, undefined, { sensitivity: "accent" }) === 0;
  try {
    if (!caseOnly) {
      try {
        await vscode.workspace.fs.stat(target);
        void vscode.window.showErrorMessage(
          `A file named '${next}' already exists.`,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof vscode.FileSystemError) ||
          error.code !== "FileNotFound"
        ) {
          throw error;
        }
      }
    }
    try {
      await vscode.workspace.fs.rename(uri, target, { overwrite: false });
    } catch (error) {
      if (caseOnly && isFileExists(error)) {
        await renameCaseOnly(uri, target);
        return;
      }
      throw error;
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      failureText(error, `Could not rename ${current}.`),
    );
  }
}

async function renameCaseOnly(
  uri: vscode.Uri,
  target: vscode.Uri,
): Promise<void> {
  const temporary = vscode.Uri.joinPath(
    parentUri(uri),
    `.${fileName(target)}.${Date.now()}.renaming`,
  );
  await vscode.workspace.fs.rename(uri, temporary, { overwrite: false });
  try {
    await vscode.workspace.fs.rename(temporary, target, { overwrite: false });
  } catch (error) {
    try {
      await vscode.workspace.fs.rename(temporary, uri, { overwrite: false });
    } catch {
      // The file stays under the temporary name if the rollback fails.
    }
    throw error;
  }
}

function isFileExists(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileExists";
}

function failureText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
