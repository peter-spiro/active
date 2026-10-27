import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

const MAX_MATCHES = 2000;

export type SearchRequest = {
  query: string;
  include: string;
  exclude: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export type SearchSpan = {
  start: number;
  end: number;
};

export type SearchHit = {
  path: string;
  line: number;
  start: number;
  end: number;
  text: string;
  spans: SearchSpan[];
};

export type SearchFile = {
  path: string;
  label: string;
  hits: SearchHit[];
};

export type SearchOutcome = {
  files: SearchFile[];
  matchCount: number;
  limited: boolean;
  error?: string;
};

type RgText = { text?: string; bytes?: string };

type RgMatch = {
  type?: string;
  data?: {
    path?: RgText;
    lines?: RgText;
    line_number?: number;
    submatches?: Array<{
      start?: number;
      end?: number;
    }>;
  };
};

export function runSearch(request: SearchRequest): {
  cancel: () => void;
  done: Promise<SearchOutcome | undefined>;
} {
  const query = request.query;
  if (!query) {
    return {
      cancel: () => undefined,
      done: Promise.resolve({ files: [], matchCount: 0, limited: false }),
    };
  }
  const roots = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
  if (roots.length === 0) {
    return {
      cancel: () => undefined,
      done: Promise.resolve({
        files: [],
        matchCount: 0,
        limited: false,
        error: "Open a local folder to search.",
      }),
    };
  }

  let cancelled = false;
  let settled = false;
  let child: ChildProcess | undefined;
  let finish: (outcome: SearchOutcome | undefined) => void = () => undefined;
  const done = new Promise<SearchOutcome | undefined>((resolve) => {
    finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };
  });

  const files = new Map<string, SearchFile>();
  let matchCount = 0;
  let limited = false;
  let stderr = "";
  let buffer = "";

  const cancel = (): void => {
    cancelled = true;
    child?.kill();
  };

  const addMatch = (message: RgMatch): void => {
    if (limited || matchCount >= MAX_MATCHES) {
      limited = true;
      child?.kill();
      return;
    }
    const data = message.data;
    const filePath = rgText(data?.path);
    const lineNumber = data?.line_number;
    if (!filePath || !lineNumber) {
      return;
    }
    const raw = rgText(data?.lines).replace(/\r?\n$/, "");
    if (lineExcluded(raw, request.exclude, request.matchCase)) {
      return;
    }
    const spans = (data?.submatches ?? [])
      .map((sub) => ({
        start: byteToChar(raw, sub.start ?? 0),
        end: byteToChar(raw, sub.end ?? 0),
      }))
      .filter((span) => span.end > span.start)
      .sort((a, b) => a.start - b.start);
    const first = spans[0] ?? { start: 0, end: 0 };
    let group = files.get(filePath);
    if (!group) {
      group = { path: filePath, label: displayPath(filePath), hits: [] };
      files.set(filePath, group);
    }
    group.hits.push({
      path: filePath,
      line: lineNumber,
      start: first.start,
      end: first.end,
      text: raw,
      spans,
    });
    matchCount += 1;
    if (matchCount >= MAX_MATCHES) {
      limited = true;
      child?.kill();
    }
  };

  child = spawn(rgBinary(), rgArgs(request, roots), {
    cwd: roots[0],
    windowsHide: true,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as RgMatch;
          if (message.type === "match") {
            addMatch(message);
          }
        } catch {
          // Ignore a partial or non-JSON line.
        }
      }
      if (limited || cancelled) {
        return;
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 2000) {
      stderr += chunk;
    }
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    const missing = error.code === "ENOENT";
    finish({
      files: [],
      matchCount: 0,
      limited: false,
      error: missing ? "Couldn't find ripgrep (rg)." : "Search failed.",
    });
  });
  child.on("close", (code) => {
    if (cancelled) {
      finish(undefined);
      return;
    }
    if (!limited && code === 2 && matchCount === 0) {
      finish({
        files: [],
        matchCount: 0,
        limited: false,
        error: stderr.trim() || "Search failed.",
      });
      return;
    }
    finish({
      files: [...files.values()],
      matchCount,
      limited,
    });
  });

  return { cancel, done };
}

function rgArgs(request: SearchRequest, roots: string[]): string[] {
  const args = [
    "--json",
    "--line-number",
    "--column",
    "--hidden",
    "--max-columns",
    "1000",
    "--max-columns-preview",
    "-g",
    "!**/.git/**",
  ];
  if (!request.matchCase) {
    args.push("-i");
  }
  if (request.wholeWord) {
    args.push("-w");
  }
  if (!request.regex) {
    args.push("-F");
  }
  for (const glob of includeGlobs(request.include)) {
    args.push("-g", glob);
  }
  for (const glob of settingExcludes()) {
    args.push("-g", glob.startsWith("!") ? glob : `!${glob}`);
  }
  args.push("--", request.query, ...roots);
  return args;
}

function includeGlobs(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function settingExcludes(): string[] {
  const globs: string[] = [];
  for (const section of ["files", "search"] as const) {
    const value = vscode.workspace.getConfiguration(section).get("exclude");
    if (!value || typeof value !== "object") {
      continue;
    }
    for (const [pattern, enabled] of Object.entries(value)) {
      if (enabled === true && pattern.length > 0) {
        globs.push(pattern);
      }
    }
  }
  return globs;
}

function rgBinary(): string {
  const names = process.platform === "win32" ? ["rg.exe"] : ["rg"];
  const roots = [
    path.join(vscode.env.appRoot, "node_modules", "@vscode", "ripgrep", "bin"),
    path.join(
      vscode.env.appRoot,
      "node_modules.asar.unpacked",
      "@vscode",
      "ripgrep",
      "bin",
    ),
  ];
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return names[0];
}

function rgText(value: RgText | undefined): string {
  if (!value) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.bytes === "string") {
    return Buffer.from(value.bytes, "base64").toString("utf8");
  }
  return "";
}

function lineExcluded(
  line: string,
  exclude: string,
  matchCase: boolean,
): boolean {
  if (!exclude) {
    return false;
  }
  if (matchCase) {
    return line.includes(exclude);
  }
  return line.toLowerCase().includes(exclude.toLowerCase());
}

function byteToChar(text: string, byteOffset: number): number {
  const bytes = Buffer.from(text, "utf8");
  const end = Math.max(0, Math.min(byteOffset, bytes.length));
  return bytes.subarray(0, end).toString("utf8").length;
}

function displayPath(filePath: string): string {
  const uri = vscode.Uri.file(filePath);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return filePath;
  }
  const relative = path
    .relative(folder.uri.fsPath, filePath)
    .split(path.sep)
    .join("/");
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length > 1 ? `${folder.name}/${relative}` : relative;
}
