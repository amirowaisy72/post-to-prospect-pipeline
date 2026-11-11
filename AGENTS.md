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
- Each account has one agent (`AppState.agents`, rules in `leadhunter-service.ts`: one task at a time, offline when the account is not active). Demo tasks finish on their own via `expectedMs` in the store ticker until a real agent API pushes status. Why: the status UI stays the same when the real agent is connected.
