# Changelog

Versions live in `manifest.json`. Bump it in the same commit as the change.

## 3.2.0

### Performance
- **Popular and Oldest are ~3x faster.** They used to fetch every video on the channel just
  to sort them. The listing already carries an approximate "4.1M views · 10 days ago" per
  item — too coarse to report, but exact enough to rank — so ranking happens there and precise
  numbers are fetched only for the shortlist. On a 445-video channel that is 20 lookups
  instead of 445: 16s down to ~5.5s, with the same answer.

## 3.1.2

### Fixed
- **Popular and Oldest did nothing on some channels.** They were reached by clicking
  YouTube's own sort control, which some channels render as a dropdown rather than chips —
  there the click found nothing and the order never changed. Both orders are now computed
  from the views and dates we already hold, so YouTube's sort UI is never touched.
- **"Couldn't list this channel's videos" was shown for an empty month window.** Nothing was
  broken — the channel simply had not published in that window. It now says so.

## 3.1.1

### Changed
- In a month window, "Per month" only restated the total, so that column now shows the
  **number of videos** published in the window instead — the thing that was actually missing.
- The monthly sparkline is dropped when the range covers a single month; one bar is not a
  shape. The metric row falls back to three columns.

### Fixed
- A failed listing no longer leaves the previous run's figures sitting under a
  "Couldn't list this channel's videos" message.

## 3.1.0

### Changed
- **The three scopes are now tabs.** Top N, Last N months and All time are three different
  questions, and having all their controls share one row meant half of them were always
  irrelevant. Each mode is a tab that shows only its own controls — so "Last N months" has no
  sort control at all rather than a disabled one, and All time has no number box. Top N is the
  default. The tab row is a fixed height, so switching modes still cannot resize the panel.
- Removed the disabled-in-place control handling, which existed only to stop the shared
  control row from reflowing.

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
