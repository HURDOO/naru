import { describe, expect, it } from "vitest";
import { documentSections } from "./document-sections";

describe("documentSections", () => {
  it("uses the document h1 as a title and groups h2 sections with their subsections", () => {
    const sections = documentSections(
      [
        "# Guide",
        "",
        "Intro copy.",
        "",
        "## Setup",
        "Install it.",
        "",
        "### macOS",
        "Run the command.",
        "",
        "## Usage",
        "Use it.",
      ].join("\n"),
      [
        { depth: 1, text: "Guide", line: 1 },
        { depth: 2, text: "Setup", line: 5 },
        { depth: 3, text: "macOS", line: 8 },
        { depth: 2, text: "Usage", line: 11 },
      ],
    );

    expect(sections).toEqual([
      {
        id: "document-introduction",
        title: "소개",
        line: 3,
        markdown: "Intro copy.",
        subheadings: [],
      },
      {
        id: "document-section-5",
        title: "Setup",
        line: 5,
        markdown: "Install it.\n\n### macOS\nRun the command.",
        subheadings: [{ depth: 3, text: "macOS", line: 8 }],
      },
      {
        id: "document-section-11",
        title: "Usage",
        line: 11,
        markdown: "Use it.",
        subheadings: [],
      },
    ]);
  });

  it("uses the shallowest headings when a document has no h1", () => {
    const sections = documentSections("## First\nA\n### Child\nB\n## Second\nC", [
      { depth: 2, text: "First", line: 1 },
      { depth: 3, text: "Child", line: 3 },
      { depth: 2, text: "Second", line: 5 },
    ]);

    expect(sections.map(({ title, markdown }) => ({ title, markdown }))).toEqual([
      { title: "First", markdown: "A\n### Child\nB" },
      { title: "Second", markdown: "C" },
    ]);
  });

  it("falls back to one body section when no content headings exist", () => {
    expect(
      documentSections("# One page\n\nA paragraph.\n\n- item", [
        { depth: 1, text: "One page", line: 1 },
      ]),
    ).toEqual([
      {
        id: "document-body",
        title: "본문",
        line: 3,
        markdown: "A paragraph.\n\n- item",
        subheadings: [],
      },
    ]);
  });

  it("returns no disclosures for an empty title-only document", () => {
    expect(documentSections("# Empty\n", [{ depth: 1, text: "Empty", line: 1 }])).toEqual([]);
  });
});
