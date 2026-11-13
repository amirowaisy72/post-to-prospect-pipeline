import { useEffect, useState } from "react";

import { useStore } from "@/lib/store";

interface S {
    threadId: string;
    name: string;
    dueAt: string;
}

export function AgentSchedulesCard() {
    const { state } = useStore();
    const base = state.settings.agentUrl.replace(/\/+$/, "");
    const [items, setItems] = useState<S[]>([]);

    useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const r = await fetch(`${base}/agent/schedules`);
                const d = await r.json();
                if (!stop) setItems(Array.isArray(d.schedules) ? d.schedules : []);
            } catch {
                if (!stop) setItems([]);
            }
        };
        void tick();
        const id = window.setInterval(tick, 15000);
        return () => {
            stop = true;
            window.clearInterval(id);
        };
    }, [base]);

    if (items.length === 0) return null;
    return (
        <div className="mb-4 flex flex-wrap gap-2">
            {items.map((s) => (
                <span
                    key={s.threadId}
                    className="rounded-full border border-primary/40 bg-card px-3 py-1 text-xs font-medium"
                >
                    🕒 {s.name}: {new Date(s.dueAt.replace(" ", "T")).toLocaleString()} ko follow-up
                </span>
            ))}
        </div>
    );
}