import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { branchSwitchBlock } from "./branchSwitch";
import { commandFailure, logCommand } from "./commandLog";

const execFileAsync = promisify(execFile);
const BASE_REFS = ["origin/main", "origin/master", "main", "master"];
const BASE_SCHEME = "active-base";
const LOCAL_DOCS = ["local"];

type BaseQuery = {
  repo?: string;
  ref?: string;
  relative?: string;
  empty?: boolean;
};

export type BranchFile = {
  uri: vscode.Uri;
  detail: string;
};

export type BranchSnapshot = {
  files: BranchFile[];
  message?: string;
  baseLabel: string;
  checkedOut?: boolean;
};

export type DiffChainCommit = {
  sha: string;
  subject: string;
  head: boolean;
};

export type DiffChain = {
  label: string;
  baseSha: string;
  tipName: string;
  commits: DiffChainCommit[];
};

type Comparison = {
  ref: string;
  label: string;
};

export async function collectBranchChanges(
  baseRef?: string,
  commit?: string,
): Promise<BranchSnapshot> {
  const folders =
    vscode.workspace.workspaceFolders?.filter(
      (folder) => folder.uri.scheme === "file",
    ) ?? [];
  if (folders.length === 0) {
    return {
      files: [],
      message: "Open a local folder to compare this branch with main.",
      baseLabel: "main",
    };
  }

  if (commit) {
    const repo = await workspaceRepo();
    const head = repo
      ? (await git(repo, ["rev-parse", "HEAD"])).trim().toLowerCase()
      : "";
    if (head !== commit.toLowerCase()) {
      return {
        files: [],
        baseLabel: commit.slice(0, 7),
        checkedOut: false,
      };
    }
  }

  const files: BranchFile[] = [];
  const errors: string[] = [];
  const labels: string[] = [];
  let notice: string | undefined;
  let repos = 0;
  for (const folder of folders) {
    try {
      const found = commit
        ? await commitFiles(folder, commit)
        : await changesInFolder(folder, baseRef);
      if (!found) {
        continue;
      }
      repos += 1;
      labels.push(found.label);
      if (found.notice) {
        notice = found.notice;
      }
      files.push(...found.files);
    } catch (error) {
      errors.push(gitErrorMessage(error));
    }
  }

  if (repos === 0) {
    return {
      files: [],
      message: errors[0] ?? "This folder is not a git repository.",
      baseLabel: commit ? commit.slice(0, 7) : "main",
      checkedOut: commit ? true : undefined,
    };
  }
  if (errors.length > 0) {
    console.error(errors.join("\n"));
  }

  const seen = new Set<string>();
  const uniqueLabels = [...new Set(labels)];
  return {
    baseLabel: uniqueLabels.length === 1 ? uniqueLabels[0] : "main",
    message: notice,
    checkedOut: commit ? true : undefined,
    files: files.filter((file) => {
      const key = file.uri.toString();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }),
  };
}

export function registerBranchDiffProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const query = parseBaseQuery(uri);
      if (
        !query ||
        query.empty ||
        !query.repo ||
        !query.ref ||
        !query.relative
      ) {
        return "";
      }
      try {
        const bytes = await gitBytes(query.repo, [
          "show",
          `${query.ref}:${query.relative}`,
        ]);
        if (bytes.includes(0)) {
          return "";
        }
        return bytes.toString("utf8");
      } catch {
        return "";
      }
    },
  });
}

