/** The screens of one top menu (AP-D028): control room first, then workspaces and the flow. */
export type MainView = "control" | "workspace" | "flow";

const ITEMS: readonly { readonly id: MainView; readonly label: string }[] = [
  { id: "control", label: "관제실" },
  { id: "workspace", label: "작업공간" },
  { id: "flow", label: "흐름" },
];

/** "관제실 | 작업공간 | 흐름" and how many things wait for the person (V3-C, V3-M2, V3-M4). */
export function MainNav({
  view,
  waiting,
  onChange,
  className = "main-nav",
}: {
  view: MainView;
  waiting: number;
  onChange: (view: MainView) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <nav className={className} aria-label="주 메뉴">
      <div className="main-nav-switch">
        {ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.id === "control" && waiting > 0 && (
              <span className="main-nav-badge" aria-label={`나를 기다림 ${waiting}`}>
                {waiting}
              </span>
            )}
          </button>
        ))}
      </div>
      {waiting > 0 && (
        <button
          className="agent-waiting-pill"
          type="button"
          aria-label={`나를 기다리는 것 ${waiting}개 보기`}
          onClick={() => onChange("control")}
        >
          <span aria-hidden="true" />
          나를 기다림 {waiting}
        </button>
      )}
    </nav>
  );
}
