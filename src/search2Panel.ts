import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  runSearch,
  type SearchFile,
  type SearchOutcome,
  type SearchRequest,
} from "./search2";

const QUERY_KEY = "search2.query";
const INCLUDE_KEY = "search2.include";
const EXCLUDE_KEY = "search2.exclude";
const FLAGS_KEY = "search2.flags";

type Flags = {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export class Search2Panel
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private query = "";
  private include = "";
  private exclude = "";
  private flags: Flags = { matchCase: false, wholeWord: false, regex: false };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: { cancel: () => void } | undefined;

  constructor(private readonly workspaceState: vscode.Memento) {
    this.query = readString(workspaceState.get(QUERY_KEY));
    this.include = readString(workspaceState.get(INCLUDE_KEY));
    this.exclude = readString(workspaceState.get(EXCLUDE_KEY));
    this.flags = readFlags(workspaceState.get(FLAGS_KEY));
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.current?.cancel();
  }

  refresh(): void {
    this.execute();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = documentHtml(view.webview, {
      query: this.query,
      include: this.include,
      exclude: this.exclude,
      ...this.flags,
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.webview.onDidReceiveMessage((message: unknown) => {
      this.onMessage(message);
    });
    if (this.query) {
      this.execute();
    }
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }
    const body = message as {
      type?: unknown;
      query?: unknown;
      include?: unknown;
      exclude?: unknown;
      matchCase?: unknown;
      wholeWord?: unknown;
      regex?: unknown;
      path?: unknown;
      line?: unknown;
      start?: unknown;
      end?: unknown;
    };
    if (body.type === "search") {
      this.query = typeof body.query === "string" ? body.query : "";
      this.include = typeof body.include === "string" ? body.include : "";
      this.exclude = typeof body.exclude === "string" ? body.exclude : "";
      this.flags = {
        matchCase: body.matchCase === true,
        wholeWord: body.wholeWord === true,
        regex: body.regex === true,
      };
      void this.workspaceState.update(QUERY_KEY, this.query);
      void this.workspaceState.update(INCLUDE_KEY, this.include);
      void this.workspaceState.update(EXCLUDE_KEY, this.exclude);
      void this.workspaceState.update(FLAGS_KEY, this.flags);
      this.schedule();
      return;
    }
    if (body.type === "open" && typeof body.path === "string") {
      const line = typeof body.line === "number" ? body.line : 1;
      const start = typeof body.start === "number" ? body.start : 0;
      const end = typeof body.end === "number" ? body.end : start;
      void openHit(body.path, line, start, end);
    }
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.execute();
    }, 200);
  }

  private execute(): void {
    this.current?.cancel();
    const request: SearchRequest = {
      query: this.query,
      include: this.include,
      exclude: this.exclude,
      ...this.flags,
    };
    if (!request.query) {
      this.current = undefined;
      this.post({
        type: "results",
        html: `<div class="status">Type to search.</div>`,
      });
      return;
    }
    this.post({
      type: "results",
      html: `<div class="status">Searching…</div>`,
    });
    const run = runSearch(request);
    this.current = run;
    void run.done.then((outcome) => {
      if (this.current !== run) {
        return;
      }
      this.current = undefined;
      if (!outcome) {
        return;
      }
      this.post({ type: "results", html: renderOutcome(outcome) });
    });
  }

  private post(message: unknown): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage(message);
  }
}

async function openHit(
  filePath: string,
  line: number,
  start: number,
  end: number,
): Promise<void> {
  const lineIndex = Math.max(0, line - 1);
  const from = Math.max(0, start);
  const to = Math.max(from, end);
  const editor = await vscode.window.showTextDocument(
    vscode.Uri.file(filePath),
    {
      preview: true,
      selection: new vscode.Range(lineIndex, from, lineIndex, to),
    },
  );
  editor.revealRange(
    new vscode.Range(lineIndex, from, lineIndex, to),
    vscode.TextEditorRevealType.InCenter,
  );
}

function renderOutcome(outcome: SearchOutcome): string {
  if (outcome.error) {
    return `<div class="status">${escapeHtml(firstLine(outcome.error))}</div>`;
  }
  if (outcome.matchCount === 0) {
    return `<div class="status">No results</div>`;
  }
  const fileNoun = outcome.files.length === 1 ? "file" : "files";
  const resultNoun = outcome.matchCount === 1 ? "result" : "results";
  const limit = outcome.limited ? " Showing the first 2000." : "";
  const summary = `${outcome.matchCount} ${resultNoun} in ${outcome.files.length} ${fileNoun}.${limit}`;
  return `<div class="status">${escapeHtml(summary)}</div>${outcome.files
    .map((file, index) => renderFile(file, index))
    .join("")}`;
}

function renderFile(file: SearchFile, index: number): string {
  const hits = file.hits
    .map(
      (hit) =>
        `<div class="hit" role="treeitem" tabindex="0" data-file="${index}" data-path="${escapeHtml(hit.path)}" data-line="${hit.line}" data-start="${hit.start}" data-end="${hit.end}"><span class="ln">${hit.line}</span><span class="code">${highlight(hit.text, hit.spans)}</span></div>`,
    )
    .join("");
  return `<div class="file" data-file="${index}" title="${escapeHtml(file.path)}"><span class="name">${escapeHtml(file.label)}</span><span class="count">${file.hits.length}</span></div>${hits}`;
}

