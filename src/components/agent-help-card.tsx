import { Check, ExternalLink, KeyRound, LifeBuoy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";

interface HelpRequest {
    kind: "pin" | "stuck";
    message: string;
    since: string;
}

/** Shows up only when the agent is stuck and needs the user: Messenger
 * PIN, or any unknown blocker. The user answers here (PIN), or opens
 * the agent window, fixes it by hand and presses "I fixed it"
 * — the agent then carries on with the same message. */
export function AgentHelpCard() {
    const { state } = useStore();
    const base = state.settings.agentUrl.replace(/\/+$/, "");
    const accountId = state.activeAccountId;
    const [help, setHelp] = useState<HelpRequest | null>(null);
    const [pin, setPin] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const refresh = async () => {
        try {
            const res = await fetch(`${base}/agent/help`);
            if (!res.ok) return;
            const data = (await res.json()) as { help?: HelpRequest | null } | null;
            setHelp(data?.help ?? null);
        } catch {
            /* agent offline — the page already says so */
        }
    };

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), 4000);
        return () => window.clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [base]);

    const post = async (key: string, path: string, body: Record<string, unknown>) => {
        if (busy) return;
        setBusy(key);
        setNote(null);
        try {
            const res = await fetch(`${base}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = (await res.json().catch(() => null)) as { detail?: string } | null;
            setNote(typeof data?.detail === "string" ? data.detail : null);
            if (res.ok && key === "pin") setPin("");
        } catch {
            setNote("Could not reach the agent — check the run-agent.bat window.");
        } finally {
            setBusy(null);
            void refresh();
        }
    };

    if (!help) return null;
    const isPin = help.kind === "pin";

    return (
        <Card className="mb-6 border-primary/50 bg-accent/60 shadow-card">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    {isPin ? <KeyRound /> : <LifeBuoy />} The agent needs your help
                </CardTitle>
                <CardDescription>{help.message}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {isPin && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            maxLength={8}
                            placeholder="Messenger PIN"
                            value={pin}
                            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                            className="w-44 font-mono"
                        />
                        <Button
                            onClick={() => post("pin", "/agent/help/pin", { pin })}
                            disabled={busy !== null || pin.length < 4}
                        >
                            <KeyRound /> {busy === "pin" ? "Sending…" : "Send PIN"}
                        </Button>
                    </div>
                )}
                {!isPin && (
                    <img
                        src={`${base}/agent/help/screenshot?t=${encodeURIComponent(help.since)}`}
                        alt="This is what the agent sees"
                        className="max-h-64 rounded-lg border"
                    />
                )}
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant="outline"
                        onClick={() => post("open", "/agent/help/open-window", { accountId })}
                        disabled={busy !== null}
                    >
                        <ExternalLink /> {busy === "open" ? "Opening…" : "Open the window — fix it yourself"}
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => post("done", "/agent/help/resolved", { accountId })}
                        disabled={busy !== null}
                    >
                        <Check /> {busy === "done" ? "Continuing…" : "I fixed it — Continue"}
                    </Button>
                </div>
                {note && <p className="text-sm text-muted-foreground">{note}</p>}
            </CardContent>
        </Card>
    );
}