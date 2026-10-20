---
name: Flurbo
description: Ledger, a quiet printed-markets interface for trading single and linked questions on Monad testnet.
colors:
  paper: "#f5f4ec"
  paper-raised: "#fbfaf5"
  paper-sunken: "#ecebe2"
  forest-ink: "#14271d"
  forest-ink-soft: "#24382c"
  ink-secondary: "#45524a"
  ink-tertiary: "#5f6a63"
  ink-disabled: "#8c958e"
  ivory-on-ink: "#f5f4ec"
  ivory-on-ink-muted: "#babfb6"
  control-stroke: "#7f8981"
  highlighter-lime: "#d9f76d"
  highlighter-lime-soft: "#eef8c9"
  price-up: "#2f6b3c"
  danger-brick: "#9a3324"
  danger-brick-soft: "#f6e3de"
typography:
  display:
    fontFamily: "Geist Pixel, Plex Mono Fallback, ui-monospace, monospace"
    fontSize: "clamp(40px, 4.3vw, 62px)"
    fontWeight: 400
    lineHeight: 1.04
    letterSpacing: "0"
  headline:
    fontFamily: "Geist Pixel, Plex Mono Fallback, ui-monospace, monospace"
    fontSize: "clamp(30px, 3.4vw, 44px)"
    fontWeight: 400
    lineHeight: 1.05
  title:
    fontFamily: "Space Grotesk, Space Grotesk Fallback, system-ui, sans-serif"
    fontSize: "clamp(24px, 2.6vw, 32px)"
    fontWeight: 500
    lineHeight: 1.12
  subtitle:
    fontFamily: "Space Grotesk, Space Grotesk Fallback, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Space Grotesk, Space Grotesk Fallback, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "Space Grotesk, Space Grotesk Fallback, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "IBM Plex Mono, Plex Mono Fallback, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.06em"
  figure:
    fontFamily: "IBM Plex Mono, Plex Mono Fallback, ui-monospace, monospace"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1
    fontFeature: "tnum"
  figure-large:
    fontFamily: "IBM Plex Mono, Plex Mono Fallback, ui-monospace, monospace"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.05
    fontFeature: "tnum"
rounded:
  tag: "2px"
  control: "4px"
  tile: "4px"
  panel: "8px"
  sheet: "8px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s8: "32px"
  s10: "40px"
  s12: "48px"
  s16: "64px"
  s20: "80px"
components:
  button-primary:
    backgroundColor: "{colors.forest-ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "0 18px"
  button-primary-hover:
    backgroundColor: "{colors.forest-ink-soft}"
    textColor: "{colors.paper}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.control}"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.paper-sunken}"
  status-tag:
    backgroundColor: "transparent"
    textColor: "{colors.forest-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
    padding: "1px 5px"
  status-tag-open:
    backgroundColor: "{colors.highlighter-lime}"
    textColor: "{colors.forest-ink}"
  selection-block:
    backgroundColor: "{colors.forest-ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
  market-tile:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.tile}"
    height: "124px"
  transaction-sheet:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.sheet}"
    width: "520px"
  text-input:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.control}"
    height: "44px"
---

# Design System: Flurbo

## Overview

**Creative North Star: "Ledger"**

A quiet printed-markets page: ivory paper, forest ink and one lime highlighter. Prices read like a stock table in a newspaper, in monospace tabular figures that never shift as they update. Groups are separated by hairline rules rather than boxes; only things a member acts on (tiles, the ticket, sheets) are framed. Corners stay nearly square. The product is an information market, so the page stays calm and exact: no celebration, no urgency, no gaming language, and every number is shown with its unit or its exact value one hover away.

The one loud moment is typographic. Headlines on the landing page and page titles are set in a pixel display face, which reads as printed type at a distance and as the market's own instrument up close. The landing hero carries a halftone of the logo's contour rings behind the example market; the loader uses the same tone on its panels. Everywhere else the paper carries only a faint static grain.

Motion answers the member's actions: a sheet entering, a tab or option block sliding, a price digit rolling with a single lime flash. Nothing loops for attention, and every motion stops under reduced motion.

**Key Characteristics:**
- Ivory paper, forest ink, one lime highlighter; up and down colors only on price changes, always with a sign and an arrow.
- Monospace tabular figures for every price, amount, address and time.
- Hairline rules and dotted leaders like a printed table; boxes only around interactive surfaces.
- One sliding ink block as the selection grammar for tabs, segmented controls, choice rows and the board cursor.
- Lime squares on hairline callouts join linked questions to the outcomes they are priced from.

## Colors

A paper-and-ink palette with a single fluorescent accent that marks state, never decoration.

