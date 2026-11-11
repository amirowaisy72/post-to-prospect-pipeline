import { createFileRoute } from "@tanstack/react-router";
import { BrainCircuit, Database, Eye, EyeOff, Filter, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createDefaultSettings, DEFAULT_CRITERIA, DEFAULT_OLLAMA_URL } from "@/lib/seed";
import { useStore } from "@/lib/store";
import type { AiProvider, DatabaseKind, Settings } from "@/lib/types";

const META = "AI model, Gemini key, Ollama server, lead rules, sourcing rules and database connection for LeadHunter.";

export const Route = createFileRoute("/configurations")({
  head: () => ({
    meta: [
      { title: "Configurations — LeadHunter" },
      { name: "description", content: META },
      { property: "og:title", content: "Configurations — LeadHunter" },
      { property: "og:description", content: META },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ConfigurationsPage,
});

function SecretInput({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-10 font-mono text-sm"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        aria-label={show ? "Hide value" : "Show value"}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  min = 0,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  hint?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        step={1}
        value={Number.isNaN(value) ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        className="tabular"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({ icon, title, description, action, children }: { icon: ReactNode; title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="h-fit shadow-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">{icon}</span>
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
        {action}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function ConfigurationsPage() {
  const { state, updateSettings, resetDemoData } = useStore();
  const [form, setForm] = useState<Settings>(state.settings);
  useEffect(() => setForm(state.settings), [state.settings]);

  const dirty = JSON.stringify(form) !== JSON.stringify(state.settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const patch = <K extends "criteria" | "leadRules" | "sourcing" | "database">(k: K, v: Partial<Settings[K]>) =>
    setForm((f) => ({ ...f, [k]: { ...f[k], ...v } }));

  const { preferredMinAge, gentleMinAge } = form.leadRules;
  const agesValid = Number.isInteger(preferredMinAge) && Number.isInteger(gentleMinAge) && gentleMinAge <= preferredMinAge;

  return (
    <>
      <PageHeader
        title="Configurations"
        description="Everything LeadHunter needs to run: AI model, lead rules, sourcing rules and database. Saved in this browser only."
        actions={
          <>
            {dirty && <span className="text-xs font-medium text-warning">Unsaved changes</span>}
            <Button variant="outline" onClick={() => setForm(state.settings)} disabled={!dirty}>
              Discard
            </Button>
            <Button onClick={() => updateSettings(form)} disabled={!dirty}>
              <Save /> Save configurations
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section icon={<BrainCircuit className="size-4" />} title="AI / Model" description="Default provider and model on the AI Analysis page.">
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select value={form.provider} onValueChange={(v) => set("provider", v as AiProvider)}>
              <SelectTrigger aria-label="Provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="gemini">Gemini</SelectItem>
                <SelectItem value="ollama">Ollama (Local)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-model">Model name</Label>
            <Input
              id="cfg-model"
              value={form.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder={form.provider === "ollama" ? "llama3.1:8b" : "gemini-3.8-flash"}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              For example <span className="font-mono">gemini-3.8-flash</span> for Gemini, or <span className="font-mono">llama3.1:8b</span> for Ollama.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-key">Gemini API key</Label>
            <SecretInput id="cfg-key" value={form.geminiApiKey} onChange={(v) => set("geminiApiKey", v)} placeholder="AIza…" />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="cfg-ollama">Ollama server URL</Label>
              {form.ollamaUrl !== DEFAULT_OLLAMA_URL && (
                <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => set("ollamaUrl", DEFAULT_OLLAMA_URL)}>
                  Use default
                </button>
              )}
            </div>
            <Input id="cfg-ollama" value={form.ollamaUrl} onChange={(e) => set("ollamaUrl", e.target.value)} placeholder={DEFAULT_OLLAMA_URL} className="font-mono text-sm" />
          </div>
        </Section>

        <Section
          icon={<ShieldCheck className="size-4" />}
          title="Lead rules"
          description="What the AI looks for when judging comments."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const d = createDefaultSettings();
                setForm((f) => ({ ...f, criteria: { ...DEFAULT_CRITERIA }, leadRules: d.leadRules }));
              }}
            >
              <RotateCcw /> Defaults
            </Button>
          }
        >
          {(
            [
              ["richBeginner", "Rich Beginner definition", "bg-success"],
              ["richExperienced", "Rich Experienced definition", "bg-info"],
              ["reject", "Reject list", "bg-danger"],
            ] as const
          ).map(([key, label, dot]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`crit-${key}`} className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${dot}`} />
                {label}
              </Label>
              <Textarea id={`crit-${key}`} rows={3} value={form.criteria[key]} onChange={(e) => patch("criteria", { [key]: e.target.value })} />
            </div>
          ))}

          <NumberField
            id="cfg-leads"
            label="Default leads count"
            min={1}
            value={form.leadRules.defaultLeadsCount}
            onChange={(n) => patch("leadRules", { defaultLeadsCount: n })}
            hint="How many leads you want from one run."
          />

          <div className="rounded-md border bg-muted/40 p-3">
            <p className="mb-3 text-sm font-semibold text-foreground">Age rule</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField id="cfg-age-pref" label="Full match from age" min={1} value={preferredMinAge} onChange={(n) => patch("leadRules", { preferredMinAge: n })} />
              <NumberField id="cfg-age-gentle" label="Gentle match from age" min={1} value={gentleMinAge} onChange={(n) => patch("leadRules", { gentleMinAge: n })} />
            </div>
            <ul className="mt-3 space-y-1 text-xs">
              {agesValid ? (
                <>
                  <li className="flex items-center gap-2 text-foreground"><span className="size-2 rounded-full bg-success" /> {preferredMinAge}+ : lead</li>
                  {gentleMinAge < preferredMinAge && (
                    <li className="flex items-center gap-2 text-foreground">
                      <span className="size-2 rounded-full bg-warning" /> {gentleMinAge}–{preferredMinAge - 1} : approach gently
                    </li>
                  )}
                  <li className="flex items-center gap-2 text-foreground"><span className="size-2 rounded-full bg-danger" /> Under {gentleMinAge} : reject</li>
                </>
              ) : (
                <li className="text-danger">The gentle age must be lower than or equal to the full-match age.</li>
              )}
            </ul>
          </div>
        </Section>

        <Section icon={<Filter className="size-4" />} title="Sourcing rules" description="A group or page must meet these before an account joins it.">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField id="cfg-min-comments" label="Min comments" value={form.sourcing.minComments} onChange={(n) => patch("sourcing", { minComments: n })} hint="Per post, before joining." />
            <NumberField id="cfg-min-members" label="Min members" value={form.sourcing.minMembers} onChange={(n) => patch("sourcing", { minMembers: n })} hint="Group or page size." />
          </div>
        </Section>

        <Section icon={<Database className="size-4" />} title="Database" description="Central database for the backend phase. Not connected yet.">
          <div className="space-y-1.5">
            <Label>Connection type</Label>
            <Select value={form.database.kind} onValueChange={(v) => patch("database", { kind: v as DatabaseKind })}>
              <SelectTrigger aria-label="Connection type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="supabase">Supabase URL + key</SelectItem>
                <SelectItem value="connection-string">Database connection string</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.database.kind === "supabase" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="cfg-sb-url">Supabase URL</Label>
                <Input id="cfg-sb-url" value={form.database.supabaseUrl} onChange={(e) => patch("database", { supabaseUrl: e.target.value })} placeholder="https://xyzcompany.supabase.co" className="font-mono text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cfg-sb-key">Supabase key</Label>
                <SecretInput id="cfg-sb-key" value={form.database.supabaseKey} onChange={(v) => patch("database", { supabaseKey: v })} placeholder="eyJhbGciOi… or sb_publishable_…" />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="cfg-db-url">Connection string</Label>
              <SecretInput id="cfg-db-url" value={form.database.connectionString} onChange={(v) => patch("database", { connectionString: v })} placeholder="postgresql://user:password@host:5432/db" />
            </div>
          )}
          <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-foreground">
            Keys here are kept in this browser only. Use the public (anon / publishable) key — never a service role key or admin password.
          </p>
        </Section>
      </div>

      <Card className="mt-6 border-dashed shadow-card">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">Restore demo data</p>
            <p className="text-sm text-muted-foreground">Replaces all accounts, sources, posts, leads and configurations with the original sample data.</p>
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
