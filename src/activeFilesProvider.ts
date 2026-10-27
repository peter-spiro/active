import * as vscode from "vscode";
import { collectBranchChanges } from "./branchChanges";
import { matchesFilter } from "./globMatch";

const FILES_KEY = "active.entries";
const FILTER_KEY = "active.filter";
const MODE_KEY = "active.viewMode";
const LAYOUT_KEY = "active.layout";
const DIFFS_FILTER_KEY = "diffs.filter";
const DIFFS_LAYOUT_KEY = "diffs.layout";
const DIFFS_BASE_KEY = "diffs.base";
const DIFFS_COMMIT_KEY = "diffs.commit";
const MAX_TRACKED = 500;
const REFRESH_DELAY_MS = 300;
const PERSIST_DELAY_MS = 500;
const BRANCH_REFRESH_DELAY_MS = 500;

const TRACKABLE_SCHEMES = new Set([
  "file",
  "untitled",
  "vscode-remote",
  "vscode-vfs",
]);
export const BRANCH_STATUS_SCHEME = "active-branch-status";

export type PanelKind = "recent" | "diffs";
export type Layout = "list" | "tree";

type Tracked = {
  uri: vscode.Uri;
  editedAt: number;
  detail?: string;
};

type PersistedEntry = {
  uri: string;
  editedAt: number;
};

type FileItem = {
  kind: "file";
  uri: vscode.Uri;
  editedAt: number;
  detail?: string;
};

type DirItem = {
  kind: "dir";
  id: string;
  label: string;
  uri?: vscode.Uri;
  children: ActiveItem[];
};

type MessageItem = {
  kind: "message";
  id: string;
  label: string;
  icon?: "loading" | "warning";
};

export type ActiveItem = FileItem | DirItem | MessageItem;

function readLayoutSetting(state: vscode.Memento): Layout {
  return (
    readLayout(state.get<unknown>(LAYOUT_KEY)) ??
    legacyLayout(state.get<unknown>(MODE_KEY))
  );
}

function legacyLayout(value: unknown): Layout {
  if (
    value === "tree" ||
    value === "branch" ||
    value === "branchOpen" ||
    value === "branchDiff"
  ) {
    return "tree";
  }
  return "list";
}

function readLayout(value: unknown): Layout | undefined {
  if (value === "list" || value === "tree") {
    return value;
  }
  return undefined;
}

export function registerBranchStatusDecorations(): vscode.Disposable {
  return vscode.window.registerFileDecorationProvider({
    provideFileDecoration(uri) {
      if (uri.scheme !== BRANCH_STATUS_SCHEME) {
        return undefined;
      }
      return new vscode.FileDecoration(
        undefined,
        undefined,
        new vscode.ThemeColor(branchToneColor(uri.query)),
      );
    },
  });
}

export function isTrackable(uri: vscode.Uri): boolean {
  return TRACKABLE_SCHEMES.has(uri.scheme);
}

export function uriFromCommandArgument(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (!arg || typeof arg !== "object") {
    return undefined;
  }
  const value = arg as { uri?: unknown; resourceUri?: unknown };
  if (value.uri instanceof vscode.Uri) {
    return value.uri;
  }
  if (value.resourceUri instanceof vscode.Uri) {
    return value.resourceUri;
  }
  return undefined;
}

