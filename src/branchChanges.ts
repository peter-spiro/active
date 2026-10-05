import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);
const BASE_REFS = ["origin/main", "origin/master", "main", "master"];
const BASE_SCHEME = "active-base";

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
};

export async function collectBranchChanges(): Promise<BranchSnapshot> {
  const folders =
    vscode.workspace.workspaceFolders?.filter(
      (folder) => folder.uri.scheme === "file",
    ) ?? [];
  if (folders.length === 0) {
    return {
      files: [],
      message: "Open a local folder to compare this branch with main.",
    };
  }

  const files: BranchFile[] = [];
  const errors: string[] = [];
  let repos = 0;
  for (const folder of folders) {
    try {
      const found = await changesInFolder(folder);
      if (!found) {
        continue;
      }
      repos += 1;
      files.push(...found);
    } catch (error) {
      errors.push(gitErrorMessage(error));
    }
  }

  if (repos === 0) {
    return {
      files: [],
      message: errors[0] ?? "This folder is not a git repository.",
    };
  }
  if (errors.length > 0) {
    console.error(errors.join("\n"));
  }

  const seen = new Set<string>();
  return {
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

export async function openBranchDiff(file: vscode.Uri): Promise<void> {
  try {
    if (file.scheme !== "file") {
      void vscode.window.showErrorMessage("Diff is available for local files.");
      return;
    }
    const place = await locateBranchFile(file);
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
      place.mergeBase,
      place.baseRelative,
    );
    if (base?.includes(0)) {
      void vscode.window.showInformationMessage(
        `${name} is binary, so there is no text diff.`,
      );
      return;
    }
    const title = `${name} (main base ↔ working folder)`;
    const left = diffUri(file, {
      repo: place.repo,
      ref: place.mergeBase,
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
): Promise<BranchFile[] | undefined> {
  const cwd = folder.uri.fsPath;
  if (!(await isRepo(cwd))) {
    return undefined;
  }
  const topLevel = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const baseRef = await resolveBaseRef(topLevel);
  const mergeBase = (
    await git(topLevel, ["merge-base", "HEAD", baseRef])
  ).trim();
  const diff = await git(topLevel, [
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    mergeBase,
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
  return [
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

async function locateBranchFile(file: vscode.Uri): Promise<{
  repo: string;
  baseRelative: string;
  mergeBase: string;
}> {
  const dir = path.dirname(file.fsPath);
  if (!(await isRepo(dir))) {
    throw new Error("This folder is not a git repository.");
  }
  const repo = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  const baseRef = await resolveBaseRef(repo);
  const mergeBase = (await git(repo, ["merge-base", "HEAD", baseRef])).trim();
  const relative = gitRelative(repo, file.fsPath);
  const listed = await git(repo, [
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    mergeBase,
    "--",
    file.fsPath,
  ]);
  const match = parseNameStatus(listed).find(
    (change) => change.path === relative,
  );
  return {
    repo,
    mergeBase,
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
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return String(stdout);
}

async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
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
