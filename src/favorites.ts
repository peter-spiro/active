import * as path from "node:path";
import * as vscode from "vscode";

const KEY = "favorites.entries";

type SyncedState = vscode.Memento & {
  setKeysForSync(keys: readonly string[]): void;
};

type Favorite = {
  uri: vscode.Uri;
  folder: boolean;
};

export class Favorites implements vscode.Disposable {
  private readonly items = new Map<string, Favorite>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly globalState: SyncedState,
    workspaceState: vscode.Memento,
  ) {
    this.globalState.setKeysForSync([KEY]);
    this.read(this.globalState);
    const before = this.items.size;
    this.read(workspaceState);
    const workspaceRaw = workspaceState.get<unknown>(KEY, []);
    const hadWorkspace = Array.isArray(workspaceRaw) && workspaceRaw.length > 0;
    if (hadWorkspace) {
      void workspaceState.update(KEY, undefined);
    }
    if (this.items.size !== before) {
      void this.globalState.update(KEY, storedEntries(this.items));
    }
  }

  dispose(): void {
    this.changed.dispose();
  }

  get count(): number {
    return this.items.size;
  }

  has(uri: vscode.Uri): boolean {
    return this.items.has(uri.toString());
  }

  list(): vscode.Uri[] {
    return [...this.items.values()]
      .sort((a, b) => {
        if (a.folder !== b.folder) {
          return a.folder ? -1 : 1;
        }
        const name = fileName(a.uri).localeCompare(fileName(b.uri), undefined, {
          sensitivity: "base",
        });
        if (name !== 0) {
          return name;
        }
        return a.uri.path.localeCompare(b.uri.path, undefined, {
          sensitivity: "base",
        });
      })
      .map((item) => item.uri);
  }

  isFolder(uri: vscode.Uri): boolean {
    return this.items.get(uri.toString())?.folder === true;
  }

  add(uri: vscode.Uri, folder = false): void {
    if (!isFavoriteFile(uri)) {
      return;
    }
    const key = uri.toString();
    const existing = this.items.get(key);
    if (existing) {
      if (folder && !existing.folder) {
        existing.folder = true;
        this.persist();
      }
      return;
    }
    this.items.set(key, { uri, folder });
    this.persist();
  }

  remove(uri: vscode.Uri): void {
    if (!this.items.delete(uri.toString())) {
      return;
    }
    this.persist();
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const existing = this.items.get(oldUri.toString());
    if (!existing || !this.items.delete(oldUri.toString())) {
      return;
    }
    if (isFavoriteFile(newUri)) {
      this.items.set(newUri.toString(), {
        uri: newUri,
        folder: existing.folder,
      });
    }
    this.persist();
  }

  private persist(): void {
    void this.globalState.update(KEY, storedEntries(this.items));
    this.changed.fire();
  }

  private read(state: vscode.Memento): void {
    const raw = state.get<unknown>(KEY, []);
    if (!Array.isArray(raw)) {
      return;
    }
    for (const entry of raw) {
      const parsed = storedFavorite(entry);
      if (!parsed) {
        continue;
      }
      try {
        const uri = vscode.Uri.parse(parsed.uri);
        if (isFavoriteFile(uri)) {
          this.items.set(uri.toString(), { uri, folder: parsed.folder });
        }
      } catch {
        // Drop entries that are no longer valid URIs.
      }
    }
  }
}

function storedEntries(
  items: ReadonlyMap<string, Favorite>,
): Array<string | { uri: string; folder: true }> {
  return [...items.values()].map((item) =>
    item.folder
      ? { uri: item.uri.toString(), folder: true }
      : item.uri.toString(),
  );
}

function storedFavorite(
  entry: unknown,
): { uri: string; folder: boolean } | undefined {
  if (typeof entry === "string") {
    return { uri: entry, folder: false };
  }
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const uri = (entry as { uri?: unknown }).uri;
  if (typeof uri !== "string") {
    return undefined;
  }
  return { uri, folder: (entry as { folder?: unknown }).folder === true };
}

export function isFavoriteFile(uri: vscode.Uri): boolean {
  return (
    uri.scheme === "file" ||
    uri.scheme === "vscode-remote" ||
    uri.scheme === "vscode-vfs"
  );
}

export function openFavoriteTarget(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && isFavoriteFile(editor.document.uri)) {
    return editor.document.uri;
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri = tabUri(input);
  return uri && isFavoriteFile(uri) ? uri : undefined;
}

export function favoritePlace(uri: vscode.Uri): {
  name: string;
  dir: string;
  tooltip: string;
} {
  const name = fileName(uri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folder) {
    const slash = uri.path.lastIndexOf("/");
    return {
      name,
      dir: slash > 0 ? uri.path.slice(0, slash) : "",
      tooltip: uri.fsPath || uri.toString(true),
    };
  }
  const relative = path.posix.relative(folder.uri.path, uri.path);
  const parent = path.posix.dirname(relative);
  const prefix = folders.length > 1 ? folder.name : "";
  const dir =
    parent && parent !== "."
      ? prefix
        ? `${prefix}/${parent}`
        : parent
      : prefix;
  return { name, dir, tooltip: relative || name };
}

function tabUri(input: unknown): vscode.Uri | undefined {
  if (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputNotebook ||
    input instanceof vscode.TabInputCustom
  ) {
    return input.uri;
  }
  if (
    input instanceof vscode.TabInputTextDiff ||
    input instanceof vscode.TabInputNotebookDiff
  ) {
    return input.modified;
  }
  return undefined;
}

function fileName(uri: vscode.Uri): string {
  const slash = uri.path.lastIndexOf("/");
  const name = slash >= 0 ? uri.path.slice(slash + 1) : uri.path;
  return name || uri.toString(true);
}
