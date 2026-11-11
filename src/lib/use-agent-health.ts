import { useCallback, useEffect, useState } from "react";

import { getAgentHealth } from "./agent-client";
import { useStore } from "./store";

/** Live "is the local agent reachable" flag for Scrap/Sync buttons. null = not checked yet. */
export function useAgentHealth() {
  const { state } = useStore();
  const agentUrl = state.settings.agentUrl;
  const [reachable, setReachable] = useState<boolean | null>(null);
  const check = useCallback(async () => {
    try {
      const health = await getAgentHealth(agentUrl);
      setReachable(health.ok === true);
    } catch {
      setReachable(false);
    }
  }, [agentUrl]);
  useEffect(() => {
    setReachable(null);
    void check();
  }, [check]);
  return { reachable, refresh: check };
}
