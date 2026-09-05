import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function SafeMarkdown({ markdown }: { markdown: string }): React.JSX.Element {
  return (
    <div className="document-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node, ...props }) => {
            void node;
            return <a {...props} target="_blank" rel="noreferrer noopener" />;
          },
          img: ({ alt }) => (
            <span className="document-image-placeholder" role="note">
              이미지{alt ? `: ${alt}` : ""} (외부 로드 안 함)
            </span>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
