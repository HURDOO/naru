import { createTwoFilesPatch, diffArrays } from "diff";

interface LineChange {
  readonly start: number;
  readonly end: number;
  readonly replacement: readonly string[];
}

export interface MergeTextSegment {
  readonly kind: "text";
  readonly text: string;
}

export interface MergeConflictSegment {
  readonly kind: "conflict";
  readonly id: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly base: string;
  readonly mine: string;
  readonly theirs: string;
}

export type ThreeWayMergeSegment = MergeTextSegment | MergeConflictSegment;

export interface ThreeWayMergeResult {
  readonly status: "merged" | "conflict";
  readonly source: string | null;
  readonly segments: readonly ThreeWayMergeSegment[];
  readonly conflicts: readonly MergeConflictSegment[];
}

export type MergeConflictResolution = "mine" | "theirs" | "both";

export function fileConflictAssistantPrompt(
  path: string,
  base: string,
  mine: string,
  theirs: string,
): string {
  const minePatch = createTwoFilesPatch(`${path} (base)`, `${path} (내 초안)`, base, mine, "", "", {
    context: 4,
  });
  const currentPatch = createTwoFilesPatch(
    `${path} (base)`,
    `${path} (현재 디스크)`,
    base,
    theirs,
    "",
    "",
    { context: 4 },
  );
  return [
    `Naru Files Pane에서 ${path} 저장 충돌이 발생했습니다.`,
    `프로젝트의 ${path} 파일을 직접 읽고, 아래 병합 원칙을 반드시 지켜 해결해 주세요.`,
    "",
    "병합 원칙:",
    "1. 현재 디스크 파일을 최신 출발점으로 삼으세요. 내 초안 전체로 파일을 교체하지 마세요.",
    "2. base→내 초안 patch를 사용자가 적용하려던 의도로 보고, 그 변경만 현재 디스크에 최소한으로 적용하세요.",
    "3. 현재 디스크와 내 초안의 비충돌 추가·수정은 양쪽 모두 보존하세요. 한쪽 문장이나 코드를 편의상 삭제하지 마세요.",
    "4. 같은 부분이 겹치면 한쪽을 그대로 고르지 말고 두 변경의 의미를 만족하는 결과로 합성하세요.",
    "5. 대상 파일만 수정하고 무관한 포맷 변경, 정리, 리팩터링, 다른 파일 수정은 하지 마세요.",
    "6. 쓰기 전에 최종본을 두 patch와 비교해 양쪽 비충돌 변경이 남았는지 확인하세요. Git 충돌 marker는 쓰지 마세요.",
    "7. 두 의도를 함께 보존할 방법을 확신할 수 없으면 파일을 수정하지 말고 사용자에게 선택을 질문하세요.",
    "",
    "수정했다면 응답에 현재 디스크에서 보존한 내용, 내 초안에서 적용한 내용, 남은 모호함을 각각 짧게 알려 주세요.",
    "",
    "base→내 초안 patch (사용자 의도):",
    "```diff",
    minePatch,
    "```",
    "",
    "base→현재 디스크 patch (최신 외부 변경):",
    "```diff",
    currentPatch,
    "```",
  ].join("\n");
}

export function threeWayMerge(base: string, mine: string, theirs: string): ThreeWayMergeResult {
  if (mine === theirs) return merged(mine);
  if (mine === base) return merged(theirs);
  if (theirs === base) return merged(mine);

  const baseLines = lines(base);
  const mineChanges = changes(baseLines, lines(mine));
  const theirChanges = changes(baseLines, lines(theirs));
  const clusters = changeClusters(mineChanges, theirChanges);
  const segments: ThreeWayMergeSegment[] = [];
  let cursor = 0;
  let conflictNumber = 0;

  for (const cluster of clusters) {
    appendText(segments, baseLines.slice(cursor, cluster.start).join(""));
    const baseText = baseLines.slice(cluster.start, cluster.end).join("");
    const mineText = applyChanges(baseLines, cluster.start, cluster.end, cluster.mine);
    const theirText = applyChanges(baseLines, cluster.start, cluster.end, cluster.theirs);

    if (cluster.mine.length === 0) appendText(segments, theirText);
    else if (cluster.theirs.length === 0 || mineText === theirText) appendText(segments, mineText);
    else if (mineText === baseText) appendText(segments, theirText);
    else if (theirText === baseText) appendText(segments, mineText);
    else {
      conflictNumber += 1;
      segments.push({
        kind: "conflict",
        id: `conflict-${conflictNumber}`,
        startLine: cluster.start + 1,
        endLine: Math.max(cluster.start + 1, cluster.end),
        base: baseText,
        mine: mineText,
        theirs: theirText,
      });
    }
    cursor = cluster.end;
  }
  appendText(segments, baseLines.slice(cursor).join(""));

  const conflicts = segments.filter(
    (segment): segment is MergeConflictSegment => segment.kind === "conflict",
  );
  return conflicts.length === 0
    ? { status: "merged", source: renderResolvedSegments(segments, {}), segments, conflicts }
    : { status: "conflict", source: null, segments, conflicts };
}

