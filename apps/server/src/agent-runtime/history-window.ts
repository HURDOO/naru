import { fitHistoryPage } from "./history-page.js";

/**
 * Newest-first history reads between Naru and the Claude runner (AP-D045). The channel's `history`
 * message carries one cursor, so a read toward older items travels as a cursor of its own and the
 * reply's `nextCursor` names where the page starts. A runner an earlier Naru started refuses these
 * cursors and Naru reads forward instead. Codex reads forward only: its launcher runs in the Host,
 * and changing it restarts the Host.
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

/** The longest run of the newest items that fits one page, at least one item (AP-D040). */
export function fitHistoryTail(items: readonly unknown[]): unknown[] {
  return fitHistoryPage([...items].reverse()).reverse();
}
