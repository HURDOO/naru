import type { DocumentHeading } from "@naru/contracts";

export interface DocumentSection {
  id: string;
  title: string;
  line: number;
  markdown: string;
  subheadings: readonly DocumentHeading[];
}

export function documentSections(
  source: string,
  headings: readonly DocumentHeading[],
): DocumentSection[] {
  const lines = source.split(/\r?\n/);
  const titleHeading = headings[0]?.depth === 1 ? headings[0] : undefined;
  const sectionHeadings = titleHeading === undefined ? [...headings] : headings.slice(1);

  if (sectionHeadings.length === 0) {
    const markdown = withoutHeadingLine(lines, titleHeading?.line).join("\n").trim();
    return markdown === ""
      ? []
      : [
          {
            id: "document-body",
            title: "본문",
            line: firstContentLine(lines, titleHeading?.line),
            markdown,
            subheadings: [],
          },
        ];
  }

  const primaryDepth = Math.min(...sectionHeadings.map((heading) => heading.depth));
  const primaryHeadings = sectionHeadings.filter((heading) => heading.depth === primaryDepth);
  const sections: DocumentSection[] = [];
  const introductionEnd = (primaryHeadings[0]?.line ?? lines.length + 1) - 1;
  const introduction = withoutHeadingLine(lines.slice(0, introductionEnd), titleHeading?.line)
    .join("\n")
    .trim();

  if (introduction !== "") {
    sections.push({
      id: "document-introduction",
      title: "소개",
      line: firstContentLine(lines.slice(0, introductionEnd), titleHeading?.line),
      markdown: introduction,
      subheadings: [],
    });
  }

  for (const [index, heading] of primaryHeadings.entries()) {
    const nextLine = primaryHeadings[index + 1]?.line ?? lines.length + 1;
    const markdown = lines
      .slice(heading.line, nextLine - 1)
      .join("\n")
      .trim();
    sections.push({
      id: `document-section-${heading.line}`,
      title: heading.text,
      line: heading.line,
      markdown,
      subheadings: sectionHeadings.filter(
        (candidate) => candidate.line > heading.line && candidate.line < nextLine,
      ),
    });
  }

  return sections;
}

function withoutHeadingLine(lines: readonly string[], headingLine?: number): string[] {
  if (headingLine === undefined) return [...lines];
  return lines.filter((_, index) => index !== headingLine - 1);
}

function firstContentLine(lines: readonly string[], excludedLine?: number): number {
  const index = lines.findIndex(
    (line, lineIndex) => lineIndex !== (excludedLine ?? 0) - 1 && line.trim() !== "",
  );
  return index < 0 ? 1 : index + 1;
}