export async function openBranchDiff(
  file: vscode.Uri,
  baseRef?: string,
  commit?: string,
): Promise<void> {
  try {
    if (file.scheme !== "file") {
      void vscode.window.showErrorMessage("Diff is available for local files.");
      return;
    }
    if (commit) {
      await openCommitDiff(file, commit);
      return;
    }
    const place = await locateBranchFile(file, baseRef);
    const name = path.basename(file.fsPath);
    const onDisk = await fileExists(file);
    if (onDisk && (await looksBinary(file))) {
      void vscode.window.showInformationMessage(
        `${name} is binary, so there is no text diff.`,
      );
      return;
    }
    const base = await readBaseBytes(
      place.repo,
      place.forkPoint,
      place.baseRelative,
    );
    if (base?.includes(0)) {
      void vscode.window.showInformationMessage(
        `${name} is binary, so there is no text diff.`,
      );
      return;
    }
    const title = `${name} (${place.label}...working folder)`;
    const left = diffUri(file, {
      repo: place.repo,
      ref: place.forkPoint,
      relative: place.baseRelative,
      empty: !base,
    });
    const right = onDisk ? file : diffUri(file, { empty: true });
    await vscode.commands.executeCommand("vscode.diff", left, right, title);
  } catch (error) {
    void vscode.window.showErrorMessage(gitErrorMessage(error));
  }
}

export function watchBranchSignals(onDirty: () => void): vscode.Disposable {
  let watchers: vscode.Disposable[] = [];

  const rebuild = (): void => {
    for (const disposable of watchers) {
      disposable.dispose();
    }
    watchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      for (const relative of [".git/HEAD", ".git/index"]) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, relative),
        );
        watchers.push(
          watcher,
          watcher.onDidChange(onDirty),
          watcher.onDidCreate(onDirty),
          watcher.onDidDelete(onDirty),
        );
      }
    }
  };

  rebuild();
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    rebuild();
    onDirty();
  });
  return vscode.Disposable.from(folders, {
    dispose() {
      for (const disposable of watchers) {
        disposable.dispose();
      }
    },
  });
}

async function changesInFolder(
  folder: vscode.WorkspaceFolder,
  baseRef?: string,
): Promise<
  { files: BranchFile[]; label: string; notice?: string } | undefined
> {
  const cwd = folder.uri.fsPath;
  if (!(await isRepo(cwd))) {
    return undefined;
  }
  const topLevel = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const base = await comparisonPoint(topLevel, baseRef);
  const diff = await git(topLevel, [
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    base.ref,
    "--",
    cwd,
  ]);
  const untracked = await git(topLevel, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    cwd,
  ]);
  const files: BranchFile[] = [
    ...parseNameStatus(diff).map((change) => ({
      uri: uriForChange(folder, topLevel, change.path),
      detail: statusDetail(change.code),
    })),
    ...untracked
      .split("\0")
      .filter((relative) => relative.length > 0)
      .map((relative) => ({
        uri: uriForChange(folder, topLevel, relative),
        detail: "untracked",
      })),
  ];
  const seen = new Set(files.map((file) => file.uri.toString()));
  for (const local of await localDocFiles(folder)) {
    const key = local.uri.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    files.push(local);
  }
  return { label: base.label, files };
}

async function commitFiles(
  folder: vscode.WorkspaceFolder,
  sha: string,
): Promise<
  { files: BranchFile[]; label: string; notice?: string } | undefined
> {
  const cwd = folder.uri.fsPath;
  if (!(await isRepo(cwd))) {
    return undefined;
  }
  const topLevel = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const parent = `${sha}^`;
  const label = sha.slice(0, 7);
  if (!(await refExists(topLevel, parent))) {
    return {
      files: [],
      label,
      notice: "This commit has no parent.",
    };
  }
  const diff = await git(topLevel, [
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    parent,
    sha,
    "--",
    cwd,
  ]);
  return {
    label,
    files: parseNameStatus(diff).map((change) => ({
      uri: uriForChange(folder, topLevel, change.path),
      detail: statusDetail(change.code),
    })),
  };
}

// local is kept in the list even when those files match main.
async function localDocFiles(
  folder: vscode.WorkspaceFolder,
): Promise<BranchFile[]> {
  const root = path.join(folder.uri.fsPath, ...LOCAL_DOCS);
  const files: BranchFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push({
        uri: vscode.Uri.file(existingPath(absolute)),
        detail: "local",
      });
    }
  };
  await walk(root);
  return files;
}