function highlight(
  text: string,
  spans: Array<{ start: number; end: number }>,
): string {
  let html = "";
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    html += escapeHtml(text.slice(cursor, start));
    html += `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

function firstLine(value: string): string {
  const line = value.split("\n").find((item) => item.trim().length > 0);
  return line?.trim() || "Search failed.";
}

function documentHtml(webview: vscode.Webview, request: SearchRequest): string {
  const nonce = randomBytes(16).toString("hex");
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const flag = (
    name: string,
    title: string,
    label: string,
    on: boolean,
  ): string =>
    `<button type="button" class="flag${on ? " on" : ""}" data-flag="${name}" title="${title}" aria-pressed="${on ? "true" : "false"}">${label}</button>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex;
    flex-direction: column;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--vscode-sideBar-background);
  }
  #bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 6px 4px;
  }
  .searchline { display: flex; gap: 2px; }
  input, button.flag {
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    font: inherit;
  }
  input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    height: 26px;
    padding: 0 6px;
  }
  input:focus, button.flag:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  button.flag {
    flex: none;
    width: 26px;
    height: 26px;
    padding: 0;
    cursor: pointer;
  }
  button.flag.on {
    color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
    background: var(--vscode-inputOption-activeBackground, var(--vscode-list-activeSelectionBackground));
    border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
  }
  #results { flex: 1; overflow: auto; padding-bottom: 8px; }
  .status {
    padding: 4px 10px 6px;
    color: var(--vscode-descriptionForeground);
  }
  .file, .hit {
    display: flex;
    align-items: center;
    min-width: 0;
    height: 22px;
    line-height: 22px;
    cursor: pointer;
    user-select: none;
  }
  .file { padding: 0 8px 0 4px; }
  .hit { padding-right: 8px; }
  .file:hover, .hit:hover { background: var(--vscode-list-hoverBackground); }
  .hit:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .hit[hidden] { display: none; }
  .name, .code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .name { flex: 1; }
  .count, .ln {
    flex: none;
    color: var(--vscode-descriptionForeground);
  }
  .count { margin-left: 8px; }
  .ln {
    width: 42px;
    padding-right: 6px;
    text-align: right;
  }
  .code { flex: 1; }
  mark {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.45));
    color: inherit;
  }
</style>
</head>
<body>
  <div id="bar">
    <div class="searchline">
      <input id="query" type="text" spellcheck="false" placeholder="Search" aria-label="Search" value="${escapeHtml(request.query)}" />
      ${flag("case", "Match Case", "Aa", request.matchCase)}
      ${flag("word", "Match Whole Word", "ab", request.wholeWord)}
      ${flag("regex", "Use Regular Expression", ".*", request.regex)}
    </div>
    <input id="exclude" type="text" spellcheck="false" placeholder="exclude" aria-label="exclude" title="Omit lines that contain this text" value="${escapeHtml(request.exclude)}" />
    <input id="include" type="text" spellcheck="false" placeholder="files to include" aria-label="files to include" value="${escapeHtml(request.include)}" />
  </div>
  <div id="results"><div class="status">${request.query ? "Searching…" : "Type to search."}</div></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const query = document.getElementById("query");
    const include = document.getElementById("include");
    const exclude = document.getElementById("exclude");
    const results = document.getElementById("results");
    const flags = {
      case: document.querySelector('[data-flag="case"]'),
      word: document.querySelector('[data-flag="word"]'),
      regex: document.querySelector('[data-flag="regex"]'),
    };

    function send() {
      vscode.postMessage({
        type: "search",
        query: query.value,
        include: include.value,
        exclude: exclude.value,
        matchCase: flags.case.getAttribute("aria-pressed") === "true",
        wholeWord: flags.word.getAttribute("aria-pressed") === "true",
        regex: flags.regex.getAttribute("aria-pressed") === "true",
      });
    }

    let timer;
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(send, 200);
    }

    query.addEventListener("input", schedule);
    include.addEventListener("input", schedule);
    exclude.addEventListener("input", schedule);
    for (const button of Object.values(flags)) {
      button.addEventListener("click", () => {
        const on = button.getAttribute("aria-pressed") === "true";
        button.setAttribute("aria-pressed", on ? "false" : "true");
        button.classList.toggle("on", !on);
        send();
      });
    }

    function fromEvent(target) {
      if (target instanceof Element) return target;
      return target && target.parentElement ? target.parentElement : null;
    }

    results.addEventListener("click", (event) => {
      const target = fromEvent(event.target);
      if (!target) return;
      const hit = target.closest(".hit");
      if (hit) {
        vscode.postMessage({
          type: "open",
          path: hit.getAttribute("data-path"),
          line: Number(hit.getAttribute("data-line")),
          start: Number(hit.getAttribute("data-start")),
          end: Number(hit.getAttribute("data-end")),
        });
        return;
      }
      const file = target.closest(".file");
      if (!file) return;
      const id = file.getAttribute("data-file");
      const collapsed = file.classList.toggle("collapsed");
      for (const row of results.querySelectorAll('.hit[data-file="' + id + '"]')) {
        row.hidden = collapsed;
      }
    });
    results.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const row = document.activeElement;
      if (!row || !row.classList || !row.classList.contains("hit")) return;
      event.preventDefault();
      row.click();
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.type !== "results") return;
      results.innerHTML = message.html;
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readFlags(value: unknown): Flags {
  if (!value || typeof value !== "object") {
    return { matchCase: false, wholeWord: false, regex: false };
  }
  const flags = value as {
    matchCase?: unknown;
    wholeWord?: unknown;
    regex?: unknown;
  };
  return {
    matchCase: flags.matchCase === true,
    wholeWord: flags.wholeWord === true,
    regex: flags.regex === true,
  };
}
