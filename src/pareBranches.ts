import * as vscode from "vscode";
import {
  BranchSwitch,
  failureText,
  isMissing,
  repoRoot,
  run,
  workspaceFolder,
} from "./branchSwitch";

const PR_LIMIT = 20;
const CONCURRENCY = 5;

type PullRequest = {
  headRefName?: unknown;
  state?: unknown;
  closed?: unknown;
  mergedAt?: unknown;
  closedAt?: unknown;
  isCrossRepository?: unknown;
};

export async function pareBranches(switcher: BranchSwitch): Promise<void> {
  const folder = workspaceFolder();
  if (!folder) {
    void vscode.window.showInformationMessage(
      "Open a folder to pare its branches.",
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
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Paring merged branches",
    },
    async () => {
      try {
        const summary = await pare(root, switcher);
        void vscode.window.showInformationMessage(summary);
      } catch (error) {
        void vscode.window.showErrorMessage(pareError(error));
      }
    },
  );
}

async function pare(root: string, switcher: BranchSwitch): Promise<string> {
  const names = await localBranches(root);
  const current = (await run("git", ["branch", "--show-current"], root)).trim();
  const trunk = await defaultBranch(root);
  const remove: string[] = [];
  const kept: string[] = [];
  let cursor = 0;
  let failure: unknown;

  const worker = async (): Promise<void> => {
    while (!failure && cursor < names.length) {
      const name = names[cursor];
      cursor += 1;
      let pulls: PullRequest[];
      try {
        pulls = await pullsFor(root, name);
      } catch (error) {
        failure = error;
        return;
      }
      if (!readyToDelete(pulls)) {
        continue;
      }
      if (name === current) {
        kept.push(`${name} (checked out)`);
        continue;
      }
      if (trunk.length > 0 && name === trunk) {
        kept.push(`${name} (default branch)`);
        continue;
      }
      remove.push(name);
    }
  };

  const workers = Math.min(CONCURRENCY, names.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failure) {
    throw failure;
  }

  const deleted: string[] = [];
  const failed: string[] = [];
  for (const name of remove) {
    try {
      await run("git", ["branch", "-D", "--", name], root);
      switcher.forgetParked(root, name);
      deleted.push(name);
    } catch (error) {
      failed.push(`${name} (${failureText(error)})`);
    }
  }
  return summary(deleted, kept, failed);
}

async function localBranches(root: string): Promise<string[]> {
  const listing = await run(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    root,
  );
  return listing
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

async function defaultBranch(root: string): Promise<string> {
  try {
    const ref = (
      await run(
        "git",
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        root,
      )
    ).trim();
    return ref.replace(/^origin\//, "");
  } catch {
    return "";
  }
}

async function pullsFor(root: string, branch: string): Promise<PullRequest[]> {
  const stdout = await run(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      String(PR_LIMIT),
      "--json",
      "headRefName,state,closed,mergedAt,closedAt,isCrossRepository",
    ],
    root,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Couldn't read pull requests for ${branch}.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Couldn't read pull requests for ${branch}.`);
  }
  return parsed.filter(isSameRepoPull).filter((pull) => {
    return pull.headRefName === branch;
  });
}

function isSameRepoPull(value: unknown): value is PullRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (value as PullRequest).isCrossRepository !== true;
}

function readyToDelete(pulls: readonly PullRequest[]): boolean {
  if (pulls.length === 0 || pulls.some(isOpen)) {
    return false;
  }
  return pulls.some(isMergedAndClosed);
}

function isOpen(pull: PullRequest): boolean {
  return pull.state === "OPEN" && pull.closed !== true;
}

function isMergedAndClosed(pull: PullRequest): boolean {
  const merged =
    pull.state === "MERGED" ||
    (typeof pull.mergedAt === "string" && pull.mergedAt.length > 0);
  if (!merged || pull.state === "OPEN" || pull.closed === false) {
    return false;
  }
  return (
    pull.state === "MERGED" ||
    pull.state === "CLOSED" ||
    pull.closed === true ||
    (typeof pull.closedAt === "string" && pull.closedAt.length > 0)
  );
}

function summary(deleted: string[], kept: string[], failed: string[]): string {
  if (deleted.length === 0 && kept.length === 0 && failed.length === 0) {
    return "No local branches have a merged and closed pull request.";
  }
  const parts: string[] = [];
  if (deleted.length > 0) {
    parts.push(`Deleted ${deleted.join(", ")}.`);
  }
  if (kept.length > 0) {
    parts.push(`Left ${kept.join(", ")} in place.`);
  }
  if (failed.length > 0) {
    parts.push(`Couldn't delete ${failed.join(", ")}.`);
  }
  return parts.join(" ");
}

function pareError(error: unknown): string {
  if (isMissing(error)) {
    return "The gh command is not available.";
  }
  const text = failureText(error);
  return text || "Couldn't pare branches.";
}