// Commits after the active base up to the branch tip. Newest first.
// tipRef is the stack branch to keep using after that commit is checked out.
export async function listDiffChain(
  baseRef?: string,
  tipRef?: string,
): Promise<DiffChain | undefined> {
  const repo = await workspaceRepo();
  if (!repo) {
    return undefined;
  }
  const current = (await git(repo, ["branch", "--show-current"])).trim();
  const tipName = tipRef || current;
  const end = tipName && (await refExists(repo, tipName)) ? tipName : "HEAD";
  const base = await comparisonPoint(repo, baseRef, end);
  const tipSha = (await git(repo, ["rev-parse", end])).trim();
  const log = await git(repo, [
    "log",
    "--format=%H%x09%s",
    `${base.ref}..${end}`,
  ]);
  const commits: DiffChainCommit[] = [];
  for (const line of log.split("\n")) {
    if (!line) {
      continue;
    }
    const tab = line.indexOf("\t");
    const sha = tab < 0 ? line : line.slice(0, tab);
    commits.push({
      sha,
      subject: tab < 0 ? sha.slice(0, 7) : line.slice(tab + 1),
      head: sha === tipSha,
    });
  }
  return {
    label: base.label,
    baseSha: base.ref,
    tipName: tipName || "HEAD",
    commits,
  };
}

export async function checkoutDiffCommit(
  sha: string,
  savedTip?: string,
): Promise<{ tip: string } | { error: string }> {
  try {
    const repo = await workspaceRepo();
    if (!repo) {
      return { error: "Open a local git folder to choose a commit." };
    }
    const blocked = await branchSwitchBlock(repo);
    if (blocked) {
      return { error: blocked };
    }
    if (await worktreeDirty(repo)) {
      return {
        error:
          "Commit or discard uncommitted changes before checking out a commit.",
      };
    }
    const branch = (await git(repo, ["branch", "--show-current"])).trim();
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim().toLowerCase();
    const tip = branch || savedTip;
    if (!tip) {
      return {
        error:
          "This checkout is detached, so there is no branch tip to return to.",
      };
    }
    if (head !== sha.toLowerCase() || branch) {
      await git(repo, ["switch", "--detach", sha]);
    }
    return { tip };
  } catch (error) {
    return { error: gitErrorMessage(error) };
  }
}

export async function checkoutBranchTip(
  branch: string,
): Promise<string | undefined> {
  try {
    const repo = await workspaceRepo();
    if (!repo) {
      return "Open a local git folder to return to the branch tip.";
    }
    const blocked = await branchSwitchBlock(repo);
    if (blocked) {
      return blocked;
    }
    if (await worktreeDirty(repo)) {
      return "Commit or discard uncommitted changes before returning to the branch tip.";
    }
    const current = (await git(repo, ["branch", "--show-current"])).trim();
    if (current !== branch) {
      await git(repo, ["switch", "--no-guess", branch]);
    }
    return undefined;
  } catch (error) {
    return gitErrorMessage(error);
  }
}

// A named baseRef is the previous stack level. A commit id is that commit.
// Otherwise the base is main. head is the branch tip, including while a
// commit from a stack branch is checked out. The comparison commit is
// merge-base(base, head), the same point as `git diff <base>...head`.
async function comparisonPoint(
  repo: string,
  baseRef?: string,
  head = "HEAD",
): Promise<Comparison> {
  if (baseRef && (await refExists(repo, baseRef))) {
    try {
      const ref = (await git(repo, ["merge-base", head, baseRef])).trim();
      return { ref, label: comparisonLabel(baseRef, ref) };
    } catch {
      // The previous level is not an ancestor we can compare. Fall back to main.
    }
  }
  const mainRef = await resolveBaseRef(repo);
  const ref = (await git(repo, ["merge-base", head, mainRef])).trim();
  return { ref, label: "main" };
}

async function workspaceRepo(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.find(
    (item) => item.uri.scheme === "file",
  );
  if (!folder || !(await isRepo(folder.uri.fsPath))) {
    return undefined;
  }
  return (
    await git(folder.uri.fsPath, ["rev-parse", "--show-toplevel"])
  ).trim();
}

