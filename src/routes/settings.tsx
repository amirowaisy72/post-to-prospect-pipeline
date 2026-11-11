import { createFileRoute } from "@tanstack/react-router";
import { Eye, EyeOff, RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_CRITERIA } from "@/lib/seed";
import { useStore } from "@/lib/store";
import type { AiProvider, Settings } from "@/lib/types";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — LeadHunter" },
      { name: "description", content: "AI provider, model and lead criteria settings for LeadHunter." },
      { property: "og:title", content: "Settings — LeadHunter" },
      { property: "og:description", content: "AI provider, model and lead criteria settings for LeadHunter." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { state, updateSettings, resetDemoData } = useStore();
  const [form, setForm] = useState<Settings>(state.settings);
  const [showKey, setShowKey] = useState(false);
  useEffect(() => setForm(state.settings), [state.settings]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setCriteria = (k: keyof Settings["criteria"], v: string) =>
    setForm((f) => ({ ...f, criteria: { ...f.criteria, [k]: v } }));

  return (
    <>
      <PageHeader
        title="Settings"
        description="Stored in this browser only."
        actions={
          <Button onClick={() => updateSettings(form)}>
            <Save /> Save settings
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="h-fit shadow-card">
          <CardHeader>
            <CardTitle className="text-base">AI provider</CardTitle>
            <CardDescription>Used as the default on the AI Analysis page.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={form.provider} onValueChange={(v) => set("provider", v as AiProvider)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama">Ollama (Local)</SelectItem>
                  <SelectItem value="gemini">Gemini</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-model">Model name</Label>
              <Input
                id="set-model"
                value={form.model}
                onChange={(e) => set("model", e.target.value)}
                placeholder={form.provider === "ollama" ? "llama3.1:8b" : "gemini-2.5-flash"}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-key">Gemini API key</Label>
              <div className="relative">
                <Input
                  id="set-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  value={form.geminiApiKey}
                  onChange={(e) => set("geminiApiKey", e.target.value)}
                  placeholder="AIza…"
                  className="pr-10 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Saved locally on this device only. Never sent anywhere yet.</p>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-card">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Lead criteria</CardTitle>
              <CardDescription>Instructions the AI follows when judging comments.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => set("criteria", { ...DEFAULT_CRITERIA })}>
              <RotateCcw /> Defaults
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {(
              [
                ["richBeginner", "Rich Beginner", "success"],
                ["richExperienced", "Rich Experienced", "info"],
                ["reject", "Reject", "danger"],
              ] as const
            ).map(([key, label, tone]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`crit-${key}`} className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${tone === "success" ? "bg-success" : tone === "info" ? "bg-info" : "bg-danger"}`} />
                  {label}
                </Label>
                <Textarea id={`crit-${key}`} rows={3} value={form.criteria[key]} onChange={(e) => setCriteria(key, e.target.value)} />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6 border-dashed shadow-card">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">Restore demo data</p>
            <p className="text-sm text-muted-foreground">Replaces all accounts, sources, posts and leads with the original sample data.</p>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              if (window.confirm("Replace everything with the demo data?")) resetDemoData();
            }}
          >
            Restore demo data
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