### Primary
- **Forest Ink** (#14271d): text, primary buttons, the selection block, outlines of interactive surfaces, and the inverse panels of the loader and code blocks.
- **Highlighter Lime** (#d9f76d): the current state. The Open status fill, the square inside a chosen option, the counted cells of a joint grid, the latest point of a price chart, the one-time flash when a price moves, the lime squares on callout lines. Never a button fill for a primary action and never large areas.

### Neutral
- **Paper** (#f5f4ec): the page.
- **Raised Paper** (#fbfaf5): tiles, the ticket, sheets and inputs.
- **Sunken Paper** (#ecebe2): hover wash and quiet wells.
- **Secondary Ink** (#45524a) and **Tertiary Ink** (#5f6a63): supporting text and captions; tertiary is the floor for readable text.
- **Control Stroke** (#7f8981): input and control borders.
- **Rules**: forest ink at 12% for hairlines and 24% for stronger dividers.

### Semantic
- **Price Up** (#2f6b3c) and **Danger Brick** (#9a3324): the change since a member's last visit, and errors. Danger Brick Soft (#f6e3de) backs error and conflict panels.
- **Lime Soft** (#eef8c9): the cost line of a review and the "Closing soon" status.

### Named Rules
**The One Highlighter Rule.** Lime marks what is true now: open, chosen, counted, latest, changed. If nothing on screen is in that state, nothing is lime.

**The Signed Change Rule.** Green and brick appear only on price changes, always with a plus or minus sign and an arrow, so color is never the only signal.

## Typography

**Display Font:** Geist Pixel (with a metric-matched Courier New fallback)
**Body Font:** Space Grotesk (with a metric-matched Arial fallback)
**Label/Mono Font:** IBM Plex Mono (with a metric-matched Courier New fallback)

**Character:** A pixel face for the few words that should feel printed by the instrument itself, a plain grotesk for reading, and a tabular mono for every figure, so numbers line up in columns and never jitter.

### Hierarchy
- **Display** (400, clamp(40px, 4.3vw, 62px), 1.04): the landing headline only; at most two lines.
- **Headline** (400, clamp(30px, 3.4vw, 44px), 1.05): page titles and landing section titles, in the pixel face. Used only at 28px and above.
- **Title** (500, clamp(24px, 2.6vw, 32px), 1.12): the market question on its page; up to three lines with the full text in its tooltip.
- **Subtitle** (600, 18px, 1.25): section headings inside pages.
- **Body** (400, 15px, 1.5): reading text, at most 68 characters a line.
- **Small** (400, 13px, 1.45): captions and help.
- **Label** (500, 11px, 0.06em, uppercase): figure labels and table column heads only, never as a decorative eyebrow above a headline.
- **Figure** (500, 15px, tabular) and **Figure Large** (500, 28px, tabular): prices on tiles, and the price pair in a market header and sheet amounts.

### Named Rules
**The Tabular Rule.** Every price, amount, share count, address, block number and time is set in the mono face with tabular figures.

**The Pixel Ceiling Rule.** The pixel face never appears below 28px.

## Layout

Content sits in a 1200px container with gutters of 16, 24, 32 and 40px at the 640, 1024 and 1280px breakpoints. The header is 56px on phones and 64px from 1024px, a single line with a hairline under it.

The market board fits one screen: a category sub-navigation, a one-line toolbar, then a grid of tiles at least 272px wide and 124px tall (68px compact on phones) with a 12px gap, paged so it never scrolls. Below 560px of usable height it falls back to a scrolling list.

A market page has two columns from 1024px (8 and 4): the chart and tabbed details on the left, the trade ticket on the right, sticky while it fits. On phones the order is ticket, chart, details, then position. Reading pages (docs, account) use a single column of at most 720px. Spacing follows a 4px base scale.

Tables never scroll sideways: below 768px optional columns hide and their content moves into an expandable row detail, or rows reflow into labelled lines with explicit table roles.

## Elevation & Depth

Flat by default. Depth comes from tone (raised and sunken paper) and from ink outlines, not shadows. Two shadows exist, both for things that float above the page.

### Shadow Vocabulary
- **Popover** (`0 8px 24px rgba(20, 39, 29, 0.12), 0 1px 2px rgba(20, 39, 29, 0.08)`): the pending transaction dock.
- **Specimen** (`0 1px 0 #14271d, 0 18px 40px rgba(20, 39, 29, 0.10)`): the landing example market only, lifted off the halftone like a printed card.
- **Sheet** (`0 24px 48px rgba(20, 39, 29, 0.18), 0 2px 6px rgba(20, 39, 29, 0.10)`): the modal transaction sheet over a dimmed forest backdrop.

### Named Rules
**The Hairline Rule.** Reading content is grouped by hairline rules and whitespace. A box means "you can act on this."

## Shapes

Nearly square. Tags have 2px corners; controls and tiles 4px; panels and sheets 8px. There are no pills. Markers, step indices, chart points and callout ends are squares; native radio buttons keep their round shape so they still read as radios. The logo's contour rings are the brand's curves, and they recur as the halftone ground.

## Components

### Buttons
- **Shape:** 4px corners, 44px tall (48px for the main action of a page).
- **Primary:** forest ink with paper text; hover lightens the ink.
- **Secondary:** transparent with an ink outline; hover washes with sunken paper.
- **Press:** moves down 1px for 90ms. Focus shows a 2px ink outline with a lime ring.

### Status tags
- **Style:** square 2px corners, mono 11.5px, ink outline. Open is lime-filled; Closing soon uses lime soft; Settled is ink-filled; Void is dashed.

### Selection
- **Segmented controls, tabs, choice rows and the category nav** share one grammar: the chosen option is a solid ink block with paper text and a small lime square, and the block slides between options.
- **Choice rows** replace every member-facing dropdown: each option is a full-width row with a square marker; long lists gain a filter field.

### Market tile
- **Corner Style:** 4px, raised paper, rule-strong outline that turns ink on hover.
- **Content:** pool name, question, status tag, closing time, linked count, the Yes and No prices as two links, and the signed change since the last visit.
- **Keyboard cursor:** the focused tile inverts to the ink block.

### Transaction sheet
- **Modal** on desktop (520px, centered) and a bottom sheet on phones, with the wallet step, the exact amounts, the confirm button always in view, and the network tag. It cannot be dismissed while the wallet is open; a sent transaction can be hidden to the pending dock.
- **Docked** inside the ticket for reviews that prepare themselves as the member edits, with a sticky action bar.

### Combination slip
- **Anatomy:** the ticket's prediction as one to three lines. This question is always the first line, marked "This market", with its own Yes and No. Each line holds a mono Q tag (the question number, a 2px square tag with an ink outline), the full question text, and a segmented answer control; added lines carry a remove button.
- **Leader:** a 1px strong rule runs down the left edge through the Q tags. Where two lines join, an 8px lime square with an ink outline sits on the rule, and the rule word ("and", "or", "exactly one of") sits beside it in mono. With one line there is no leader and no joint.
- **Add area:** "Add a linked question" sits directly under the lines, with the pool's three strongest links as hairline rows (Q tag, full question, signed points, the word Add), a text toggle for the full searchable list, and a plain note once three lines are chosen. No box wraps the slip; the ticket panel is the box and hairlines group the parts.
- **Below two lines:** the rule control (All correct, At least one, Exactly one), one payout sentence, the outcome map, and the pool figures as dotted leaders (pool chance, chance if unrelated, difference in points), labelled as pool estimates.
- **Motion:** a new line slides in over 160ms and the lime joint scales in once; both are skipped under reduced motion.

### Outcome map
- **Two lines:** a 2x2 grid with the first line on the rows. **Three lines:** eight cells in two rows of four, each headed by Y or N for every line in question order. Each cell shows the pool's chance for that outcome.
- **Marks:** outcomes that pay take the lime fill with an ink outline (what is true if the prediction pays); the rest are dashed and quiet. Without a pool reading the cells say Pays or No payout.

### What if shift rows
- **Anatomy:** assumptions sit on top as lines with a Q tag, the full question and a Yes or No control (up to three, each removable). Below, one row per other question: Q tag, full question, the chance now, a dumbbell, the chance if assumed, the signed shift in points, and a Combine button.
- **Dumbbell:** a 120px hairline track with a hollow raised-paper square for the chance now and a lime square for the chance if assumed (lime marks what holds if the assumptions hold), joined by a 1.5px ink line. It carries a text alternative that states both chances and the direction of the shift.
- **Order:** largest absolute shift first, then question number; the top five are shown and the rest sit behind "All N questions". When the assumptions are too unlikely to condition on, the rows are replaced by one sentence.
- **Motion:** none beyond a 160ms fade of a new row, which reduced motion removes.

### Inputs
- **Style:** 1px control-stroke border, raised paper, 4px corners, 44px tall, 16px text on phones.
- **Focus:** ink outline with the lime ring.

### Linked questions callout
Hairline lines with lime squares connect a question to the outcomes it is priced from, as on an engraved banknote: on the market page's Linked tab, on the board when hovering a pool, and in the landing example. The combination slip in the ticket uses the same leader and joint square.

## Do's and Don'ts

### Do:
- **Do** render every price through the shared price component: mono, tabular, exact value in the tooltip, one lime flash when it changes.
- **Do** separate reading content with hairline rules and dotted leaders (`dt ....... dd`).
- **Do** keep each confirmation in the transaction sheet with its confirm button in view.
- **Do** keep the board on one screen and page through it.

### Don't:
- **Don't** use dropdowns on member pages; use choice rows or segmented controls.
- **Don't** let any page scroll sideways.
- **Don't** use rounded pills, gradients or decorative shadows.
- **Don't** use gaming or gambling vocabulary, celebration, or urgency cues.
- **Don't** use lime as a large fill or as the color of a primary action.
