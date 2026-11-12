# Raw Data Collector — Chrome extension

Collects Facebook post data (post + comments + replies) as PostData, ready
to import into LeadHunter (Data Sourcing → Add Post Data). The data stays
on your computer — nothing is sent anywhere.

## Load the extension

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. The extension icon appears in the toolbar. If **Start** does nothing,
   reload the Facebook page and try again (a page loaded before the
   install has no content script yet).

## Collect a post

1. Open the Facebook post (or group feed) in Chrome.
2. Click the extension icon → **Start**.
3. Drag a rectangle around the area to capture (or press **Esc** for the
   whole page).
4. **Scroll** while collecting so more comments load (only ~10 load at
   first), and click "View N replies" / "View more comments" yourself
   wherever you want those replies captured — the extension never
   clicks anything on the page, it only captures what is loaded.
5. Click the extension icon → **Stop & download**.

You get up to three files. Import the **`raw_data_<stamp>_structured.json`**
file into LeadHunter: Data Sourcing → **Add Post Data** → upload the file
(or paste its contents). The flat `.txt` file is a readable backup only.

## After an extension update

When the extension files change, go to `chrome://extensions` and click
the **Reload** (↻) button on the Raw Data Collector card, then reload the
Facebook page. Without the reload you keep running the old version.

## Files

- `manifest.json` — extension manifest (Manifest V3).
- `content.js` — runs in the page: rectangle capture, structured scan,
  downloads. It never clicks anything on the page.
- `structured.js` — the Facebook extractor (dialog / feed / fallback).
  Every structured post carries `postUrl` (the post's own permalink)
  so the app can de-duplicate collected posts.
- `popup.html` / `popup.js` — the toolbar popup (Start / Stop / Download).
