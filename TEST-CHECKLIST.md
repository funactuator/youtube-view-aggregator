# Functional checklist

Every one of these must still hold before any change ships. A change that breaks an item
below is not done, however good the thing it adds — the item either gets fixed or the change
gets dropped. **When a feature is added, add its cases here in the same commit.**

How to run it: load the extension for real (see `## Harness` at the bottom) — never by
injecting `content.js` into a page, which runs in the wrong world and hides content-script
bugs.

Legend: **[core]** = the extension is broken without it, verify on every single change.

---

## 1. Injection and lifecycle

- [ ] **[core]** Panel appears on `youtube.com/@handle/videos`.
- [ ] **[core]** Panel appears on `youtube.com/@handle/shorts`.
- [ ] Panel does **not** appear on Home / Playlists / Posts / a watch page / the YouTube homepage.
- [ ] Panel sits in the channel header, above the tab bar, at the width of the video column.
- [ ] Panel survives an SPA navigation between tabs of the same channel (no duplicates, no loss).
- [ ] Toolbar icon toggles the panel when it is absent / collapses it when present.
- [ ] Reloading the page restores the panel in the same state.

## 2. Scroll and page integrity — the regression that started it all

- [ ] **[core]** Scrolling the channel page does not make video thumbnails go transparent.
- [ ] **[core]** With the panel present, scroll to y=900: `tp-yt-app-header`'s bounding
      bottom is ~104px — the same value as with the panel removed. A larger number means a
      stale sticky strip is covering the grid.
- [ ] The page never scrolls by itself on load.
- [ ] Collapsing/expanding the panel re-measures the header (repeat the y=900 check collapsed).
- [ ] The video grid is not pushed down or overlapped at any scroll position.

## 3. Content type

- [ ] **[core]** `Videos` totals only long-form; `Shorts` only shorts; `Both` is their sum.
- [ ] Landing on `/videos` preselects Videos; landing on `/shorts` preselects Shorts.
- [ ] Once the user picks a type manually, navigating within the channel does not override it.
- [ ] Changing channel resets the type to whatever the new channel's tab implies.
- [ ] On a channel with **no Shorts tab**, Shorts and Both are disabled with an explanation,
      and the selection falls back to Videos. (Check: `@Cloud-Codes`.)
- [ ] Videos + Shorts counts reconcile with the channel's advertised video count.
      (Check: Veritasium 445 + 77 = 522.)

## 4. Modes

- [ ] **[core]** Three tabs: `Top N`, `Last N months`, `All time`. `Top N` is the default.
- [ ] Each tab shows only its own controls — `Last N months` has no sort control at all,
      `All time` has no number box.
- [ ] Switching tabs sets the number: `Top N` → 10, `Last N months` → 1.
- [ ] **[core]** The control row's width and height are identical in all three tabs.
- [ ] Arrow keys move between tabs; `aria-selected` follows.
- [ ] The mode, content type and number survive a reload.

## 5. Sort

- [ ] **[core]** `Latest`, `Popular`, `Oldest` each produce a different, correct set.
- [ ] **[core]** Clicking a sort in the panel also switches YouTube's own sort on the page
      (chip flips to `aria-selected="true"`).
- [ ] Sorting still produces correct numbers on channels where YouTube renders sort as a
      **dropdown** rather than chips. (Check: `@SamayRainaOfficial`.)
- [ ] `Popular`'s top video matches the highest-viewed video of an `All time` run.
- [ ] `Oldest`'s set is genuinely the channel's earliest uploads.

## 6. Numbers

- [ ] **[core]** Total is the exact sum; Average = total ÷ count; both shown rounded with the
      exact figure beneath.
- [ ] Indian reading (L / Cr) appears alongside the international one above 1 lakh.
- [ ] `Top N` returns exactly N items when the channel has that many.
- [ ] A month window contains only videos published inside it.
- [ ] The third column is `Per month` in `Top N` / `All time`, and the **video count** in a
      month window.
- [ ] The sparkline is hidden when the range spans a single month; the row falls back to 3
      columns.
- [ ] Highest / Lowest name real videos and link to them.
- [ ] Channel age and "publishing for" are distinct dates, and marked `≥` when YouTube
      returned only part of the channel.

## 7. Dates on the video cards

- [ ] **[core]** Scrolling the channel page injects `📅 <exact date>` under each card.
- [ ] **[core]** Running a calculation dates the cards it counted — **including** Popular and
      Oldest runs, not only Latest.
- [ ] Dates match the video's real publish date.
- [ ] Dates are not duplicated when a card is re-observed.

## 8. Channel change

- [ ] **[core]** Switching channel never shows the previous channel's figures — sample within
      ~150ms of navigation; it must be blank or "Loading".
- [ ] The new channel's numbers arrive without needing a manual Calculate.
- [ ] Switching twice quickly ends on the *last* channel's data, not a stale reply.
- [ ] Channel age / publishing-for update to the new channel.

## 9. Accordion

- [ ] Collapse hides the whole body, leaving the header bar; expand restores it.
- [ ] `aria-expanded` tracks the state; focus stays on the button.
- [ ] The state survives a reload, with no expand-then-collapse flash.
- [ ] Collapsed body is not reachable by keyboard.
- [ ] `prefers-reduced-motion` drops the animation.

## 10. Empty, partial and failure states

- [ ] A month window with nothing in it says **"Nothing published in the last N months"** —
      not a listing error.
- [ ] A genuine listing failure clears the previous numbers; a failure message never sits
      above stale figures.
- [ ] Videos whose stats cannot be read are reported as "N skipped", not silently dropped.
- [ ] A channel with a handful of videos works (no assumptions about page counts).

## 11. Performance budgets

- [ ] **[core]** A fresh channel load costs **single-digit** POSTs to `/youtubei/v1/` — not
      hundreds. Nothing scans the whole channel unasked.
- [ ] `Top N` + `Latest` answers in well under a second (reads the rendered grid).
- [ ] `Top N` + `Popular` / `Oldest` fetch roughly N videos, not the whole channel.
- [ ] A month window stops once it is past the window.
- [ ] Re-running the same query is near-instant off the cache.

## 12. Presentation

- [ ] Dark and light themes both correct; switching YouTube's theme updates the panel live.
- [ ] Long video titles ellipsise; they never stretch a column.
- [ ] All metric columns share a baseline.
- [ ] Nothing reflows while a calculation runs — previous figures stay readable, with the
      spinner and progress line carrying the busy state.
- [ ] No console errors originating from the extension.

---

## Harness

Google Chrome blocks `--load-extension`. Playwright's bundled Chrome for Testing does not:

```bash
BIN="$HOME/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
UDD=$(mktemp -d)
"$BIN" --user-data-dir="$UDD" --remote-debugging-port=9222 \
  --load-extension="$PWD" --disable-extensions-except="$PWD" \
  --no-first-run --no-default-browser-check "https://www.youtube.com/@veritasium/videos" &
```

Confirm it actually loaded: `http://127.0.0.1:9222/json/list` must list a `service_worker` at
`chrome-extension://<id>/background.js`. The profile is logged out, so some player lookups
come back "Sign in to confirm you're not a bot" — that is an environment limit, not a failure.

Channels worth keeping in rotation: `@veritasium` (large, has Shorts), `@Cloud-Codes` (no
Shorts), `@SamayRainaOfficial` (sort as dropdown, sparse Shorts), `@GardenWhispersUS` (small).