export class ActiveFilesProvider
  implements vscode.TreeDataProvider<ActiveItem>, vscode.Disposable
{
  private readonly entries = new Map<string, Tracked>();
  private recentLayout: Layout;
  private diffsLayout: Layout;
  private recentFilter = "";
  private diffsFilter = "";
  private diffFromParent = false;
  private pinnedCommit: string | undefined;
  private stackParent: string | undefined;
  private disposed = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private branchTimer: ReturnType<typeof setTimeout> | undefined;
  private branchEntries: Tracked[] = [];
  private branchMessage: string | undefined;
  private branchBase = "main";
  private branchState: "loading" | "ready" = "ready";
  private branchGeneration = 0;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ActiveItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangeCount = new vscode.EventEmitter<number>();
  readonly onDidChangeCount = this._onDidChangeCount.event;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento,
  ) {
    this.recentLayout = readLayoutSetting(this.globalState);
    this.diffsLayout =
      readLayout(this.globalState.get<unknown>(DIFFS_LAYOUT_KEY)) ??
      this.recentLayout;
    this.recentFilter = readText(this.workspaceState.get<unknown>(FILTER_KEY));
    this.diffsFilter = readText(
      this.workspaceState.get<unknown>(DIFFS_FILTER_KEY),
    );
    this.diffFromParent = this.workspaceState.get(DIFFS_BASE_KEY) === "parent";
    this.pinnedCommit = readCommit(this.workspaceState.get(DIFFS_COMMIT_KEY));
    this.load();
  }

  filterText(kind: PanelKind): string {
    return kind === "diffs" ? this.diffsFilter : this.recentFilter;
  }

  setFilter(kind: PanelKind, value: string): void {
    if (value === this.filterText(kind)) {
      return;
    }
    if (kind === "diffs") {
      this.diffsFilter = value;
      void this.workspaceState.update(DIFFS_FILTER_KEY, value);
    } else {
      this.recentFilter = value;
      void this.workspaceState.update(FILTER_KEY, value);
    }
    this.emit();
  }

  count(kind: PanelKind = "recent"): number {
    return countFiles(this.getChildren(undefined, kind));
  }

  get branchBaseLabel(): string {
    return this.branchBase;
  }

  layoutMode(kind: PanelKind): Layout {
    return kind === "diffs" ? this.diffsLayout : this.recentLayout;
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      void this.persist();
    }
    this.cancelBranchReload();
    this.branchGeneration += 1;
    this._onDidChangeTreeData.dispose();
    this._onDidChangeCount.dispose();
  }

  redraw(): void {
    this.emit();
  }

  touch(uri: vscode.Uri): void {
    const key = uri.toString();
    const isNew = !this.entries.has(key);
    this.entries.set(key, { uri, editedAt: Date.now() });
    const evicted = this.evict();
    if (isNew || evicted) {
      this.cancelRefresh();
      this.emit();
    } else {
      this.scheduleRefresh();
    }
    this.queuePersist(false);
  }

  seed(uri: vscode.Uri): boolean {
    const key = uri.toString();
    if (this.entries.has(key)) {
      return false;
    }
    this.entries.set(key, { uri, editedAt: Date.now() });
    this.evict();
    return this.entries.has(key);
  }

  commit(): void {
    this.queuePersist(true);
    this.emit();
  }

  get hasStackParent(): boolean {
    return this.stackParent !== undefined;
  }

  get diffBase(): "main" | "parent" {
    return this.diffFromParent ? "parent" : "main";
  }

  diffBaseLabel(): string {
    if (this.pinnedCommit) {
      return this.pinnedCommit.slice(0, 7);
    }
    if (this.diffFromParent && this.stackParent) {
      return this.stackParent;
    }
    return "main";
  }

  rangeRef(): string | undefined {
    if (this.diffFromParent && this.stackParent) {
      return this.stackParent;
    }
    return undefined;
  }

  diffBaseRef(): string | undefined {
    return this.pinnedCommit ?? this.rangeRef();
  }

  get pinnedCommitSha(): string | undefined {
    return this.pinnedCommit;
  }

  setStackParent(name: string | undefined): void {
    if (name === this.stackParent) {
      return;
    }
    this.stackParent = name;
    if (this.diffFromParent) {
      void this.reloadBranch();
    }
  }

  async useDiffBase(mode: "main" | "parent"): Promise<void> {
    const next = mode === "parent";
    if (next === this.diffFromParent && !this.pinnedCommit) {
      return;
    }
    this.diffFromParent = next;
    this.pinnedCommit = undefined;
    await this.workspaceState.update(DIFFS_BASE_KEY, mode);
    await this.workspaceState.update(DIFFS_COMMIT_KEY, undefined);
    await this.reloadBranch();
  }

  async useDiffCommit(sha: string | undefined): Promise<void> {
    const next = sha?.toLowerCase();
    if (next === this.pinnedCommit) {
      return;
    }
    this.pinnedCommit = next;
    await this.workspaceState.update(DIFFS_COMMIT_KEY, next);
    await this.reloadBranch();
  }

  async setLayout(kind: PanelKind, layout: Layout): Promise<void> {
    if (this.layoutMode(kind) === layout) {
      return;
    }
    if (kind === "diffs") {
      this.diffsLayout = layout;
      await this.globalState.update(DIFFS_LAYOUT_KEY, layout);
    } else {
      this.recentLayout = layout;
      await this.globalState.update(LAYOUT_KEY, layout);
    }
    this.emit();
  }

  onBranchDirty(): void {
    if (this.disposed) {
      return;
    }
    if (this.branchTimer) {
      clearTimeout(this.branchTimer);
    }
    this.branchTimer = setTimeout(() => {
      this.branchTimer = undefined;
      void this.reloadBranch();
    }, BRANCH_REFRESH_DELAY_MS);
  }

  async reloadBranch(): Promise<void> {
    this.cancelBranchReload();
    if (this.disposed) {
      return;
    }
    if (await this.loadBranchChanges()) {
      this.emit();
    }
  }

  async ensureBranchLoaded(): Promise<void> {
    if (this.branchEntries.length === 0 && !this.branchMessage) {
      this.branchState = "loading";
      this.emit();
    }
    if (await this.loadBranchChanges()) {
      this.emit();
    }
  }

  remove(uri: vscode.Uri): void {
    if (!this.entries.delete(uri.toString())) {
      return;
    }
    this.queuePersist(true);
    this.emit();
  }

  forget(uri: vscode.Uri): void {
    const removed = this.deleteWithDescendants(uri);
    if (removed > 0) {
      this.queuePersist(true);
      this.emit();
    }
    this.onBranchDirty();
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const oldPrefix = oldUri.toString();
    const moved: Array<{ key: string; entry: Tracked }> = [];
    for (const [key, entry] of this.entries) {
      if (key === oldPrefix) {
        moved.push({ key, entry: { uri: newUri, editedAt: entry.editedAt } });
      } else if (key.startsWith(`${oldPrefix}/`)) {
        const next = vscode.Uri.parse(
          newUri.toString() + key.slice(oldPrefix.length),
        );
        moved.push({ key, entry: { uri: next, editedAt: entry.editedAt } });
      }
    }
    if (moved.length > 0) {
      for (const item of moved) {
        this.entries.delete(item.key);
        this.entries.set(item.entry.uri.toString(), item.entry);
      }
      this.queuePersist(true);
      this.emit();
    }
    this.onBranchDirty();
  }

  clear(): void {
    if (this.entries.size === 0) {
      this.emit();
      return;
    }
    this.entries.clear();
    this.queuePersist(true);
    this.emit();
  }

  async refresh(kind: PanelKind = "recent"): Promise<void> {
    if (kind === "diffs") {
      await this.reloadBranch();
      return;
    }
    const missing: string[] = [];
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (entry.uri.scheme === "untitled") {
          const open = vscode.workspace.textDocuments.some(
            (document) => document.uri.toString() === entry.uri.toString(),
          );
          if (!open) {
            missing.push(entry.uri.toString());
          }
          return;
        }
        try {
          await vscode.workspace.fs.stat(entry.uri);
        } catch (error) {
          if (
            error instanceof vscode.FileSystemError &&
            error.code === "FileNotFound"
          ) {
            missing.push(entry.uri.toString());
          }
        }
      }),
    );
    for (const key of missing) {
      this.entries.delete(key);
    }
    if (missing.length > 0) {
      this.queuePersist(true);
    }
    this.emit();
  }

  getTreeItem(
    element: ActiveItem,
    kind: PanelKind = "recent",
  ): vscode.TreeItem {
    if (element.kind === "message") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None,
      );
      item.id = element.id;
      item.contextValue = "activeMessage";
      if (element.icon === "loading") {
        item.iconPath = new vscode.ThemeIcon("loading~spin");
      } else if (element.icon === "warning") {
        item.iconPath = new vscode.ThemeIcon("warning");
      }
      return item;
    }

    if (element.kind === "dir") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = element.id;
      item.contextValue = "activeDir";
      if (element.uri && kind !== "diffs") {
        item.resourceUri = element.uri;
      } else {
        item.iconPath = new vscode.ThemeIcon("folder");
      }
      return item;
    }

    const item = new vscode.TreeItem(
      baseName(element.uri),
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `file:${element.uri.toString()}`;
    if (kind === "diffs") {
      item.resourceUri = branchStatusUri(element.uri, element.detail);
      item.contextValue =
        element.detail === "deleted" ? "branchFileDeleted" : "branchFile";
      const where =
        this.diffsLayout === "list" ? locationLabel(element.uri) : "";
      item.description = where || undefined;
      item.tooltip = branchTooltip(element.uri);
      if (element.detail !== "deleted") {
        item.command = {
          command: "vscode.open",
          title: "Open",
          arguments: [element.uri],
        };
      }
      return item;
    }

    item.resourceUri = element.uri;
    item.contextValue = "activeFile";
    item.tooltip = tooltip(element.uri, element.editedAt);
    item.description =
      this.recentLayout === "list"
        ? listDescription(element.uri, element.editedAt)
        : element.detail;
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [element.uri],
    };
    return item;
  }

  getChildren(element?: ActiveItem, kind: PanelKind = "recent"): ActiveItem[] {
    const items = this.unfilteredChildren(element, kind);
    const filter = this.filterText(kind);
    if (element || filter.trim().length === 0) {
      return items;
    }
    const filtered = filterItems(items, (uri) => this.uriMatches(kind, uri));
    if (countFiles(filtered) === 0 && countFiles(items) > 0) {
      return [
        {
          kind: "message",
          id: "filter-empty",
          label: "No files match the filter.",
        },
      ];
    }
    return filtered;
  }

  private uriMatches(kind: PanelKind, uri: vscode.Uri): boolean {
    const place = filterPlace(uri);
    return matchesFilter(this.filterText(kind), place.relative, place.name);
  }

  private unfilteredChildren(
    element: ActiveItem | undefined,
    kind: PanelKind,
  ): ActiveItem[] {
    if (element?.kind === "file" || element?.kind === "message") {
      return [];
    }
    if (element?.kind === "dir") {
      return element.children;
    }
    if (kind === "diffs") {
      return this.branchChildren();
    }
    const tracked = [...this.entries.values()];
    if (this.recentLayout === "list") {
      return tracked
        .sort((a, b) => compareFileName(a.uri, b.uri))
        .map((entry) => ({
          kind: "file" as const,
          uri: entry.uri,
          editedAt: entry.editedAt,
        }));
    }
    return buildTree(tracked);
  }

  private branchChildren(): ActiveItem[] {
    if (this.branchMessage) {
      return [
        {
          kind: "message",
          id: "branch-message",
          label: this.branchMessage,
          icon: "warning",
        },
      ];
    }
    if (this.branchState === "loading" && this.branchEntries.length === 0) {
      return [
        {
          kind: "message",
          id: "branch-loading",
          label: `Comparing this branch with ${this.diffBaseLabel()}…`,
          icon: "loading",
        },
      ];
    }
    if (this.diffsLayout === "tree") {
      return buildTree(this.branchEntries);
    }
    return [...this.branchEntries]
      .sort((a, b) => compareFileName(a.uri, b.uri))
      .map((entry) => ({
        kind: "file" as const,
        uri: entry.uri,
        editedAt: entry.editedAt,
        detail: entry.detail,
      }));
  }

  private async loadBranchChanges(): Promise<boolean> {
    const generation = ++this.branchGeneration;
    const snapshot = await collectBranchChanges(this.diffBaseRef());
    if (generation !== this.branchGeneration || this.disposed) {
      return false;
    }
    this.branchEntries = snapshot.files.map((file) => ({
      uri: file.uri,
      editedAt: 0,
      detail: file.detail,
    }));
    this.branchMessage = snapshot.message;
    this.branchBase = snapshot.baseLabel;
    this.branchState = "ready";
    if (
      this.pinnedCommit &&
      snapshot.baseLabel !== this.pinnedCommit.slice(0, 7)
    ) {
      this.pinnedCommit = undefined;
      void this.workspaceState.update(DIFFS_COMMIT_KEY, undefined);
    }
    return true;
  }

  private cancelBranchReload(): void {
    if (this.branchTimer) {
      clearTimeout(this.branchTimer);
      this.branchTimer = undefined;
    }
  }

  private load(): void {
    const raw = this.workspaceState.get<unknown>(FILES_KEY, []);
    if (!Array.isArray(raw)) {
      return;
    }
    for (const item of raw) {
      if (!isPersistedEntry(item)) {
        continue;
      }
      try {
        const uri = vscode.Uri.parse(item.uri);
        if (!isTrackable(uri)) {
          continue;
        }
        this.entries.set(uri.toString(), { uri, editedAt: item.editedAt });
      } catch {
        // Skip entries that are no longer valid URIs.
      }
    }
    this.evict();
  }

  private evict(): boolean {
    const overflow = this.entries.size - MAX_TRACKED;
    if (overflow <= 0) {
      return false;
    }
    const oldest = [...this.entries.values()].sort(
      (a, b) => a.editedAt - b.editedAt,
    );
    for (let index = 0; index < overflow; index++) {
      this.entries.delete(oldest[index].uri.toString());
    }
    return true;
  }

  private deleteWithDescendants(uri: vscode.Uri): number {
    const prefix = uri.toString();
    const keys = [...this.entries.keys()].filter(
      (key) => key === prefix || key.startsWith(`${prefix}/`),
    );
    for (const key of keys) {
      this.entries.delete(key);
    }
    return keys.length;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.emit();
    }, REFRESH_DELAY_MS);
  }

  private cancelRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private queuePersist(immediate: boolean): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (immediate) {
      void this.persist();
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, PERSIST_DELAY_MS);
  }

  private persist(): Thenable<void> {
    const data: PersistedEntry[] = [...this.entries.values()].map((entry) => ({
      uri: entry.uri.toString(),
      editedAt: entry.editedAt,
    }));
    return this.workspaceState.update(FILES_KEY, data);
  }

  private emit(): void {
    if (this.disposed) {
      return;
    }
    this._onDidChangeTreeData.fire(undefined);
    this._onDidChangeCount.fire(this.count("recent"));
  }
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readCommit(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function isPersistedEntry(value: unknown): value is PersistedEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as { uri?: unknown; editedAt?: unknown };
  return (
    typeof entry.uri === "string" &&
    typeof entry.editedAt === "number" &&
    Number.isFinite(entry.editedAt)
  );
}

