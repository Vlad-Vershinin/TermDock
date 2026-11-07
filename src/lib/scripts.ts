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

/** Text to send to the shell to run the script. */
export function scriptInput(script: Script, body: string): string {
  const text = body.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (script.mode === "bash") {
    // A quoted heredoc: no expansion by the interactive shell, the script runs in one bash process.
    let marker = "TERMDOCEOF";
    while (text.includes(marker)) marker += "_";
    return `bash -s <<'${marker}'\r${text.replace(/\n/g, "\r")}\r${marker}\r`;
  }
  return text.replace(/\n/g, "\r") + "\r";
}
