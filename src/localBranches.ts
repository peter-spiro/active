import * as vscode from "vscode";
import { type BranchRow } from "./branchListPanel";
import {
  BranchSwitch,
  failureText,
  repoRoot,
  run,
  workspaceFolder,
} from "./branchSwitch";

export type LocalBranch = {
  name: string;
  current: boolean;
  parked?: string;
  local: boolean;
  defaultBranch: boolean;
};

export class LocalBranches implements vscode.Disposable {
  private readonly branchesInternal: LocalBranch[] = [];
  private status = "Loading branches…";
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private headWatchers: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  readonly onDidChange = this.changed.event;

  constructor(private readonly switcher: BranchSwitch) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rewatch();
        this.schedule();
      }),
    );
    this.rewatch();
    this.schedule();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.generation += 1;
    this.changed.dispose();
    for (const watcher of this.headWatchers) {
      watcher.dispose();
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  get branches(): readonly LocalBranch[] {
    return this.branchesInternal;
  }

  get message(): string {
    return this.branchesInternal.length > 0 ? "" : this.status;
  }

  get rows(): readonly BranchRow[] {
    return this.branchesInternal.map((branch) => ({
      name: branch.name,
      current: branch.current,
      detail: branch.parked ? "changes parked" : "",
      title: branch.parked
        ? "These changes will be uncommitted when you switch back"
        : branch.name,
      removable: !branch.defaultBranch,
    }));
  }

  refresh(): void {
    this.schedule();
  }

  async switchTo(branch: string): Promise<void> {
    const item = this.branchesInternal.find((entry) => entry.name === branch);
    if (!item || item.current) {
      return;
    }
    if (!item.local) {
      const folder = workspaceFolder();
      const root = folder ? await repoRoot(folder) : undefined;
      if (!root) {
        return;
      }
      try {
        await run(
          "git",
          ["branch", "--track", branch, `origin/${branch}`],
          root,
        );
      } catch (error) {
        void vscode.window.showErrorMessage(failureText(error));
        return;
      }
    }
    await this.switcher.checkout(branch);
  }

  async deleteBranch(name: string): Promise<void> {
    const item = this.branchesInternal.find((entry) => entry.name === name);
    if (!item || item.defaultBranch) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Delete local branch ${name}?`,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") {
      return;
    }
    if (item.current) {
      void vscode.window.showErrorMessage(
        `Check out another branch before deleting ${name}.`,
      );
      return;
    }
    const folder = workspaceFolder();
    const root = folder ? await repoRoot(folder) : undefined;
    if (!root) {
      return;
    }
    try {
      await run("git", ["branch", "-D", "--", name], root);
      this.switcher.forgetParked(root, name);
      this.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(failureText(error));
    }
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.load();
    }, 200);
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    const folder = workspaceFolder();
    if (generation !== this.generation) {
      return;
    }
    if (!folder) {
      this.replace([], "Open a folder to see its branches.");
      return;
    }
    const root = await repoRoot(folder);
    if (generation !== this.generation) {
      return;
    }
    if (!root) {
      this.replace([], "This folder is not a git repository.");
      return;
    }
    let listing = "";
    let current = "";
    try {
      listing = await run(
        "git",
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        root,
      );
      current = (await run("git", ["branch", "--show-current"], root)).trim();
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.replace([], failureText(error));
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    const names = listing
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const trunk = await defaultBranch(root, names);
    if (generation !== this.generation) {
      return;
    }
    if (trunk && !names.includes(trunk)) {
      names.push(trunk);
    }
    names.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    const branches = names.map((name) => ({
      name,
      current: name === current,
      parked: this.switcher.hasParked(root, name) ? name : undefined,
      local: name !== trunk || listingIncludes(listing, name),
      defaultBranch: name === trunk,
    }));
    this.replace(
      branches,
      branches.length === 0 ? "This repository has no local branches." : "",
    );
  }

  private replace(branches: LocalBranch[], status: string): void {
    this.branchesInternal.splice(0, this.branchesInternal.length, ...branches);
    this.status = status;
    this.changed.fire();
  }

  private rewatch(): void {
    for (const watcher of this.headWatchers) {
      watcher.dispose();
    }
    this.headWatchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, ".git/HEAD"),
      );
      const refs = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, ".git/refs/heads/**"),
      );
      const originHead = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, ".git/refs/remotes/origin/HEAD"),
      );
      const packed = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, ".git/packed-refs"),
      );
      const notify = (): void => this.schedule();
      this.headWatchers.push(
        watcher,
        refs,
        packed,
        originHead,
        watcher.onDidChange(notify),
        watcher.onDidCreate(notify),
        watcher.onDidDelete(notify),
        refs.onDidChange(notify),
        refs.onDidCreate(notify),
        refs.onDidDelete(notify),
        packed.onDidChange(notify),
        packed.onDidCreate(notify),
        packed.onDidDelete(notify),
        originHead.onDidChange(notify),
        originHead.onDidCreate(notify),
        originHead.onDidDelete(notify),
      );
    }
  }
}

async function defaultBranch(
  root: string,
  localNames: readonly string[],
): Promise<string | undefined> {
  try {
    const ref = (
      await run(
        "git",
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        root,
      )
    ).trim();
    const name = ref.replace(/^origin\//, "");
    if (
      name.length > 0 &&
      (localNames.includes(name) || (await remoteBranchExists(root, name)))
    ) {
      return name;
    }
  } catch {
    // Repos without origin/HEAD fall through to main or master.
  }
  for (const name of ["main", "master"]) {
    if (localNames.includes(name) || (await remoteBranchExists(root, name))) {
      return name;
    }
  }
  return undefined;
}

async function remoteBranchExists(
  root: string,
  name: string,
): Promise<boolean> {
  try {
    await run(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`],
      root,
    );
    return true;
  } catch {
    return false;
  }
}

function listingIncludes(listing: string, name: string): boolean {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .includes(name);
}