function filterPlace(uri: vscode.Uri): { relative: string; name: string } {
  const name = baseName(uri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return { relative: name, name };
  }
  const parts = relativeParts(folder.uri, uri);
  if (!parts || parts.length === 0) {
    return { relative: name, name };
  }
  const relative = parts.join("/");
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return {
    relative: multi ? `${folder.name}/${relative}` : relative,
    name,
  };
}

function filterItems(
  items: ActiveItem[],
  matches: (uri: vscode.Uri) => boolean,
): ActiveItem[] {
  const filtered: ActiveItem[] = [];
  for (const item of items) {
    if (item.kind === "message") {
      filtered.push(item);
      continue;
    }
    if (item.kind === "file") {
      if (matches(item.uri)) {
        filtered.push(item);
      }
      continue;
    }
    const children = filterItems(item.children, matches);
    if (children.length > 0) {
      filtered.push({ ...item, children });
    }
  }
  return filtered;
}

function countFiles(items: ActiveItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.kind === "file") {
      count += 1;
    } else if (item.kind === "dir") {
      count += countFiles(item.children);
    }
  }
  return count;
}

function compareFileName(a: vscode.Uri, b: vscode.Uri): number {
  const byName = baseName(a).localeCompare(baseName(b), undefined, {
    sensitivity: "base",
  });
  if (byName !== 0) {
    return byName;
  }
  return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
}

