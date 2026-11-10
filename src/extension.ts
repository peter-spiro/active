import * as vscode from "vscode";
import { ActivePanel } from "./activePanel";
import {
  ActiveFilesProvider,
  isTrackable,
  registerBranchStatusDecorations,
  uriFromCommandArgument,
  type Layout,
  type PanelKind,
} from "./activeFilesProvider";
import {
  checkoutBranchTip,
  checkoutDiffCommit,
  commitRefExists,
  listDiffChain,
  openBranchDiff,
  registerBranchDiffProvider,
  watchBranchSignals,
} from "./branchChanges";
import { BranchListPanel } from "./branchListPanel";
import { disposeCommandLog } from "./commandLog";
import { BranchSwitch } from "./branchSwitch";
import { Favorites, openFavoriteTarget } from "./favorites";
import { FavoritesPanel } from "./favoritesPanel";
import { LocalBranches } from "./localBranches";
import { pareBranches } from "./pareBranches";
import { Search2Panel } from "./search2Panel";
import { StackList } from "./stack";

const RECENT_LAYOUT_KEY = "activeFilesLayout";
const DIFFS_LAYOUT_KEY = "diffsLayout";
const DIFFS_STACK_PARENT_KEY = "diffs.hasStackParent";
const DIFFS_BASE_KEY = "diffs.base";
const DIFFS_VIEWING_COMMIT_KEY = "diffs.viewingCommit";
const FAVORITE_ACTIVE_KEY = "favorites.active";
const FAVORITE_CAN_ADD_KEY = "favorites.canAdd";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ActiveFilesProvider(
    context.workspaceState,
    context.globalState,
  );
  const favorites = new Favorites(context.globalState, context.workspaceState);
  const recentPanel = new ActivePanel(provider, "recent", favorites);
  const diffsPanel = new ActivePanel(provider, "diffs", favorites);
  const favoritesPanel = new FavoritesPanel(favorites);
  const branchSwitch = new BranchSwitch(context.workspaceState);
  const stack = new StackList(branchSwitch);
  const stackPanel = new BranchListPanel(stack, "level");
  const branches = new LocalBranches(branchSwitch);
  const branchesPanel = new BranchListPanel(branches, "branch");
  const searchPanel = new Search2Panel(context.workspaceState);
  const publishLayouts = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      RECENT_LAYOUT_KEY,
      provider.layoutMode("recent"),
    );
    void vscode.commands.executeCommand(
      "setContext",
      DIFFS_LAYOUT_KEY,
      provider.layoutMode("diffs"),
    );
  };

  const publishDiffBase = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      DIFFS_STACK_PARENT_KEY,
      provider.hasStackParent,
    );
    void vscode.commands.executeCommand(
      "setContext",
      DIFFS_BASE_KEY,
      provider.diffBase,
    );
    void vscode.commands.executeCommand(
      "setContext",
      DIFFS_VIEWING_COMMIT_KEY,
      provider.viewingCommit,
    );
  };

  const selectDiffBase = async (mode: "main" | "parent"): Promise<void> => {
    await provider.useDiffBase(mode);
    publishDiffBase();
  };

  const showLayout = async (kind: PanelKind, layout: Layout): Promise<void> => {
    await provider.setLayout(kind, layout);
    publishLayouts();
  };

  const publishFavorite = (): void => {
    const uri = openFavoriteTarget();
    const favorite = !!uri && favorites.has(uri);
    void vscode.commands.executeCommand(
      "setContext",
      FAVORITE_ACTIVE_KEY,
      favorite,
    );
    void vscode.commands.executeCommand(
      "setContext",
      FAVORITE_CAN_ADD_KEY,
      !!uri && !favorite,
    );
  };

  const tagOpen = (add: boolean): void => {
    const uri = openFavoriteTarget();
    if (!uri) {
      void vscode.window.showInformationMessage(
        "Open a file to tag it as a favorite.",
      );
      return;
    }
    if (add) {
      favorites.add(uri);
    } else {
      favorites.remove(uri);
    }
  };

  context.subscriptions.push(
    provider.onDidChangeDiffMode(publishDiffBase),
    { dispose: disposeCommandLog },
    recentPanel,
    diffsPanel,
    provider,
    favorites,
    favoritesPanel,
    stack,
    stackPanel,
    branches,
    branchesPanel,
    searchPanel,
    vscode.window.registerWebviewViewProvider("stackLevels", stackPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("localBranches", branchesPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("diffFiles", diffsPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("activeFiles", recentPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("favoriteFiles", favoritesPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("search2", searchPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    recentPanel.onDidChangeVisibility((visible) => {
      if (visible) {
        provider.redraw();
      }
    }),
    diffsPanel.onDidChangeVisibility((visible) => {
      if (visible) {
        void provider.reloadBranch();
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
        favorites.rename(file.oldUri, file.newUri);
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        provider.forget(uri);
        favorites.remove(uri);
      }
      if (event.files.length > 0) {
        provider.onBranchDirty();
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
      provider.refresh("recent"),
    ),
    vscode.commands.registerCommand("activeFiles.collapseAll", () =>
      recentPanel.collapseAll(),
    ),
    vscode.commands.registerCommand("activeFiles.clear", () => {
      provider.clear();
    }),
    vscode.commands.registerCommand("activeFiles.showList", () =>
      showLayout("recent", "list"),
    ),
    vscode.commands.registerCommand("activeFiles.showTree", () =>
      showLayout("recent", "tree"),
    ),
    vscode.commands.registerCommand("diffs.refresh", () =>
      provider.refresh("diffs"),
    ),
    vscode.commands.registerCommand("diffs.collapseAll", () =>
      diffsPanel.collapseAll(),
    ),
    vscode.commands.registerCommand("diffs.showList", () =>
      showLayout("diffs", "list"),
    ),
    vscode.commands.registerCommand("diffs.showTree", () =>
      showLayout("diffs", "tree"),
    ),
    vscode.commands.registerCommand("diffs.levelOn", () =>
      selectDiffBase("parent"),
    ),
    vscode.commands.registerCommand("diffs.levelOff", () =>
      selectDiffBase("parent"),
    ),
    vscode.commands.registerCommand("diffs.mainOn", () =>
      selectDiffBase("main"),
    ),
    vscode.commands.registerCommand("diffs.mainOff", () =>
      selectDiffBase("main"),
    ),
    vscode.commands.registerCommand("diffs.pickCommit", () =>
      pickDiffCommit(provider, publishDiffBase),
    ),
    vscode.commands.registerCommand("diffs.returnToTip", () =>
      leaveCommit(provider, publishDiffBase),
    ),
    vscode.commands.registerCommand("diffs.configureBase", () =>
      configureCompareBranch(provider),
    ),
    stack.onDidChange(() => {
      const tip = provider.tipBranchName;
      if (provider.viewingCommit && tip) {
        const known = stack.levels.some((level) => level.name === tip);
        if (known) {
          provider.setStackParent(stack.parentOf(tip));
        }
      } else {
        provider.setStackParent(stack.parentBranch());
      }
      publishDiffBase();
    }),
    vscode.commands.registerCommand("activeFiles.openDiff", (arg: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : uriFromCommandArgument(arg);
      if (uri) {
        void openBranchDiff(uri, provider.rangeRef(), provider.pinnedCommitSha);
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
    vscode.commands.registerCommand("favorites.addOpen", () => tagOpen(true)),
    vscode.commands.registerCommand("favorites.removeOpen", () =>
      tagOpen(false),
    ),
    vscode.commands.registerCommand(
      "favorites.addFolder",
      (...args: unknown[]) => {
        for (const uri of folderUris(args)) {
          favorites.add(uri, true);
        }
      },
    ),
    vscode.commands.registerCommand("favorites.pickFolder", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Add to Favorites",
        title: "Add folder to Favorites",
      });
      const folder = picked?.[0];
      if (folder) {
        favorites.add(folder, true);
      }
    }),
    vscode.commands.registerCommand("stack.add", () => {
      void stack.addBranch();
    }),
    vscode.commands.registerCommand("stack.unstack", () => {
      void stack.unstack();
    }),
    vscode.commands.registerCommand("stack.refresh", () => stack.refresh()),
    vscode.commands.registerCommand("branches.refresh", () =>
      branches.refresh(),
    ),
    vscode.commands.registerCommand("branches.pare", () => {
      void pareBranches(branchSwitch).finally(() => branches.refresh());
    }),
    vscode.commands.registerCommand("search2.refresh", () =>
      searchPanel.refresh(),
    ),
    vscode.commands.registerCommand("search2.show", () =>
      vscode.commands.executeCommand("search2.focus"),
    ),
    favorites.onDidChange(publishFavorite),
    vscode.window.onDidChangeActiveTextEditor(() => {
      publishFavorite();
      publishActiveFile();
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      publishFavorite();
      publishActiveFile();
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

  publishLayouts();
  publishFavorite();
  publishActiveFile();
  publishDiffBase();
  void provider.ensureBranchLoaded();

  function publishActiveFile(): void {
    diffsPanel.setActiveFile(activeFileUri());
  }
}

function activeFileUri(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (
    input instanceof vscode.TabInputTextDiff ||
    input instanceof vscode.TabInputNotebookDiff
  ) {
    if (isTrackable(input.modified)) {
      return input.modified.toString();
    }
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && isTrackable(editor.document.uri)) {
    return editor.document.uri.toString();
  }
  if (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputNotebook ||
    input instanceof vscode.TabInputCustom
  ) {
    if (isTrackable(input.uri)) {
      return input.uri.toString();
    }
  }
  return undefined;
}

function folderUris(args: unknown[]): vscode.Uri[] {
  const found: vscode.Uri[] = [];
  for (const arg of args) {
    if (arg instanceof vscode.Uri) {
      found.push(arg);
    } else if (Array.isArray(arg)) {
      for (const item of arg) {
        if (item instanceof vscode.Uri) {
          found.push(item);
        }
      }
    }
  }
  return found;
}

function openFile(uri: vscode.Uri): Thenable<unknown> {
  return vscode.commands.executeCommand("vscode.open", uri);
}

async function configureCompareBranch(
  provider: ActiveFilesProvider,
): Promise<void> {
  const current = provider.compareBranchName ?? "";
  const entered = await vscode.window.showInputBox({
    title: "Compare with branch",
    prompt:
      "Three-dot diff compares the working tree with this branch. Leave empty to use main.",
    value: current,
    ignoreFocusOut: true,
  });
  if (entered === undefined) {
    return;
  }
  const name = entered.trim();
  if (name === current) {
    return;
  }
  if (name && !(await commitRefExists(name))) {
    void vscode.window.showErrorMessage(`No branch named ${name}.`);
    return;
  }
  await provider.setCompareBranch(name || undefined);
}

async function pickDiffCommit(
  provider: ActiveFilesProvider,
  publishDiffBase: () => void,
): Promise<void> {
  let chain;
  try {
    chain = await listDiffChain(provider.rangeRef(), provider.tipBranchName);
  } catch {
    void vscode.window.showErrorMessage(
      "Couldn't list commits on this branch.",
    );
    return;
  }
  if (!chain) {
    void vscode.window.showInformationMessage(
      "Open a local git folder to choose a commit.",
    );
    return;
  }
  const current = provider.pinnedCommitSha;
  const items: Array<vscode.QuickPickItem & { sha?: string }> = [];
  for (const commit of chain.commits) {
    const selected = commit.sha.toLowerCase() === current;
    items.push({
      label: selected ? `$(check) ${commit.subject}` : commit.subject,
      description: commit.head
        ? `${commit.sha.slice(0, 7)} · tip`
        : commit.sha.slice(0, 7),
      sha: commit.sha.toLowerCase(),
    });
  }
  items.push({
    label: current ? chain.label : `$(check) ${chain.label}`,
    description: chain.baseSha.slice(0, 7),
    detail: "Branch point",
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: `Commits on ${chain.tipName}`,
    placeHolder: "Check out a commit to see that commit's diff",
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }
  if (!picked.sha) {
    await leaveCommit(provider, publishDiffBase);
    return;
  }
  provider.holdBranchReload();
  try {
    const moved = await checkoutDiffCommit(picked.sha, provider.tipBranchName);
    if ("error" in moved) {
      void vscode.window.showErrorMessage(moved.error);
      return;
    }
    await provider.showCommit(picked.sha, moved.tip);
    publishDiffBase();
  } finally {
    provider.releaseBranchReload();
  }
}

async function leaveCommit(
  provider: ActiveFilesProvider,
  publishDiffBase: () => void,
): Promise<void> {
  const tip = provider.tipBranchName;
  if (!provider.viewingCommit && !tip) {
    return;
  }
  provider.holdBranchReload();
  try {
    if (tip) {
      const error = await checkoutBranchTip(tip);
      if (error) {
        void vscode.window.showErrorMessage(error);
        return;
      }
    }
    await provider.clearCommitView();
    publishDiffBase();
  } finally {
    provider.releaseBranchReload();
  }
}

export function deactivate(): void {
  disposeCommandLog();
}
