import { memo, type ReactNode, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentIdentity, Presence, Tone } from "./agent-model";
import { presenceTone } from "./agent-model";

/** Small shared pieces of the agent screens (AP-D022). */

const ICONS = {
  dash: (
    <>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </>
  ),
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  flow: (
    <>
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect width="8" height="8" x="13" y="13" rx="2" />
    </>
  ),
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  up: (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  merge: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </>
  ),
  branch: (
    <>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  pen: (
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="9" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  bot: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </>
  ),
  spark: (
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  ),
  brain: (
    <>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  hand: (
    <>
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </>
  ),
  panel: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  className,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <svg
      className={className === undefined ? "ag-icon" : `ag-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

export function Avatar({
  identity,
  size = 28,
  presence,
}: {
  readonly identity: Pick<AgentIdentity, "glyph" | "color">;
  readonly size?: number;
  readonly presence?: Presence;
}): React.JSX.Element {
  return (
    <span
      className="ag-avatar"
      style={
        { "--avatar-size": `${size}px`, "--avatar-color": identity.color } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {identity.glyph}
      {presence !== undefined && (
        <span className="ag-avatar-status" data-tone={presenceTone(presence)} />
      )}
    </span>
  );
}

export function Pill({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <span className="ag-pill" data-tone={tone}>
      <span className="ag-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Progress({
  value,
  total,
  label,
}: {
  readonly value: number;
  readonly total: number;
  readonly label: string;
}): React.JSX.Element {
  const ratio = total === 0 ? 0 : Math.min(1, value / total);
  return (
    <span
      className="ag-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
    >
      <span style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}

/**
 * A modal sheet on the native <dialog> (focus stays inside, Esc closes, the trigger gets focus
 * back). On phones it rises from the bottom.
 */
export function Sheet({
  title,
  onClose,
  children,
  wide = false,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly wide?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const cancel = (event: Event) => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener("cancel", cancel);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      if (dialog.open) dialog.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="ag-sheet"
      data-wide={wide}
      aria-label={title}
      onClick={(event) => {
        // A click on the backdrop (the dialog box itself, outside its content) closes it.
        if (event.target === event.currentTarget) close.current();
      }}
    >
      <div className="ag-sheet-body">
        <header className="ag-sheet-header">
          <h2>{title}</h2>
          <button className="ag-icon-button" type="button" aria-label="닫기" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

/**
 * Agent and user text as chat prose: GitHub markdown, no raw HTML, no remote images. Parsed again
 * only when the text changes: the thread re-renders whenever it reads its pages (AP-D046).
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  block,
}: {
  readonly text: string;
  /** The conversation block this text is, for keeping the reader's place (AP-D046). */
  readonly block?: string;
}): React.JSX.Element {
  return (
    <div className="ag-prose" data-block={block}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node, ...props }) => {
            void node;
            return <a {...props} target="_blank" rel="noreferrer noopener" />;
          },
          img: ({ alt }) => <span className="ag-muted">이미지{alt ? `: ${alt}` : ""}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
