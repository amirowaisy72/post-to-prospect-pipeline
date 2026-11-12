<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules

- All LeadHunter business rules live as pure functions in `src/lib/leadhunter-service.ts`; `src/lib/store.tsx` is the only data layer the UI uses and persists to browser storage. Why: swapping storage for a backend later touches one file.
- The AI Analysis chat UI is built from AI Elements (`src/components/ai-elements/`); its replies come from `src/lib/mock-chat.ts` until a real model call replaces `mockReply`. Why: the design is final while the AI backend is still pending.
- There is no scraping agent in the app: sources are added by hand (name, link, members) and posts will come from the browser extension. The Python `agent/` backend is back for **chat only** — it delivers Inbox chats to Facebook Messenger and watches for replies (see `agent/README.md`); it never scrapes or collects. Why: the scraping agent kept failing live (dead browser, 0 posts), so it was removed from the app entirely, and only the chat half was rebuilt.
- The chat agent owns its own Chrome profile: one profile per account under `agent/profiles/<account>` (see `agent/browser.py`), and it never uses another app's profile — no env var points at one. All Playwright calls run on ONE dedicated browser thread owned by `browser.BROWSER`. First sign-in is the user himself, once, from Agent Control → "Sign in to Facebook". Why: sharing another app's profile locked the browser and hid the session-empty failures; the agent's own profile is the only one it can relaunch and re-check reliably.
- `start.bat` in the repo root is the one-click launcher: it opens the app window (`bun run dev`, port 8080) and the agent window (`run-agent.bat`, port 8001). No env var, no sign-in from the launcher — first sign-in is the user himself, once, from Agent Control → "Sign in to Facebook". The .bat is written with no parenthesised blocks and no parentheses at all (an unmatched `)` in echo text inside an if/else block broke run-agent.bat with ". was unexpected at this time."). Verify it by reading only — there is no cmd.exe on this VM.
