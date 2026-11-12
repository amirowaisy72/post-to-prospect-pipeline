// Empty initial state — the app starts with NO demo data at all.
// Real work only: the user creates an account, then adds sources by
// hand (name, Facebook link, member count). Built by a function (not
// module-scope values) so nothing runs at import time.
import type { AppState, Settings } from "./types";

export const DEFAULT_CRITERIA = {
  richBeginner:
    "Rich Beginner = new to investing (never invested, asking where to start) AND shows wealth (business owner, property, large savings, sold an asset).",
  richExperienced:
    "Rich Experienced = already investing (portfolio, years in the market, mutual funds, property units) AND shows wealth.",
  reject:
    "Reject = tip sellers, Telegram / WhatsApp promoters, group or course sellers, and spam profiles.",
};

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/** Factory defaults for the Configurations page. */
export function createDefaultSettings(): Settings {
  return {
    provider: "ollama",
    model: "llama3.1:8b",
    ollamaUrl: DEFAULT_OLLAMA_URL,
    geminiApiKey: "",
    criteria: { ...DEFAULT_CRITERIA },
    leadRules: { defaultLeadsCount: 5, preferredMinAge: 35, gentleMinAge: 32 },
    sourcing: { minComments: 3, minMembers: 100 },
    database: { kind: "supabase", supabaseUrl: "", supabaseKey: "", connectionString: "" },
  };
}

/** The app starts empty: no accounts, no sources, no posts, no leads,
 * no activity. The first account the user creates becomes the active
 * and default account (see createAccount in leadhunter-service.ts). */
export function createSeedState(): AppState {
  return {
    activeAccountId: "",
    defaultAccountId: "",
    accounts: [],
    sources: [],
    posts: [],
    leads: [],
    activity: [],
    settings: createDefaultSettings(),
  };
}
