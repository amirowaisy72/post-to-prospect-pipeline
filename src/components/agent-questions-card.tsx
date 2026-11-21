import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useStore } from "@/lib/store";

interface Q {
    threadId: string;
    name: string;
    messages: string[];
    question: string;
}

export function AgentQuestionsCard() {
    const { state } = useStore();
    const base = state.settings.agentUrl.replace(/\/+$/, "");
    const [qs, setQs] = useState<Q[]>([]);
    const [text, setText] = useState<Record<string, string>>({});

    useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const r = await fetch(`${base}/agent/questions`);
                const d = await r.json();
                if (!stop) setQs(Array.isArray(d.questions) ? d.questions : []);
            } catch {
                if (!stop) setQs([]);
            }
        };
        void tick();
        const id = window.setInterval(tick, 4000);
        return () => {
            stop = true;
            window.clearInterval(id);
        };
    }, [base]);

    const send = async (q: Q) => {
        const answer = (text[q.threadId] ?? "").trim();
        if (!answer) return;
        try {
            await fetch(`${base}/agent/questions/answer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ threadId: q.threadId, answer }),
            });
        } catch {
            return;
        }
        setQs((prev) => prev.filter((x) => x.threadId !== q.threadId));
    };

    if (qs.length === 0) return null;
    return (
        <div className="mb-4 space-y-3">
            {qs.map((q) => (
                <div key={q.threadId} className="rounded-xl border border-primary/40 bg-card p-4">
                    <div className="text-sm font-semibold">The agent needs your help: {q.name}</div>
                    <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                        {q.messages.map((m, i) => (
                            <div key={i}>“{m}”</div>
                        ))}
                    </div>
                    <div className="mt-2 text-sm">{q.question}</div>
                    <Textarea
                        className="mt-2"
                        placeholder="Your answer (the AI will send it in a natural tone)…"
                        value={text[q.threadId] ?? ""}
                        onChange={(e) => setText((t) => ({ ...t, [q.threadId]: e.target.value }))}
                    />
                    <Button className="mt-2" onClick={() => send(q)}>
                        Send answer
                    </Button>
                </div>
            ))}
        </div>
    );
}