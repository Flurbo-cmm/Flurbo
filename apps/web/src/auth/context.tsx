import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AuthController } from "./controller";
import { authPolicy } from "./policy";
import { serverSession } from './server-session';

const AuthContext = createContext<AuthController | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Private browsing may deny storage. */ }
    return new AuthController({
      policy: authPolicy(window.location.href, import.meta.env.DEV, window.isSecureContext,
        !!window.PublicKeyCredential && !!navigator.credentials?.create && !!navigator.credentials?.get), storage, transport: serverSession,
    });
  });
  useEffect(() => {
    void controller.restore();
    const pageHide = () => controller.lockSigning();
    const focus = () => { controller.checkExpiry(); void controller.restore(); };
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", controller.checkExpiry);
    return () => {
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", controller.checkExpiry);
      controller.lockSigning();
    };
  }, [controller]);
  return <AuthContext.Provider value={controller}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const controller = useContext(AuthContext);
  if (!controller) throw new Error("AuthProvider is missing");
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, state, policy: controller.policy };
}