async function worktreeDirty(repo: string): Promise<boolean> {
  const status = await git(repo, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  return status.trim().length > 0;
}

async function isRepo(cwd: string): Promise<boolean> {
  try {
    const result = (
      await git(cwd, ["rev-parse", "--is-inside-work-tree"])
    ).trim();
    return result === "true";
  } catch (error) {
    if (isEnoent(error)) {
      throw error;
    }
    return false;
  }
}

async function resolveBaseRef(cwd: string): Promise<string> {
  const candidates: string[] = [];
  try {
    const originHead = (
      await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    ).trim();
    if (originHead) {
      candidates.push(originHead);
    }
  } catch {
    // This clone has no origin/HEAD.
  }
  candidates.push(...BASE_REFS);
  const seen = new Set<string>();
  for (const ref of candidates) {
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    if (await refExists(cwd, ref)) {
      return ref;
    }
  }
  throw new Error("Could not find a main branch.");
}

function comparisonLabel(baseRef: string, resolved: string): string {
  return /^[0-9a-f]{7,40}$/i.test(baseRef) ? resolved.slice(0, 7) : baseRef;
}

export async function commitRefExists(ref: string): Promise<boolean> {
  const repo = await workspaceRepo();
  if (!repo) {
    return false;
  }
  return refExists(repo, ref);
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function parseNameStatus(
  output: string,
): Array<{ code: string; path: string; previous?: string }> {
  const records = output.split("\0");
  if (records.length > 0 && records[records.length - 1] === "") {
    records.pop();
  }
  const changes: Array<{ code: string; path: string; previous?: string }> = [];
  for (let index = 0; index < records.length; ) {
    const status = records[index++];
    if (!status) {
      break;
    }
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = records[index++];
      const newPath = records[index++];
      if (!newPath) {
        break;
      }
      changes.push({ code, path: newPath, previous: oldPath });
      continue;
    }
    const filePath = records[index++];
    if (!filePath) {
      break;
    }
    changes.push({ code, path: filePath });
  }
  return changes;
}

function statusDetail(code: string): string {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type change";
    case "U":
      return "unmerged";
    default:
      return "changed";
  }
}

function uriForChange(
  folder: vscode.WorkspaceFolder,
  topLevel: string,
  relative: string,
): vscode.Uri {
  const root = existingPath(topLevel);
  const base = existingPath(folder.uri.fsPath);
  const absolute = path.join(
    root,
    ...relative.split(/[/\\]/).filter((part) => part.length > 0),
  );
  const relativeToFolder = path.relative(base, absolute);
  const outside =
    relativeToFolder === ".." ||
    relativeToFolder.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToFolder);
  if (outside) {
    return vscode.Uri.file(absolute);
  }
  if (relativeToFolder.length === 0) {
    return folder.uri;
  }
  return vscode.Uri.joinPath(
    folder.uri,
    ...relativeToFolder.split(path.sep).filter((part) => part.length > 0),
  );
}

function existingPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

async function openCommitDiff(file: vscode.Uri, sha: string): Promise<void> {
  const name = path.basename(file.fsPath);
  const place = await locateCommitFile(file, sha);
  const parent = `${sha}^`;
  const leftBytes = place.added
    ? undefined
    : await readBaseBytes(place.repo, parent, place.leftRelative);
  const rightBytes = place.deleted
    ? undefined
    : await readBaseBytes(place.repo, sha, place.rightRelative);
  if (leftBytes?.includes(0) || rightBytes?.includes(0)) {
    void vscode.window.showInformationMessage(
      `${name} is binary, so there is no text diff.`,
    );
    return;
  }
  const title = `${name} (${sha.slice(0, 7)})`;
  const left = diffUri(file, {
    repo: place.repo,
    ref: parent,
    relative: place.leftRelative,
    empty: !leftBytes,
  });
  const right = diffUri(file, {
    repo: place.repo,
    ref: sha,
    relative: place.rightRelative,
    empty: !rightBytes,
  });
  await vscode.commands.executeCommand("vscode.diff", left, right, title);
}

