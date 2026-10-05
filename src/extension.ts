import * as vscode from "vscode";
import {
  ActiveFilesProvider,
  isBranchMode,
  isTrackable,
  registerBranchStatusDecorations,
  uriFromCommandArgument,
  type ContentMode,
  type Layout,
} from "./activeFilesProvider";
import {
  openBranchDiff,
  registerBranchDiffProvider,
  watchBranchSignals,
} from "./branchChanges";

const DOUBLE_CLICK_MS = 350;
const CONTENT_MODE_KEY = "activeFilesContentMode";
const LAYOUT_KEY = "activeFilesLayout";
const BRANCH_MODE_KEY = "activeFilesBranch";

const MODE_CHOICES: Array<{
  mode: ContentMode;
  label: string;
  description: string;
}> = [
  {
    mode: "active",
    label: "Active",
    description: "Files you have edited",
  },
  {
    mode: "branchOpen",
    label: "Branch - Open",
    description: "Open files changed since this branch left main",
  },
  {
    mode: "branchDiff",
    label: "Branch - Diff",
    description: "Review diffs against the point this branch left main",
  },
];

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ActiveFilesProvider(
    context.workspaceState,
    context.globalState,
  );
  publishChrome(provider.contentMode, provider.layoutMode);
  const treeView = vscode.window.createTreeView("activeFiles", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  const syncChrome = (): void => {
    treeView.description = `${contentLabel(provider.contentMode)} · ${layoutLabel(provider.layoutMode)}`;
    publishChrome(provider.contentMode, provider.layoutMode);
  };

  const showMode = async (mode: ContentMode): Promise<void> => {
    const pending = provider.setMode(mode);
    syncChrome();
    await pending;
  };

  const showLayout = async (layout: Layout): Promise<void> => {
    const pending = provider.setLayout(layout);
    syncChrome();
    await pending;
  };

  const updateBadge = (count: number): void => {
    if (count <= 0) {
      treeView.badge = undefined;
      return;
    }
    const branch = isBranchMode(provider.contentMode);
    const noun = branch
      ? count === 1
        ? "changed file"
        : "changed files"
      : count === 1
        ? "edited file"
        : "edited files";
    treeView.badge = {
      value: count,
      tooltip: `${count} ${noun}`,
    };
  };

  const selectMode = async (): Promise<void> => {
    const current = provider.contentMode;
    const picked = await vscode.window.showQuickPick(
      MODE_CHOICES.map((choice) => ({
        label: `${choice.mode === current ? "$(check)" : "$(blank)"} ${choice.label}`,
        description: choice.description,
        mode: choice.mode,
      })),
      { title: "Select mode", placeHolder: contentLabel(current) },
    );
    if (!picked) {
      return;
    }
    await showMode(picked.mode);
  };

  context.subscriptions.push(
    treeView,
    provider,
    provider.onDidChangeCount(updateBadge),
    treeView.onDidChangeVisibility((event) => {
      if (!event.visible) {
        return;
      }
      if (isBranchMode(provider.contentMode)) {
        void provider.reloadBranch();
      } else {
        provider.redraw();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        event.contentChanges.length === 0 ||
        !isTrackable(event.document.uri)
      ) {
        return;
      }
      provider.touch(event.document.uri);
    }),
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.contentChanges.length === 0 && event.cellChanges.length === 0) {
        return;
      }
      if (!isTrackable(event.notebook.uri)) {
        return;
      }
      provider.touch(event.notebook.uri);
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        provider.rename(file.oldUri, file.newUri);
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        provider.forget(uri);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === "untitled") {
        provider.remove(document.uri);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isTrackable(document.uri)) {
        provider.onBranchDirty();
      }
    }),
    vscode.workspace.onDidCreateFiles(() => {
      provider.onBranchDirty();
    }),
    watchBranchSignals(() => provider.onBranchDirty()),
    vscode.commands.registerCommand("activeFiles.refresh", () =>
      provider.refresh(),
    ),
    vscode.commands.registerCommand("activeFiles.clear", () => {
      if (!isBranchMode(provider.contentMode)) {
        provider.clear();
      }
    }),
    vscode.commands.registerCommand("activeFiles.selectMode", () =>
      selectMode(),
    ),
    vscode.commands.registerCommand("activeFiles.showList", () =>
      showLayout("list"),
    ),
    vscode.commands.registerCommand("activeFiles.showTree", () =>
      showLayout("tree"),
    ),
    vscode.commands.registerCommand("activeFiles.showActive", () =>
      showMode("active"),
    ),
    vscode.commands.registerCommand("activeFiles.showBranch", () =>
      showMode("branchOpen"),
    ),
    vscode.commands.registerCommand("activeFiles.showBranchDiff", () =>
      showMode("branchDiff"),
    ),
    vscode.commands.registerCommand("activeFiles.openDiff", (arg: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : uriFromCommandArgument(arg);
      if (uri) {
        openDiffOrFile(uri);
      }
    }),
    vscode.commands.registerCommand("activeFiles.openFile", (arg: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : uriFromCommandArgument(arg);
      if (uri) {
        return openFile(uri);
      }
    }),
    registerBranchDiffProvider(),
    registerBranchStatusDecorations(),
    vscode.commands.registerCommand("activeFiles.remove", (arg: unknown) => {
      const uri = uriFromCommandArgument(arg);
      if (uri) {
        provider.remove(uri);
      }
    }),
  );

  let seeded = false;
  for (const document of vscode.workspace.textDocuments) {
    if (
      document.isDirty &&
      isTrackable(document.uri) &&
      provider.seed(document.uri)
    ) {
      seeded = true;
    }
  }
  if (seeded) {
    provider.commit();
  }

  syncChrome();
  updateBadge(provider.count);
  if (isBranchMode(provider.contentMode)) {
    void provider.ensureBranchLoaded();
  }
}

function publishChrome(mode: ContentMode, layout: Layout): void {
  void vscode.commands.executeCommand("setContext", CONTENT_MODE_KEY, mode);
  void vscode.commands.executeCommand("setContext", LAYOUT_KEY, layout);
  void vscode.commands.executeCommand(
    "setContext",
    BRANCH_MODE_KEY,
    isBranchMode(mode),
  );
}

let pendingOpen:
  | { key: string; uri: vscode.Uri; timer: ReturnType<typeof setTimeout> }
  | undefined;

function openDiffOrFile(uri: vscode.Uri): void {
  const key = uri.toString();
  if (pendingOpen?.key === key) {
    clearTimeout(pendingOpen.timer);
    pendingOpen = undefined;
    void openFile(uri);
    return;
  }
  if (pendingOpen) {
    clearTimeout(pendingOpen.timer);
    void openBranchDiff(pendingOpen.uri);
  }
  pendingOpen = {
    key,
    uri,
    timer: setTimeout(() => {
      const opening = pendingOpen;
      pendingOpen = undefined;
      if (opening) {
        void openBranchDiff(opening.uri);
      }
    }, DOUBLE_CLICK_MS),
  };
}

function openFile(uri: vscode.Uri): Thenable<unknown> {
  return vscode.commands.executeCommand("vscode.open", uri);
}

function contentLabel(mode: ContentMode): string {
  if (mode === "branchOpen") {
    return "Branch - Open";
  }
  if (mode === "branchDiff") {
    return "Branch - Diff";
  }
  return "Active";
}

function layoutLabel(layout: Layout): string {
  return layout === "tree" ? "Tree" : "List";
}

export function deactivate(): void {}
