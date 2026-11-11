import { describe, expect, it } from "vitest";

import { ageVerdict, meetsSourcingRules, mergeSettings, validateSettings } from "@/lib/leadhunter-service";
import { createDefaultSettings } from "@/lib/seed";

describe("configuration defaults", () => {
  it("uses the agreed defaults", () => {
    const d = createDefaultSettings();
    expect(d.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(d.leadRules.defaultLeadsCount).toBe(5);
    expect(d.sourcing.minComments).toBe(3);
    expect(d.sourcing.minMembers).toBe(100);
  });

  it("fills new fields when older saved settings lack them", () => {
    const merged = mergeSettings(createDefaultSettings(), { provider: "gemini", model: "gemini-3.8-flash", geminiApiKey: "k" });
    expect(merged.provider).toBe("gemini");
    expect(merged.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(merged.sourcing.minMembers).toBe(100);
  });
});

describe("age rule", () => {
  const rules = createDefaultSettings().leadRules;
  it("35+ is a lead", () => expect(ageVerdict(35, rules)).toBe("match"));
  it("32–34 is approached gently", () => {
    expect(ageVerdict(32, rules)).toBe("gentle");
    expect(ageVerdict(34, rules)).toBe("gentle");
  });
  it("under 32 is rejected", () => expect(ageVerdict(31, rules)).toBe("reject"));
});

describe("sourcing rules", () => {
  const rules = createDefaultSettings().sourcing;
  it("needs at least 3 comments and 100 members", () => {
    expect(meetsSourcingRules({ comments: 3, members: 100 }, rules)).toBe(true);
    expect(meetsSourcingRules({ comments: 2, members: 500 }, rules)).toBe(false);
    expect(meetsSourcingRules({ comments: 10, members: 99 }, rules)).toBe(false);
  });
});

describe("validateSettings", () => {
  it("accepts the defaults", () => expect(validateSettings(createDefaultSettings()).ok).toBe(true));
  it("rejects a leads count below 1", () => {
    const s = createDefaultSettings();
    expect(validateSettings({ ...s, leadRules: { ...s.leadRules, defaultLeadsCount: 0 } }).ok).toBe(false);
  });
  it("rejects a gentle age above the full-match age", () => {
    const s = createDefaultSettings();
    expect(validateSettings({ ...s, leadRules: { ...s.leadRules, gentleMinAge: 36 } }).ok).toBe(false);
  });
  it("rejects an Ollama URL without http", () => {
    expect(validateSettings({ ...createDefaultSettings(), ollamaUrl: "127.0.0.1:11434" }).ok).toBe(false);
  });
});
