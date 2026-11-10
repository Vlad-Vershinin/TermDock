import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

// Links in the terminal, including ones split over several rows. xterm's web-links addon only
// follows soft wraps; TUIs (Claude Code, Ink apps, boxes drawn with │) break a long URL with
// hard line breaks and often indent or frame the pieces, so it saw only the first row.

/** Characters that may continue a URL on the next row. */
const URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
/** Box-drawing characters TUIs frame text with. */
const isBorder = (c: string) => c >= "─" && c <= "╿";
const URL_RE = /https?:\/\/[^\s"'<>`─-╿]+/g;
/** How far from the right edge a hard-broken row may end (border + padding of a box). */
const EDGE = 5;
/** Rows searched up and down from the hovered one. */
const MAX_ROWS = 40;

interface Row {
  chars: string[];
  /** Buffer column of each char (wide chars take two columns). */
  cols: number[];
  /** Index range of the content without indentation, trailing spaces and box borders. */
  from: number;
  to: number;
  /** The row is a soft-wrapped continuation of the previous one. */
  wrapped: boolean;
}

function readRow(line: IBufferLine, width: number): Row {
  const chars: string[] = [];
  const cols: number[] = [];
  for (let x = 0; x < width; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    chars.push(cell.getChars() || " ");
    cols.push(x);
  }
  const blank = (c: string) => c === " " || isBorder(c);
  let from = 0;
  let to = chars.length;
  while (from < to && blank(chars[from])) from++;
  while (to > from && blank(chars[to - 1])) to--;
  return { chars, cols, from, to, wrapped: line.isWrapped };
}

/** How row `b` continues row `a`: soft wrap, a hard break inside a URL, or not at all. */
function joinKind(a: Row, b: Row, width: number): "soft" | "hard" | null {
  if (b.wrapped) return "soft";
  if (a.to === a.from || b.to === b.from) return null;
  const fullRow = a.cols[a.to - 1] >= width - EDGE;
  return fullRow && URL_CHAR.test(a.chars[a.to - 1]) && URL_CHAR.test(b.chars[b.from]) ? "hard" : null;
}

/** Strips punctuation that usually ends a sentence rather than the URL. */
function trimUrl(url: string): string {
  for (;;) {
    const last = url[url.length - 1];
    if (/[.,;:!?'*]/.test(last)) url = url.slice(0, -1);
    else if (last === ")" && count(url, "(") < count(url, ")")) url = url.slice(0, -1);
    else if (last === "]" && count(url, "[") < count(url, "]")) url = url.slice(0, -1);
    else return url;
  }
}
const count = (s: string, c: string) => s.split(c).length - 1;

export interface LinkEvents {
  open: (url: string) => void;
  hover: (url: string | null) => void;
}

export function urlLinkProvider(term: Terminal, events: LinkEvents): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      const width = term.cols;
      const cache = new Map<number, Row | null>();
      const row = (i: number) => {
        if (!cache.has(i)) {
          const line = buf.getLine(i);
          cache.set(i, line ? readRow(line, width) : null);
        }
        return cache.get(i)!;
      };
      const join = (i: number) => {
        // How row i continues row i - 1.
        const a = row(i - 1);
        const b = row(i);
        return a && b ? joinKind(a, b, width) : null;
      };

      // The block of joined rows around the hovered one (y is 1-based).
      const at = y - 1;
      if (!row(at)) return callback(undefined);
      let top = at;
      while (top > 0 && at - top < MAX_ROWS && join(top)) top--;
      let bottom = at;
      while (bottom - at < MAX_ROWS && row(bottom + 1) && join(bottom + 1)) bottom++;

      // Glue the rows; a hard break drops the indentation, padding and borders around it.
      let text = "";
      const pos: { x: number; y: number }[] = [];
      for (let i = top; i <= bottom; i++) {
        const r = row(i)!;
        const start = i > top && join(i) === "hard" ? r.from : 0;
        const end = i < bottom && join(i + 1) === "hard" ? r.to : r.chars.length;
        for (let k = start; k < end; k++) {
          text += r.chars[k];
          pos.push({ x: r.cols[k], y: i });
        }
      }

      const links: ILink[] = [];
      for (const m of text.matchAll(URL_RE)) {
        const url = trimUrl(m[0]);
        const a = m.index!;
        const b = a + url.length;
        // Only the part on the hovered row: rows may be framed, so one range can't span them.
        const own = pos.slice(a, b).filter((p) => p.y === at);
        if (!own.length) continue;
        links.push({
          text: url,
          range: { start: { x: own[0].x + 1, y }, end: { x: own[own.length - 1].x + 1, y } },
          decorations: { underline: true, pointerCursor: true },
          activate: (_e, u) => events.open(u),
          hover: (_e, u) => events.hover(u),
          leave: () => events.hover(null),
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}

/**
 * The local callback of an OAuth link (`redirect_uri=http://localhost:PORT/…`). A program on the
 * server waits for that redirect on the server's own localhost, so the port has to be forwarded
 * for the browser on this machine to reach it.
 */
export function localCallback(url: string): { host: string; port: number } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const key of ["redirect_uri", "redirect_url", "callback_url"]) {
    const value = u.searchParams.get(key);
    if (!value) continue;
    try {
      const r = new URL(value);
      const host = r.hostname.replace(/^\[|\]$/g, "");
      if (/^https?:$/.test(r.protocol) && r.port && ["localhost", "127.0.0.1", "::1"].includes(host)) {
        return { host, port: Number(r.port) };
      }
    } catch {
      // Not an absolute URL.
    }
  }
  return null;
}
