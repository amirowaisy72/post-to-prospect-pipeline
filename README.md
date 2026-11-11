# Screenshot To Spark

Implement exactly the screenshot and nothing else

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/3f0f9567-47ae-4adf-8a5e-0db4f7224f3a).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## LeadHunter — start everything with one double-click

Double-click **`start.bat`** in the repo root. It starts the scraping
agent (http://127.0.0.1:8001) in a "LeadHunter Agent" window, the app
(http://localhost:8080) in a "LeadHunter App" window, then opens the
app in your browser. It sets the Chrome profile itself (the
already-signed-in Client Hunting profile, so no Facebook sign-in is
needed) and finds `bun` / `python` on its own when they are not on
PATH. **Close Client Hunting first** — one Chrome profile can only be
used by one browser at a time. See `agent/README.md` for details.
