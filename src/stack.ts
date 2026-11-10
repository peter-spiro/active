import * as vscode from "vscode";
import { type BranchRow } from "./branchListPanel";
import {
  BranchSwitch,
  failureText,
  isMissing,
  repoRoot,
  run,
  workspaceFolder,
} from "./branchSwitch";

export type StackLevel = {
  name: string;
  current: boolean;
  trunk: boolean;
  pr?: number;
  parked?: string;
};

type ViewBranch = {
  name?: unknown;
  isCurrent?: unknown;
  pr?: { number?: unknown };
};

type ViewJson = {
  trunk?: unknown;
  currentBranch?: unknown;
  branches?: unknown;
};

export class StackList implements vscode.Disposable {
  private readonly levelsInternal: StackLevel[] = [];
  private status = "Loading stack…";
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

  get levels(): readonly StackLevel[] {
    return this.levelsInternal;
  }

  get message(): string {
    return this.levelsInternal.length > 0 ? "" : this.status;
  }

  parentBranch(): string | undefined {
    const current = this.levelsInternal.find(
      (level) => level.current && !level.trunk,
    );
    return current ? this.parentOf(current.name) : undefined;
  }

  parentOf(branch: string): string | undefined {
    const branches = this.levelsInternal.filter((level) => !level.trunk);
    const index = branches.findIndex((level) => level.name === branch);
    if (index < 0 || index + 1 >= branches.length) {
      return undefined;
    }
    return branches[index + 1].name;
  }

  get rows(): readonly BranchRow[] {
    return this.levelsInternal.map((level) => {
      const parts: string[] = [];
      if (level.trunk) {
        parts.push("trunk");
      } else if (level.pr) {
        parts.push(`#${level.pr}`);
      }
      if (level.parked) {
        parts.push("changes parked");
      }
      return {
        name: level.name,
        current: level.current,
        detail: parts.join(" · "),
        title: level.parked
          ? "These changes will be uncommitted when you switch back"
          : level.name,
      };
    });
  }

  refresh(): void {
    this.schedule();
  }

  async addBranch(): Promise<void> {
    const folder = workspaceFolder();
    if (!folder) {
      void vscode.window.showInformationMessage(
        "Open a folder to add a stack branch.",
      );
      return;
    }
    const root = await repoRoot(folder);
    if (!root) {
      void vscode.window.showInformationMessage(
        "This folder is not a git repository.",
      );
      return;
    }
    const entered = await vscode.window.showInputBox({
      title: "New branch",
      prompt: "Branch name. pas/ is added when you leave it off.",
      placeHolder: "pas/my-feature",
      ignoreFocusOut: true,
      validateInput(value) {
        return invalidStackBranch(stackBranchName(value));
      },
    });
    if (entered === undefined) {
      return;
    }
    const name = stackBranchName(entered);
    const invalid = invalidStackBranch(name);
    if (invalid) {
      void vscode.window.showErrorMessage(invalid);
      return;
    }
    const top = this.levelsInternal.find((level) => !level.trunk)?.name;
    try {
      if (!top) {
        await run("gh", ["stack", "init", name], root, 120_000);
      } else if (!(await this.onBranch(root, top))) {
        return;
      } else {
        await run("gh", ["stack", "add", name], root, 120_000);
      }
      this.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(stackError(error));
    }
  }

  async unstack(): Promise<void> {
    const folder = workspaceFolder();
    if (!folder) {
      void vscode.window.showInformationMessage(
        "Open a folder to unstack its stack.",
      );
      return;
    }
    const root = await repoRoot(folder);
    if (!root) {
      void vscode.window.showInformationMessage(
        "This folder is not a git repository.",
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "Unstack the current stack? This removes it locally and on GitHub.",
      { modal: true },
      "Unstack",
    );
    if (choice !== "Unstack") {
      return;
    }
    try {
      await run("gh", ["stack", "unstack"], root, 120_000);
      this.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(stackError(error));
    }
  }

  async switchTo(branch: string): Promise<void> {
    const level = this.levelsInternal.find((item) => item.name === branch);
    if (!level || level.current) {
      return;
    }
    await this.switcher.checkout(branch);
  }

  private async onBranch(root: string, branch: string): Promise<boolean> {
    const current = await currentBranch(root);
    if (current === branch) {
      return true;
    }
    await this.switcher.checkout(branch);
    return (await currentBranch(root)) === branch;
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
      this.replace([], "Open a folder to see its stack.");
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
    let stdout = "";
    try {
      stdout = await run("gh", ["stack", "view", "--json"], root);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.replace([], stackError(error));
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    let parsed: ViewJson;
    try {
      parsed = JSON.parse(stdout) as ViewJson;
    } catch {
      this.replace([], "Couldn't read the stack.");
      return;
    }
    const levels = levelsFrom(parsed);
    for (const level of levels) {
      if (this.switcher.hasParked(root, level.name)) {
        level.parked = level.name;
      }
    }
    this.replace(levels, "");
  }

  private replace(levels: StackLevel[], status: string): void {
    this.levelsInternal.splice(0, this.levelsInternal.length, ...levels);
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
      this.headWatchers.push(
        watcher,
        watcher.onDidChange(() => this.schedule()),
        watcher.onDidCreate(() => this.schedule()),
        watcher.onDidDelete(() => this.schedule()),
      );
    }
  }
}

function levelsFrom(view: ViewJson): StackLevel[] {
  const current =
    typeof view.currentBranch === "string" ? view.currentBranch : "";
  const branches = Array.isArray(view.branches) ? view.branches : [];
  const levels: StackLevel[] = [];
  for (let index = branches.length - 1; index >= 0; index -= 1) {
    const branch = branches[index] as ViewBranch;
    if (
      !branch ||
      typeof branch.name !== "string" ||
      branch.name.length === 0 ||
      branch.name === "main"
    ) {
      continue;
    }
    const pr =
      branch.pr && typeof branch.pr.number === "number"
        ? branch.pr.number
        : undefined;
    levels.push({
      name: branch.name,
      current: branch.name === current || branch.isCurrent === true,
      trunk: false,
      pr,
    });
  }
  if (
    typeof view.trunk === "string" &&
    view.trunk.length > 0 &&
    view.trunk !== "main"
  ) {
    const listed = levels.some((level) => level.name === view.trunk);
    if (!listed) {
      levels.push({
        name: view.trunk,
        current: view.trunk === current,
        trunk: true,
      });
    }
  }
  return levels;
}

function stackBranchName(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed.startsWith("peter/")) {
    return `pas/${trimmed.slice("peter/".length)}`;
  }
  if (trimmed.startsWith("pas/")) {
    return trimmed;
  }
  return `pas/${trimmed}`;
}

function invalidStackBranch(name: string): string | undefined {
  if (name === "pas" || name === "pas/") {
    return "Enter a branch name.";
  }
  if (
    name.startsWith("-") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    /[\s~^:?*[\\]/.test(name)
  ) {
    return "That branch name is not allowed.";
  }
  return undefined;
}

async function currentBranch(root: string): Promise<string> {
  return (await run("git", ["branch", "--show-current"], root)).trim();
}

function stackError(error: unknown): string {
  if (isMissing(error)) {
    return "The gh command is not available.";
  }
  const text = failureText(error);
  if (/not part of a stack/i.test(text)) {
    return "This branch is not part of a stack.";
  }
  if (/not a git repository/i.test(text)) {
    return "This folder is not a git repository.";
  }
  if (/multiple stacks/i.test(text)) {
    return "This branch belongs to more than one stack.";
  }
  return text || "Couldn't read the stack.";
}
