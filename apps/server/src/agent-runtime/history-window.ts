import { fitHistoryPage } from "./history-page.js";

/**
 * Newest-first history reads between Naru and a runner (Claude AP-D045, Codex AP-D046). The
 * channel's `history` message carries one cursor, so a read toward older items travels as a cursor
 * of its own and the reply's `nextCursor` names where the page starts. Claude's offsets also name
 * where the page before it ends; Codex's cursors read one way, so its reply says that apart
 * (`previousCursor`). A runner an earlier Naru or Host started refuses these cursors and Naru reads
 * forward instead.
 */
export const LATEST_HISTORY = "latest";
const BEFORE = "before:";

export type HistoryCursor =
  | { readonly kind: "forward"; readonly offset: number }
  | { readonly kind: "latest" }
  | { readonly kind: "before"; readonly offset: number };

/** What the person's view asks for (AP-D045); cursors are the ones pages returned. */
export type HistoryRead =
  | { readonly kind: "forward"; readonly cursor: string | null }
  | { readonly kind: "latest" }
  | { readonly kind: "before"; readonly cursor: string };

/** The cursor for the page that ends where `start` (a page's start offset) begins. */
export function historyBefore(start: string): string {
  return `${BEFORE}${start}`;
}

export function parseHistoryCursor(cursor: string | null): HistoryCursor {
  if (cursor === LATEST_HISTORY) return { kind: "latest" };
  const before = cursor?.startsWith(BEFORE) === true;
  const raw = cursor === null ? "0" : before ? cursor.slice(BEFORE.length) : cursor;
  const offset = /^\d{1,15}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(offset)) throw new Error("Invalid history cursor.");
  return before ? { kind: "before", offset } : { kind: "forward", offset };
}

/**
 * For a runtime with its own opaque cursors (Codex): where a newest-first read starts, null for
 * the newest page, or undefined for a read forward from `cursor`.
 */
export function newestFirstFrom(cursor: string | null): string | null | undefined {
  if (cursor === LATEST_HISTORY) return null;
  return cursor?.startsWith(BEFORE) === true ? cursor.slice(BEFORE.length) : undefined;
}

/** The longest run of the newest items that fits one page, at least one item (AP-D040). */
export function fitHistoryTail(items: readonly unknown[]): unknown[] {
  return fitHistoryPage([...items].reverse()).reverse();
}
