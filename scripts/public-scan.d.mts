export interface PublicScanFinding {
  readonly code: string;
  readonly location: string;
}

export interface PublicScanResult {
  readonly files: number;
  readonly objects: number;
  readonly findings: readonly PublicScanFinding[];
}

export function scanRepository(
  repositoryRoot?: string,
  options?: { readonly denylistFile?: string },
): PublicScanResult;
