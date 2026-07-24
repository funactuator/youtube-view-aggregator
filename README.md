# YouTube Channel View Aggregator

Chrome extension. Adds an **in-page panel** on any channel page that aggregates **exact** view counts across the first N videos, and shows the **exact upload date** under each video.

## Features
- **Spacious in-page panel** injected above the video grid (vidIQ-style), theme-aware (dark/light auto).
- **Sort selector** — Latest / Popular / Oldest right in the panel; switches YouTube's tab, then aggregates that set.
- **Configurable N** — aggregate the first N videos (default 10).
- **Total + Average + Top & Lowest** video in roomy metric cells; mono tabular numerals.
- **Readable numbers** — exact number prominent, with `2.9M (29.47 L)` (International M/K + Indian Lakh/Crore) in the sub-line.
- **Exact upload date** injected under each video card as it scrolls into view (📅 Jul 22, 2026).
- **Auto-runs** on load; collapse with the header chevron; toolbar icon toggles the panel.

## Why it fetches watch pages
The videos grid only shows abbreviated views ("252K") and relative dates ("3 months ago"). To get exact numbers and exact dates, the extension fetches each video's watch page (same-origin, no API key needed) and reads `viewCount` + `publishDate`.

## Install (Load unpacked)
1. Chrome → `chrome://extensions`
2. Toggle **Developer mode** (top-right) ON
3. Click **Load unpacked** → select this `youtube-view-aggregator` folder
4. (If updating) click **Reload** 🔄 on the extension card to pick up changes.

## Use
1. Open a channel's **Videos** tab (e.g. `youtube.com/@GardenWhispersUS/videos`).
2. The panel appears top-right. Pick **Latest / Popular / Oldest**, set N, click **Calculate**.
3. Total (both formats) + average + top/lowest show in the panel; each card gets its 📅 exact date.

## Notes
- Fetches stats 4 at a time; larger N = slower. 10–50 is snappy.
- Reads whatever sub-tab is active, so the Oldest/Popular/Latest choice is respected.
- If YouTube changes its DOM, the selectors in `content.js` (`ytd-rich-item-renderer`, `.ytContentMetadataViewModelHost`, `chip-bar-view-model button[role="tab"]`) or the `viewCount`/`publishDate` regexes may need a tweak.
