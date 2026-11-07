import { Script } from "./api";

/** `{{name}}` or `{{name:default}}` placeholders, asked for before running. */
const VAR_RE = /\{\{\s*([\p{L}\w-]+)(?::([^}]*))?\s*\}\}/gu;

export function scriptVariables(body: string): { name: string; def: string }[] {
  const seen = new Map<string, string>();
  for (const m of body.matchAll(VAR_RE)) if (!seen.has(m[1])) seen.set(m[1], m[2] ?? "");
  return [...seen].map(([name, def]) => ({ name, def }));
}

export function fillVariables(body: string, values: Record<string, string>): string {
  return body.replace(VAR_RE, (_, name: string) => values[name] ?? "");
}

const normalize = (body: string) => body.replace(/\r\n?/g, "\n").replace(/\n+$/, "");

/** Text to send to the shell to run the whole script at once. */
export function scriptInput(script: Script, body: string): string {
  const text = normalize(body);
  if (script.mode === "bash") {
    // A quoted heredoc: no expansion by the interactive shell, the script runs in one bash process.
    let marker = "TERMDOCEOF";
    while (text.includes(marker)) marker += "_";
    return `bash -s <<'${marker}'\r${text.replace(/\n/g, "\r")}\r${marker}\r`;
  }
  return commandBlock(text.split("\n"));
}

/**
 * Several lines typed ahead into a shell get eaten by the first command that reads input
 * (sudo flushes pending input before its password prompt, apt takes the next line as the
 * answer to [Y/n]). Wrapped in `{ ... }` the shell reads the whole block before running it,
 * so nothing is left waiting in the input — and cd / export still apply to the session.
 */
export function commandBlock(lines: string[]): string {
  const body = lines.join("\n").replace(/\n+$/, "");
  if (!body.includes("\n")) return body + "\r";
  return `{\r${body.replace(/\n/g, "\r")}\r}\r`;
}

/** Commands of a script for step-by-step runs: one per line, `\`-continued lines joined, blank lines skipped. */
export function scriptSteps(body: string): string[] {
  const steps: string[] = [];
  let cur = "";
  for (const line of normalize(body).split("\n")) {
    cur = cur ? `${cur}\n${line}` : line;
    if (/\\$/.test(line)) continue;
    if (cur.trim()) steps.push(cur);
    cur = "";
  }
  if (cur.trim()) steps.push(cur);
  return steps;
}
