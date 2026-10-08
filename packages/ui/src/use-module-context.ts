import { useEffect, useState } from "react";
import type { AppManifest, Principal, SessionResponse } from "@open-cloud/contracts";

export interface ModuleContext {
  user: Principal | null;
  apps: AppManifest[];
  loading: boolean;
  sessionError: string | null;
  registryError: string | null;
}

async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error(`Request returned ${response.status}.`);
  return response.json() as Promise<T>;
}

export function useModuleContext(id: string): ModuleContext {
  const [context, setContext] = useState<ModuleContext>({
    user: null,
    apps: [],
    loading: true,
    sessionError: null,
    registryError: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setContext({ user: null, apps: [], loading: true, sessionError: null, registryError: null });
    void Promise.allSettled([
      readJson<SessionResponse>(`/apps/${id}/api/session`, controller.signal),
      readJson<{ apps: AppManifest[] }>("/api/apps", controller.signal),
    ]).then(([session, registry]) => {
      if (controller.signal.aborted) return;
      setContext({
        user: session.status === "fulfilled" ? session.value.user : null,
        apps: registry.status === "fulfilled" ? registry.value.apps : [],
        loading: false,
        sessionError: session.status === "rejected" ? "Your session could not be verified. Refresh the page to sign in again." : null,
        registryError: registry.status === "rejected" ? "The workspace app list is unavailable. Refresh the page to try again." : null,
      });
    });
    return () => controller.abort();
  }, [id]);

  return context;
}
