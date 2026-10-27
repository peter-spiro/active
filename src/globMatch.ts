export function matchesFilter(
  filter: string,
  relativePath: string,
  baseName: string,
): boolean {
  const patterns = splitPatterns(filter);
  if (patterns.length === 0) {
    return true;
  }
  const path = relativePath.split("\\").join("/");
  return patterns.some((pattern) => matchesPattern(pattern, path, baseName));
}

function splitPatterns(filter: string): string[] {
  const trimmed = filter.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  const parts = trimmed.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length > 1 && parts.every((part) => /[*?]/.test(part))) {
    return parts;
  }
  return [trimmed];
}

function matchesPattern(
  pattern: string,
  relativePath: string,
  baseName: string,
): boolean {
  const glob = pattern.split("\\").join("/");
  if (glob.includes("/")) {
    return globToRegExp(glob).test(relativePath);
  }
  return (
    globToRegExp(glob).test(baseName) ||
    globToRegExp(`**/${glob}`).test(relativePath)
  );
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}
