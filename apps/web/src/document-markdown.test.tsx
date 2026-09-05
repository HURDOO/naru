import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeMarkdown } from "./document-markdown";

describe("SafeMarkdown", () => {
  it("renders GFM without executing raw HTML or loading remote images", () => {
    const html = renderToStaticMarkup(
      <SafeMarkdown
        markdown={[
          "- [x] safe task",
          "<script>window.compromised = true</script>",
          "![remote preview](https://example.com/private.png)",
          "[unsafe](javascript:alert(1))",
        ].join("\n\n")}
      />,
    );

    expect(html).toContain("safe task");
    expect(html).toContain("이미지: remote preview (외부 로드 안 함)");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
  });
});
