import {
  NARU_APP_BASE_PATH_META_NAME,
  NARU_LEGACY_APP_BASE_PATH,
  naruAppPath,
  naruAppScopePath,
  parseNaruAppBasePath,
} from "@naru/contracts/naru-app/v1";

const APP_BASE_PATH_META_SELECTOR = `meta[name="${NARU_APP_BASE_PATH_META_NAME}"]`;

export interface AppBasePathMetaSource {
  querySelectorAll(
    selector: string,
  ): ArrayLike<{ readonly getAttribute: (name: string) => string | null }>;
}

export function readConfiguredAppBasePath(source: AppBasePathMetaSource): string | null {
  const matches = source.querySelectorAll(APP_BASE_PATH_META_SELECTOR);
  if (matches.length !== 1) return null;
  try {
    return parseNaruAppBasePath(matches[0]?.getAttribute("content"));
  } catch {
    return null;
  }
}

export function currentAppBasePath(): string {
  if (typeof document === "undefined") return NARU_LEGACY_APP_BASE_PATH;
  const value = readConfiguredAppBasePath(document);
  if (value === null) throw new Error("Naru app base path metadata is missing or invalid.");
  return value;
}

export function currentAppPath(pathname: string): string {
  return naruAppPath(currentAppBasePath(), pathname);
}

export function currentAppScopePath(): string {
  return naruAppScopePath(currentAppBasePath());
}