function baseName(uri: vscode.Uri): string {
  const slash = uri.path.lastIndexOf("/");
  const name = slash >= 0 ? uri.path.slice(slash + 1) : uri.path;
  return name || uri.toString(true);
}

function parentPath(uri: vscode.Uri): string {
  const slash = uri.path.lastIndexOf("/");
  return slash > 0 ? uri.path.slice(0, slash) : uri.scheme;
}

function relativeParts(
  folder: vscode.Uri,
  file: vscode.Uri,
): string[] | undefined {
  const base = folder.path.endsWith("/")
    ? folder.path.slice(0, -1)
    : folder.path;
  if (file.path !== base && !file.path.startsWith(`${base}/`)) {
    return undefined;
  }
  return file.path
    .slice(base.length + 1)
    .split("/")
    .filter((part) => part.length > 0);
}

function locationLabel(uri: vscode.Uri): string {
  if (uri.scheme === "untitled") {
    return "Untitled";
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return parentPath(uri);
  }
  const parts = relativeParts(folder.uri, uri);
  const dir = parts && parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  if (!dir) {
    return multi ? folder.name : "";
  }
  return multi ? `${folder.name}/${dir}` : dir;
}

function listDescription(uri: vscode.Uri, editedAt: number): string {
  const where = locationLabel(uri);
  const when = formatEdited(editedAt);
  return where ? `${where} · ${when}` : when;
}

