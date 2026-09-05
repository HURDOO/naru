import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  activateWaitingPwa,
  getPwaServiceWorkerRegistration,
  isStandalonePwa,
  watchPwaUpdates,
} from "./pwa";

interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

type UpdateState = "ready" | "activating" | "activated" | null;

export function PwaShell({ children }: { children: ReactNode }): React.JSX.Element {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const applyingUpdateRef = useRef(false);

  useEffect(() => {
    const beforeInstall = (event: Event): void => {
      event.preventDefault();
      setInstallDismissed(false);
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const appInstalled = (): void => {
      setInstallPrompt(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", appInstalled);

    let active = true;
    let watcher: ReturnType<typeof watchPwaUpdates> | null = null;
    void getPwaServiceWorkerRegistration().then((registration) => {
      if (!active || !registration) return;
      registrationRef.current = registration;
      watcher = watchPwaUpdates(
        registration,
        () => {
          setUpdateDismissed(false);
          setUpdateState("ready");
        },
        () => {
          if (applyingUpdateRef.current) window.location.reload();
          else setUpdateState("activated");
        },
      );
    });

    return () => {
      active = false;
      watcher?.dispose();
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", appInstalled);
    };
  }, []);

  const install = async (): Promise<void> => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setInstallPrompt(null);
  };

  const update = (): void => {
    const registration = registrationRef.current;
    if (!registration) return;
    applyingUpdateRef.current = true;
    setUpdateState("activating");
    if (!activateWaitingPwa(registration)) {
      window.location.reload();
    }
  };

  const showUpdate = updateState !== null && !updateDismissed;
  const showInstall =
    !showUpdate && !installed && !installDismissed && installPrompt !== null && !isStandalonePwa();

  return (
    <>
      {children}
      {showUpdate && (
        <section className="pwa-shell-notice" role="status" aria-live="polite" data-kind="update">
          <span className="pwa-shell-notice-icon" aria-hidden="true">
            ↻
          </span>
          <div>
            <strong>
              {updateState === "activated" ? "새 버전이 적용됐습니다" : "새 버전 준비됨"}
            </strong>
            <span>
              {updateState === "activated"
                ? "화면을 다시 열면 최신 Naru를 사용합니다."
                : "터미널은 서버에서 계속 실행됩니다. 적용하면 이 화면만 다시 엽니다."}
            </span>
          </div>
          <div className="pwa-shell-notice-actions">
            <button
              className="primary-button compact"
              type="button"
              disabled={updateState === "activating"}
              onClick={updateState === "activated" ? () => window.location.reload() : update}
            >
              {updateState === "activating"
                ? "적용 중…"
                : updateState === "activated"
                  ? "새 버전 열기"
                  : "지금 업데이트"}
            </button>
            {updateState !== "activating" && (
              <button
                className="quiet-button"
                type="button"
                onClick={() => setUpdateDismissed(true)}
              >
                나중에
              </button>
            )}
          </div>
        </section>
      )}
      {showInstall && (
        <section className="pwa-shell-notice" role="status" aria-live="polite" data-kind="install">
          <span className="pwa-shell-notice-icon" aria-hidden="true">
            N
          </span>
          <div>
            <strong>Naru를 앱으로 설치</strong>
            <span>앱 셸만 기기에 저장됩니다. 로그인과 터미널은 Naru 연결이 필요합니다.</span>
          </div>
          <div className="pwa-shell-notice-actions">
            <button className="primary-button compact" type="button" onClick={() => void install()}>
              설치
            </button>
            <button
              className="quiet-button"
              type="button"
              onClick={() => setInstallDismissed(true)}
            >
              닫기
            </button>
          </div>
        </section>
      )}
      {installed && (
        <section
          className="pwa-shell-notice"
          role="status"
          aria-live="polite"
          data-kind="installed"
        >
          <span className="pwa-shell-notice-icon" aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>Naru를 설치했습니다</strong>
            <span>앱 아이콘에서 같은 안전한 작업공간을 열 수 있습니다.</span>
          </div>
          <button className="quiet-button" type="button" onClick={() => setInstalled(false)}>
            닫기
          </button>
        </section>
      )}
    </>
  );
}
