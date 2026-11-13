import { Loader2, RefreshCw, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { aiModels, aiTest } from "@/lib/chat-client";

interface Props {
    provider: string;
    model: string;
    geminiKey: string;
    ollamaUrl: string;
    agentUrl: string;
    onChange: (m: string) => void;
}

export function ModelPicker(p: Props) {
    const [models, setModels] = useState<string[]>([]);
    const [busy, setBusy] = useState<"" | "list" | "test">("");
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
    const body = { provider: p.provider, geminiKey: p.geminiKey.trim(), ollamaUrl: p.ollamaUrl.trim() };

    const load = async () => {
        setBusy("list");
        setMsg(null);
        const r = await aiModels(p.agentUrl, body);
        setBusy("");
        if (!r.ok) return setMsg({ ok: false, text: r.error });
        setModels(r.value.models);
        if (r.value.models.length === 0) setMsg({ ok: false, text: "Koi model nahi mila." });
    };

    const test = async () => {
        setBusy("test");
        setMsg(null);
        const r = await aiTest(p.agentUrl, { ...body, model: p.model });
        setBusy("");
        setMsg(
            r.ok
                ? { ok: true, text: `Chal raha hai ✓ (${r.value.seconds}s) — jawab: ${r.value.reply}` }
                : { ok: false, text: r.error },
        );
    };

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [p.provider]);

    const options = !p.model || models.includes(p.model) ? models : [p.model, ...models];

    return (
        <div className="space-y-2">
            <div className="text-sm font-medium">Model (list se chunein)</div>
            <div className="flex gap-2">
                <Select value={p.model} onValueChange={p.onChange}>
                    <SelectTrigger aria-label="Model" className="font-mono text-sm">
                        <SelectValue placeholder="Model chunein…" />
                    </SelectTrigger>
                    <SelectContent>
                        {options.map((m) => (
                            <SelectItem key={m} value={m} className="font-mono text-sm">{m}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button type="button" variant="outline" onClick={load} disabled={busy !== ""}>
                    {busy === "list" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
                </Button>
                <Button type="button" variant="outline" onClick={test} disabled={busy !== "" || !p.model}>
                    {busy === "test" ? <Loader2 className="animate-spin" /> : <Zap />} Test
                </Button>
            </div>
            {msg && (
                <p className={msg.ok ? "text-xs text-emerald-500" : "text-xs text-destructive"}>{msg.text}</p>
            )}
        </div>
    );
}