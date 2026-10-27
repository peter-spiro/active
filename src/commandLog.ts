import * as vscode from "vscode";

const MAX_CHARS = 100_000;
let channel: vscode.OutputChannel | undefined;

export function disposeCommandLog(): void {
  channel?.dispose();
  channel = undefined;
}

export function logCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  stdout: unknown,
  stderr: unknown,
  code?: number | string,
): void {
  if (command !== "git" && command !== "gh") {
    return;
  }
  const lines = [`[${cwd}] $ ${formatCommand(command, args)}`];
  pushBody(lines, stdout);
  pushBody(lines, stderr);
  if (typeof code === "number" && code !== 0) {
    lines.push(`exited ${code}`);
  } else if (typeof code === "string" && code.length > 0) {
    lines.push(code);
  }
  output().append(`${lines.join("\n")}\n\n`);
}

export function commandFailure(error: unknown): {
  stdout: unknown;
  stderr: unknown;
  code?: number | string;
} {
  return {
    stdout: field(error, "stdout"),
    stderr: field(error, "stderr"),
    code: exitCode(error),
  };
}

function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel("Active");
  return channel;
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(quote)].join(" ");
}

function quote(arg: string): string {
  if (arg.length === 0 || /[\s"'$`\\]/.test(arg)) {
    return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return arg;
}

function pushBody(lines: string[], value: unknown): void {
  const text = bodyText(value);
  if (text) {
    lines.push(text);
  }
}

function bodyText(value: unknown): string {
  if (typeof value === "string") {
    return clip(value.replace(/\s+$/, ""));
  }
  if (!Buffer.isBuffer(value) || value.length === 0) {
    return "";
  }
  if (value.includes(0)) {
    return `(binary, ${value.length} bytes)`;
  }
  return clip(value.toString("utf8").replace(/\s+$/, ""));
}

function clip(text: string): string {
  if (text.length <= MAX_CHARS) {
    return text;
  }
  const extra = text.length - MAX_CHARS;
  return `${text.slice(0, MAX_CHARS)}\n… (truncated, ${extra} more characters)`;
}

function field(error: unknown, name: "stdout" | "stderr"): unknown {
  if (!error || typeof error !== "object" || !(name in error)) {
    return undefined;
  }
  return (error as { stdout?: unknown; stderr?: unknown })[name];
}

function exitCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number" || typeof code === "string") {
    return code;
  }
  return undefined;
}
