import { PUBLIC_PWA_BUILD_FIXTURE_ORIGIN } from "./public-build-config";
import {
  currentAppBasePath,
  currentAppPath,
  currentAppScopePath,
  readConfiguredAppBasePath,
} from "./app-base-path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CANONICAL_ORIGIN_META_SELECTOR = 'meta[name="naru-canonical-origin"]';
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

export interface CanonicalOriginMetaSource {
  querySelectorAll(
    selector: string,
  ): ArrayLike<{ readonly getAttribute: (name: string) => string | null }>;
}

export interface PwaUpdateWatcher {
  dispose(): void;
}

export function readConfiguredPwaOrigin(source: CanonicalOriginMetaSource): string | null {
  const matches = source.querySelectorAll(CANONICAL_ORIGIN_META_SELECTOR);
  if (matches.length !== 1) return null;
  return canonicalConfiguredOrigin(matches[0]?.getAttribute("content") ?? null);
}

export function isApprovedPwaRuntimeOrigin(origin: string, configuredOrigin: string): boolean {
  const configured = canonicalConfiguredOrigin(configuredOrigin);
  if (configured === null) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.origin === configured) return true;
  return (
    configured === PUBLIC_PWA_BUILD_FIXTURE_ORIGIN &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    (url.protocol === "http:" || url.protocol === "https:")
  );
}

export function isPwaOriginConsistent(input: {
  readonly runtimeOrigin: string;
  readonly configuredOrigin: string;
  readonly gatewayOrigin?: string;
}): boolean {
  const configured = canonicalConfiguredOrigin(input.configuredOrigin);
  if (configured === null) return false;
  if (input.gatewayOrigin !== undefined) {
    return input.gatewayOrigin === configured && input.runtimeOrigin === configured;
  }
  return isApprovedPwaRuntimeOrigin(input.runtimeOrigin, configured);
}

export function isCurrentPwaOriginConsistent(gatewayOrigin: string): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  const configuredOrigin = readConfiguredPwaOrigin(document);
  return (
    configuredOrigin !== null &&
    isPwaOriginConsistent({
      runtimeOrigin: window.location.origin,
      configuredOrigin,
      gatewayOrigin,
    })
  );
}

export function shouldRegisterPwa(input: {
  readonly origin: string;
  readonly configuredOrigin: string | null;
  readonly production: boolean;
  readonly secureContext: boolean;
  readonly serviceWorkerSupported: boolean;
}): boolean {
  return (
    input.production &&
    input.secureContext &&
    input.serviceWorkerSupported &&
    input.configuredOrigin !== null &&
    isApprovedPwaRuntimeOrigin(input.origin, input.configuredOrigin)
  );
}

export function isStandalonePwa(): boolean {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    standaloneNavigator.standalone === true
  );
}

export function getPwaServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  const configuredOrigin = readConfiguredPwaOrigin(document);
  const configuredBasePath = readConfiguredAppBasePath(document);
  if (
    !shouldRegisterPwa({
      origin: window.location.origin,
      configuredOrigin,
      production: import.meta.env.MODE === "production",
      secureContext: window.isSecureContext,
      serviceWorkerSupported: "serviceWorker" in navigator,
    }) ||
    configuredBasePath === null ||
    configuredBasePath !== currentAppBasePath()
  ) {
    return Promise.resolve(null);
  }

  registrationPromise ??= navigator.serviceWorker
    .register(currentAppPath("/sw.js"), {
      scope: currentAppScopePath(),
      updateViaCache: "none",
    })
    .then((registration) => {
      void registration.update().catch(() => undefined);
      return registration;
    })
    .catch(() => {
      registrationPromise = null;
      return null;
    });
  return registrationPromise;
}

function canonicalConfiguredOrigin(value: string | null): string | null {
  if (value === null || value.trim() !== value || value.length === 0 || value.length > 2_048) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === "localhost" ||
    url.hostname.startsWith("[") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) ||
    url.hostname.endsWith(".")
  ) {
    return null;
  }
  return url.origin;
}

export function watchPwaUpdates(
  registration: ServiceWorkerRegistration,
  onUpdateReady: () => void,
  onUpdatedController: () => void,
): PwaUpdateWatcher {
  const workerListeners = new Map<ServiceWorker, () => void>();
  let hadController = navigator.serviceWorker.controller !== null;

  const inspectWorker = (worker: ServiceWorker | null): void => {
    if (!worker || workerListeners.has(worker)) return;
    const stateChanged = (): void => {
      if (worker.state === "installed" && navigator.serviceWorker.controller !== null) {
        onUpdateReady();
      }
    };
    worker.addEventListener("statechange", stateChanged);
    workerListeners.set(worker, () => worker.removeEventListener("statechange", stateChanged));
    stateChanged();
  };
  const updateFound = (): void => inspectWorker(registration.installing);
  const controllerChanged = (): void => {
    if (hadController) onUpdatedController();
    hadController = true;
  };

  if (registration.waiting && navigator.serviceWorker.controller !== null) onUpdateReady();
  inspectWorker(registration.installing);
  registration.addEventListener("updatefound", updateFound);
  navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);

  return {
    dispose() {
      registration.removeEventListener("updatefound", updateFound);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
      for (const remove of workerListeners.values()) remove();
      workerListeners.clear();
    },
  };
}

export function activateWaitingPwa(registration: ServiceWorkerRegistration): boolean {
  if (!registration.waiting) return false;
  registration.waiting.postMessage({ type: "SKIP_WAITING" });
  return true;
}