export function renderResolvedSegments(
  segments: readonly ThreeWayMergeSegment[],
  resolutions: Readonly<Record<string, MergeConflictResolution>>,
): string | null {
  let output = "";
  for (const segment of segments) {
    if (segment.kind === "text") {
      output += segment.text;
      continue;
    }
    const resolution = resolutions[segment.id];
    if (resolution === undefined) return null;
    if (resolution === "mine") output += segment.mine;
    else if (resolution === "theirs") output += segment.theirs;
    else output += `${segment.mine}${segment.theirs}`;
  }
  return output;
}

function merged(source: string): ThreeWayMergeResult {
  const segment: MergeTextSegment = { kind: "text", text: source };
  return { status: "merged", source, segments: [segment], conflicts: [] };
}

function lines(source: string): string[] {
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function changes(base: readonly string[], variant: readonly string[]): LineChange[] {
  const components = diffArrays<string>([...base], [...variant], { timeout: 1_000 });
  if (components === undefined) return [{ start: 0, end: base.length, replacement: variant }];

  const result: LineChange[] = [];
  let baseCursor = 0;
  let index = 0;
  while (index < components.length) {
    const component = components[index];
    if (component === undefined) break;
    if (!component.added && !component.removed) {
      baseCursor += component.value.length;
      index += 1;
      continue;
    }

    const start = baseCursor;
    const replacement: string[] = [];
    while (index < components.length) {
      const changed = components[index];
      if (changed === undefined || (!changed.added && !changed.removed)) break;
      if (changed.removed) baseCursor += changed.value.length;
      if (changed.added) replacement.push(...changed.value);
      index += 1;
    }
    result.push({ start, end: baseCursor, replacement });
  }
  return result;
}

interface ChangeCluster {
  start: number;
  end: number;
  readonly mine: LineChange[];
  readonly theirs: LineChange[];
}

function changeClusters(
  mine: readonly LineChange[],
  theirs: readonly LineChange[],
): ChangeCluster[] {
  const tagged = [
    ...mine.map((change) => ({ side: "mine" as const, change })),
    ...theirs.map((change) => ({ side: "theirs" as const, change })),
  ].sort(
    (left, right) =>
      left.change.start - right.change.start ||
      left.change.end - right.change.end ||
      left.side.localeCompare(right.side),
  );
  const clusters: ChangeCluster[] = [];

  for (const item of tagged) {
    const current = clusters.at(-1);
    if (current === undefined || !connected(current, item.change)) {
      clusters.push({
        start: item.change.start,
        end: item.change.end,
        mine: item.side === "mine" ? [item.change] : [],
        theirs: item.side === "theirs" ? [item.change] : [],
      });
      continue;
    }
    current.end = Math.max(current.end, item.change.end);
    current[item.side].push(item.change);
  }
  return clusters;
}

function connected(cluster: ChangeCluster, change: LineChange): boolean {
  if (change.start < cluster.end) return true;
  if (change.start !== cluster.start) return false;
  return change.start === change.end || cluster.start === cluster.end;
}

function applyChanges(
  base: readonly string[],
  start: number,
  end: number,
  changes: readonly LineChange[],
): string {
  let output = "";
  let cursor = start;
  for (const change of changes) {
    output += base.slice(cursor, change.start).join("");
    output += change.replacement.join("");
    cursor = change.end;
  }
  output += base.slice(cursor, end).join("");
  return output;
}

function appendText(segments: ThreeWayMergeSegment[], text: string): void {
  if (text === "") return;
  const previous = segments.at(-1);
  if (previous?.kind === "text") {
    segments[segments.length - 1] = { kind: "text", text: `${previous.text}${text}` };
  } else {
    segments.push({ kind: "text", text });
  }
}
