import { useEffect, useState } from "react";

import { useStore } from "@/lib/store";

interface Act {
    state: "idle" | "busy";
    detail: string;
    watching: boolean;
}

export function AgentStatusBadge() {
    const { state } = useStore();
    const base = state.settings.agentUrl.replace(/\/+$/, "");
    const [act, setAct] = useState<Act | null>(null);

    useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const r = await fetch(`${base}/agent/activity`);
                const d = (await r.json()) as Act;
                if (!stop) setAct(d);
            } catch {
                if (!stop) setAct(null);
            }
        };
        void tick();
        const id = window.setInterval(tick, 3000);
        return () => {
            stop = true;
            window.clearInterval(id);
        };
    }, [base]);

    let dot = "bg-red-500";
    let label = "Agent offline";
    if (act) {
        if (act.state === "busy") {
            dot = "bg-amber-500 animate-pulse";
            label = `Agent busy · ${act.detail}`;
        } else if (act.watching) {
            dot = "bg-green-500";
            label = "Agent free · watching";
        } else {
            dot = "bg-muted-foreground";
            label = "Agent free · not watching";
        }
    }
    return (
        <div className="flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
            <span className={`h-2 w-2 rounded-full ${dot}`} />
            <span className="max-w-[220px] truncate">{label}</span>
        </div>
    );
}