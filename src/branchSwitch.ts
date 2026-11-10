import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { commandFailure, logCommand } from "./commandLog";

const execFileAsync = promisify(execFile);
const PARKED_KEY = "stack.parked";
const PARK_MESSAGE = "Park uncommitted changes";

type ParkNote = {
  root: string;
  branch: string;
  sha: string;
};

export class BranchSwitch {
  private switching = false;

  constructor(private readonly workspaceState: vscode.Memento) {}

  hasParked(root: string, branch: string): boolean {
    return this.findNote(root, branch) !== undefined;
  }

  forgetParked(root: string, branch: string): void {
    const note = this.findNote(root, branch);
    if (note) {
      this.forget(note);
    }
  }

  async checkout(branch: string): Promise<void> {
    if (this.switching) {
      return;
    }
    const folder = workspaceFolder();
    const root = folder ? await repoRoot(folder) : undefined;
    if (!root) {
      return;
    }
    this.switching = true;
    try {
      const blocked = await branchSwitchBlock(root);
      if (blocked) {
        void vscode.window.showErrorMessage(blocked);
        return;
      }
      if (await hasUncommittedChanges(root)) {
        const current = (
          await run("git", ["branch", "--show-current"], root)
        ).trim();
        if (!current) {
          void vscode.window.showErrorMessage(
            "Commit or discard changes before leaving a detached HEAD.",
          );
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `Are you sure? Staged and unstaged changes will be committed on ${current}, then ${branch} will be checked out.`,
          { modal: true },
          "Yes",
        );
        if (choice !== "Yes") {
          return;
        }
        await this.park(root, current);
      }
      await run("git", ["switch", "--no-guess", branch], root);
      const parked = this.findNote(root, branch);
      if (parked) {
        await this.restore(root, parked);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(failureText(error));
    } finally {
      this.switching = false;
    }
  }

  private async park(root: string, branch: string): Promise<void> {
    await run("git", ["add", "-u"], root);
    await run("git", ["commit", "-m", PARK_MESSAGE], root, 60_000);
    const sha = (await run("git", ["rev-parse", "HEAD"], root)).trim();
    this.remember({ root, branch, sha });
  }

  private async restore(root: string, note: ParkNote): Promise<void> {
    if (!(await isParkCommit(root, note.sha))) {
      throw new Error(
        `The parked commit on ${note.branch} changed, so it was left in place.`,
      );
    }
    await run("git", ["reset", "--soft", "HEAD~1"], root);
    this.forget(note);
  }

  private findNote(root: string, branch: string): ParkNote | undefined {
    return this.notes().find(
      (note) => note.root === root && note.branch === branch,
    );
  }

  private notes(): ParkNote[] {
    const raw = this.workspaceState.get<unknown>(PARKED_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(isParkNote);
  }

  private remember(note: ParkNote): void {
    const notes = this.notes().filter(
      (item) => item.root !== note.root || item.branch !== note.branch,
    );
    notes.push(note);
    void this.workspaceState.update(PARKED_KEY, notes);
  }

  private forget(note: ParkNote): void {
    const notes = this.notes().filter(
      (item) => item.root !== note.root || item.branch !== note.branch,
    );
    void this.workspaceState.update(PARKED_KEY, notes);
  }
}

export async function repoRoot(folder: string): Promise<string | undefined> {
  try {
    const top = (
      await run("git", ["rev-parse", "--show-toplevel"], folder)
    ).trim();
    return top || undefined;
  } catch {
    return undefined;
  }
}

export function workspaceFolder(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  const fromEditor = editor
    ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
    : undefined;
  const folder = fromEditor ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    return undefined;
  }
  return folder.uri.fsPath;
}

export async function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = 20_000,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout,
      windowsHide: true,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GH_FORCE_TTY: "0",
      },
    });
    logCommand(command, args, cwd, stdout, stderr);
    return String(stdout);
  } catch (error) {
    const failure = commandFailure(error);
    logCommand(
      command,
      args,
      cwd,
      failure.stdout,
      failure.stderr,
      failure.code,
    );
    throw error;
  }
}

export function failureText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Couldn't switch branches.";
  }
  const body = error as {
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
  };
  const stderr = typeof body.stderr === "string" ? body.stderr.trim() : "";
  if (stderr) {
    return clean(stderr);
  }
  const stdout = typeof body.stdout === "string" ? body.stdout.trim() : "";
  if (stdout) {
    return clean(stdout);
  }
  return typeof body.message === "string" && body.message.length > 0
    ? clean(body.message)
    : "Couldn't switch branches.";
}

export function isMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === "ENOENT";
}

function isParkNote(value: unknown): value is ParkNote {
  if (!value || typeof value !== "object") {
    return false;
  }
  const note = value as ParkNote;
  return (
    typeof note.root === "string" &&
    typeof note.branch === "string" &&
    typeof note.sha === "string"
  );
}

export async function branchSwitchBlock(
  root: string,
): Promise<string | undefined> {
  if (
    (await gitPathExists(root, "rebase-merge")) ||
    (await gitPathExists(root, "rebase-apply"))
  ) {
    return "A rebase is in progress. Finish or abort it before switching branches.";
  }
  if (await verifyRef(root, "MERGE_HEAD")) {
    return "A merge is in progress. Finish or abort it before switching branches.";
  }
  const unmerged = await run("git", ["ls-files", "--unmerged"], root);
  if (unmerged.trim().length > 0) {
    return "This branch has merge conflicts. Resolve them before switching branches.";
  }
  return undefined;
}

async function gitPathExists(root: string, name: string): Promise<boolean> {
  const relative = (
    await run("git", ["rev-parse", "--git-path", name], root)
  ).trim();
  const absolute = path.isAbsolute(relative)
    ? relative
    : path.join(root, relative);
  return existsSync(absolute);
}

async function verifyRef(root: string, ref: string): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", "--quiet", ref], root);
    return true;
  } catch {
    return false;
  }
}

async function hasUncommittedChanges(root: string): Promise<boolean> {
  try {
    await run("git", ["diff", "--quiet", "HEAD"], root);
    return false;
  } catch (error) {
    if (exitCode(error) === 1) {
      return true;
    }
    throw error;
  }
}

async function isParkCommit(root: string, sha: string): Promise<boolean> {
  const head = (await run("git", ["rev-parse", "HEAD"], root)).trim();
  if (head !== sha) {
    return false;
  }
  const subject = (
    await run("git", ["log", "-1", "--format=%s", sha], root)
  ).trim();
  return subject === PARK_MESSAGE;
}

function exitCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function clean(text: string): string {
  const stripped = text.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const line =
    stripped
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? "";
  return line.replace(/^[✗×]\s*/, "");
}