async function locateCommitFile(
  file: vscode.Uri,
  sha: string,
): Promise<{
  repo: string;
  leftRelative: string;
  rightRelative: string;
  added: boolean;
  deleted: boolean;
}> {
  const dir = path.dirname(file.fsPath);
  if (!(await isRepo(dir))) {
    throw new Error("This folder is not a git repository.");
  }
  const repo = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  const relative = gitRelative(repo, file.fsPath);
  const listed = await git(repo, [
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    `${sha}^`,
    sha,
    "--",
    file.fsPath,
  ]);
  const match = parseNameStatus(listed).find(
    (change) => change.path === relative || change.previous === relative,
  );
  const rightRelative = match?.path ?? relative;
  return {
    repo,
    leftRelative: match?.previous ?? rightRelative,
    rightRelative,
    added: match?.code === "A",
    deleted: match?.code === "D",
  };
}

async function locateBranchFile(
  file: vscode.Uri,
  baseRef?: string,
): Promise<{
  repo: string;
  baseRelative: string;
  forkPoint: string;
  label: string;
}> {
  const dir = path.dirname(file.fsPath);
  if (!(await isRepo(dir))) {
    throw new Error("This folder is not a git repository.");
  }
  const repo = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  const base = await comparisonPoint(repo, baseRef);
  const relative = gitRelative(repo, file.fsPath);
  const listed = await git(repo, [
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    base.ref,
    "--",
    file.fsPath,
  ]);
  const match = parseNameStatus(listed).find(
    (change) => change.path === relative,
  );
  return {
    repo,
    label: base.label,
    forkPoint: base.ref,
    baseRelative: match?.previous ?? relative,
  };
}

function gitRelative(repo: string, filePath: string): string {
  const root = existingPath(repo);
  let target = filePath;
  try {
    target = realpathSync(filePath);
  } catch {
    target = path.resolve(
      existingPath(path.dirname(filePath)),
      path.basename(filePath),
    );
  }
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Could not compare this file with main.");
  }
  return relative.split(path.sep).join("/");
}

function diffUri(file: vscode.Uri, query: BaseQuery): vscode.Uri {
  return file.with({
    scheme: BASE_SCHEME,
    query: JSON.stringify(query),
  });
}

function parseBaseQuery(uri: vscode.Uri): BaseQuery | undefined {
  if (!uri.query) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(uri.query);
    if (!value || typeof value !== "object") {
      return undefined;
    }
    return value as BaseQuery;
  } catch {
    return undefined;
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.File;
  } catch {
    return false;
  }
}

async function looksBinary(uri: vscode.Uri): Promise<boolean> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return bytes.subarray(0, 8000).includes(0);
  } catch {
    return false;
  }
}

async function readBaseBytes(
  repo: string,
  ref: string,
  relative: string,
): Promise<Buffer | undefined> {
  try {
    return await gitBytes(repo, ["show", `${ref}:${relative}`]);
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    logCommand("git", args, cwd, stdout, stderr);
    return String(stdout);
  } catch (error) {
    const failure = commandFailure(error);
    logCommand("git", args, cwd, failure.stdout, failure.stderr, failure.code);
    throw error;
  }
}

async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    logCommand("git", args, cwd, bytes, stderr);
    return bytes;
  } catch (error) {
    const failure = commandFailure(error);
    logCommand("git", args, cwd, failure.stdout, failure.stderr, failure.code);
    throw error;
  }
}

function gitErrorMessage(error: unknown): string {
  if (isEnoent(error)) {
    return "Git is not available on PATH.";
  }
  const text = errorText(error);
  if (/not a git repository/i.test(text)) {
    return "This folder is not a git repository.";
  }
  if (/no merge base/i.test(text) || /Not a valid object name/i.test(text)) {
    return "Could not compare this branch with main.";
  }
  if (/could not find a main branch/i.test(text)) {
    return "Could not find a main branch.";
  }
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !item.startsWith("Command failed"))
    .pop();
  if (!line) {
    return "Could not read branch changes.";
  }
  return line.replace(/^fatal:\s*/i, "");
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
  const message = "message" in error ? String(error.message ?? "") : "";
  return `${stderr}\n${message}`;
}

function isEnoent(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