function branchTooltip(uri: vscode.Uri): string {
  return uri.scheme === "file" ? uri.fsPath : uri.toString(true);
}

function branchStatusUri(
  file: vscode.Uri,
  detail: string | undefined,
): vscode.Uri {
  const tone = branchTone(detail);
  if (!tone) {
    return file;
  }
  return vscode.Uri.from({
    scheme: BRANCH_STATUS_SCHEME,
    path: file.path,
    query: tone,
  });
}

function branchTone(
  detail: string | undefined,
): "new" | "modified" | "deleted" | "" {
  switch (detail) {
    case "local":
      return "";
    case "added":
    case "untracked":
    case "renamed":
    case "copied":
      return "new";
    case "deleted":
      return "deleted";
    default:
      return "modified";
  }
}

function branchToneColor(tone: string): string {
  if (tone === "new") {
    return "charts.green";
  }
  if (tone === "deleted") {
    return "charts.red";
  }
  return "charts.orange";
}

function tooltip(uri: vscode.Uri, editedAt: number): string {
  const location =
    uri.scheme === "file" || uri.scheme === "untitled"
      ? uri.fsPath || uri.path
      : uri.toString(true);
  return `${location}\nLast edit ${formatEdited(editedAt)}`;
}

function formatEdited(editedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - editedAt) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function buildTree(entries: Tracked[]): ActiveItem[] {
  interface Bucket {
    label: string;
    id: string;
    uri?: vscode.Uri;
    dirs: Map<string, Bucket>;
    files: FileItem[];
  }

  const root: Bucket = { label: "", id: "root", dirs: new Map(), files: [] };
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

  const ensure = (
    parent: Bucket,
    key: string,
    label: string,
    uri?: vscode.Uri,
  ): Bucket => {
    let child = parent.dirs.get(key);
    if (!child) {
      child = {
        label,
        id: `${parent.id}/${key}`,
        uri,
        dirs: new Map(),
        files: [],
      };
      parent.dirs.set(key, child);
    }
    return child;
  };

  for (const entry of entries) {
    const file: FileItem = {
      kind: "file",
      uri: entry.uri,
      editedAt: entry.editedAt,
      detail: entry.detail,
    };
    if (entry.uri.scheme === "untitled") {
      file.detail = "Untitled";
      ensure(root, "untitled", "Untitled").files.push(file);
      continue;
    }
    const folder = vscode.workspace.getWorkspaceFolder(entry.uri);
    if (!folder) {
      if (!file.detail) {
        file.detail = parentPath(entry.uri);
      }
      ensure(root, "outside", "Outside workspace").files.push(file);
      continue;
    }

    let parent = root;
    if (multi) {
      parent = ensure(
        parent,
        `ws:${folder.uri.toString()}`,
        folder.name,
        folder.uri,
      );
    }
    const parts = relativeParts(folder.uri, entry.uri);
    if (!parts || parts.length === 0) {
      parent.files.push(file);
      continue;
    }
    for (let index = 0; index < parts.length - 1; index++) {
      const dirUri = vscode.Uri.joinPath(
        folder.uri,
        ...parts.slice(0, index + 1),
      );
      parent = ensure(parent, dirUri.toString(), parts[index], dirUri);
    }
    parent.files.push(file);
  }

  const toItems = (bucket: Bucket): ActiveItem[] => {
    const dirs = [...bucket.dirs.values()]
      .sort((a, b) =>
        a.label.localeCompare(b.label, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      )
      .map((dir) => ({
        kind: "dir" as const,
        id: dir.id,
        label: dir.label,
        uri: dir.uri,
        children: toItems(dir),
      }));
    const files = [...bucket.files].sort((a, b) =>
      baseName(a.uri).localeCompare(baseName(b.uri), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
    return [...dirs, ...files];
  };

  return compactDirs(toItems(root));
}

function compactDirs(items: ActiveItem[]): ActiveItem[] {
  return items.map((item) => {
    if (item.kind !== "dir") {
      return item;
    }
    let current: DirItem = { ...item, children: compactDirs(item.children) };
    const labels = [current.label];
    while (
      current.children.length === 1 &&
      current.children[0].kind === "dir"
    ) {
      current = current.children[0];
      labels.push(current.label);
    }
    if (labels.length === 1) {
      return current;
    }
    return {
      kind: "dir",
      id: current.id,
      label: labels.join("/"),
      uri: current.uri,
      children: current.children,
    };
  });
}
