# Changelog

Versions live in `manifest.json`. Bump it in the same commit as the change.

## 3.0.0

Panel redesigned and the fetching rewritten to only cost what the question is worth.

### Added
- **Shorts vs videos.** `Videos | Shorts | Both`, split by YouTube's own tabs rather than by
  duration — a 117-second Short and a 117-second video are indistinguishable by length. On a
  channel with no Shorts the options are disabled rather than removed.
- **Month windows.** The counter takes videos *or* months: `Last 3 months` aggregates
  everything published in that window.
- **All** — every video on the channel, without moving your scroll position.
- **Two channel ages** — how long the channel has existed, and how long it has been
  publishing. A channel can sit dormant for years between the two.
- **Views by month** sparkline, and an accordion that collapses the whole panel.
- The panel now appears on `/shorts` as well as `/videos`, and picks its content type from
  whichever tab you are on.

### Changed
- Stats come from YouTube's player endpoint (~7 KB per video) instead of parsing the watch
  page (~1.7 MB).
- Panel rebuilt as a hairline strip: no cards, five type sizes, three weights, a 4px spacing
  grid. Rank is no longer coloured green/red — that encoded position as if it were sentiment.
- Controls that do not apply are disabled in place, never hidden, so nothing reflows.
- Secondary text raised to meet WCAG AA on the panel surfaces.

### Fixed
- **Videos went transparent and the layout shifted while scrolling.** The panel lives inside
  YouTube's `position: fixed` channel header, which caches how far it may scroll away. Adding
  the panel left that cache stale, pinning a ~360px transparent strip over the grid. The
  header is re-measured on every panel height change.
- **Every view lookup failed.** `credentials: "omit"` is refused outright by YouTube now.
- **The page scrolled itself on load** to force more cards to render.
- **Stale numbers after switching channels.** Runs are generation-tagged and the panel blanks
  on the first navigation signal, so a late reply can never paint over a new channel.
- Channel listing followed the wrong continuation token, replaying one page up to 250 times.

### Performance
- A fresh channel load costs ~10 InnerTube calls instead of ~520 — the unconditional
  whole-channel background scan is gone.
- `Top N` stops after N; a month window stops once it is past the window. Only Popular,
  Oldest and All time still need the whole channel.

## 2.0.0

Initial release: in-page panel, exact view totals across the first N videos respecting the
active sort, and the exact upload date under each card.
