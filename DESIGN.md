# lmao — UI design

The interface of a local engineering tool: strict, utilitarian, pure black. Structure comes from hairlines, not fills. Colour carries state and nothing else. Every screen is a dense, left-aligned column of text, numbers and small square markers.

Stack: Flask templates, Tailwind CSS v4 (browser build, no build step) and Alpine.js. This document describes the target state of the interface; features that need new backend support are marked **(backend)**.

## 1. Principles

1. **Zero radius, zero shadows, zero gradients.** `_theme.html` removes those theme keys, so `rounded-*` and `shadow-*` produce nothing.
2. **Hairlines over fills.** Structure is built from 1px lines (`border-line`). The only elevation device is `bg-surface`: side panels, answer boxes, code boxes, the load notice and the chart quadrant.
3. **Colour is rationed.** Neutrals, plus `link` for "in progress" and `warn` for errors. Scores are plain numbers. Bars, charts and matrices are monochrome: no green/yellow/red scales.
4. **Squares, not circles.** Markers, dots, rank badges and chart points are square.
5. **Text is left-aligned, at least 13px.** The topbar status and the first screen are the only centred blocks, and the text inside them stays left-aligned.
6. **Numbers are first-class content.** Large numerals (`text-display font-thin`) for key figures; `tabular-nums` only where digits change live or stand in columns. Never on body text: in Inter it also widens the hyphen, which breaks names like `ministral-3:3b`.
7. **Honest feedback.** Every wait has a visible reason: a breathing dot, a counter, a timer. The UI never claims what the backend does not report (for example VRAM state).
8. **Model output is text.** Nothing from a model or from a connection is ever rendered as HTML. Everything goes through `x-text`.
9. **Short names in the UI, full names in `title`.** Model names are shortened (`shortNames()`); the full name stays in tooltips, the archive and exports.

## 2. Tokens

### Colour

| Token | CSS variable | Utilities | Value |
|---|---|---|---|
| bg | `--color-bg` | `bg-bg`, `text-bg` | `#000000` |
| surface | `--color-surface` | `bg-surface` | `#0f0e12` |
| line | `--color-line` | `border-line`, `bg-line` | `#2a292e` |
| fg | `--color-fg` | `text-fg`, `bg-fg`, `border-fg` | `#f6f8f7` |
| fg-muted | `--color-fg-muted` | `text-fg-muted`, `border-fg-muted`, `bg-fg-muted` | `#b2b2b2` |
| link | `--color-link` | `text-link`, `bg-link` | `#3b9ae1` |
| warn | `--color-warn` | `text-warn`, `border-warn`, `bg-warn` | `#f0a800` |

Meaning: `link` = something is running now. `warn` = an error, or something that needs attention (a hidden error in a collapsed range, a failed connection). Nothing else uses these two.

A light theme is not designed. Tokens are the only thing that has to change when it arrives; icons use `currentColor`. The print variant (section 9) is a ready starting point.

### Typography

Inter 100 and 300, IBM Plex Mono 300. Body text is Inter Light at 13px. Inter Thin is used only for large numerals. Bold is shown by colour (`text-fg`), because only 100 and 300 are loaded.

| Style | Utilities | Size / line height |
|---|---|---|
| caption (body) | `text-caption font-light` | 13 / 1.5 |
| subheading | `text-subheading font-light` | 19 / 1.15 |
| heading-sm | `text-heading-sm font-light` | 24 / 1.15 |
| heading | `text-heading font-light` | 26 / 1.15 |
| display | `text-display font-light` | 40 / 1.11 |
| numeral | `text-display font-thin` | 40, weight 100 |
| code | `font-mono text-caption font-light` | 13 / 1.5 |

Mono is used for code, request previews and technical labels (endpoints, parameter names).

### Spacing

`--spacing: 1px`, so `p-22` is 22px and `w-320` is 320px. Tailwind's documentation examples shrink accordingly (`p-4` is 4px).

Scale: 15, 22, 33, 66 for structure. 4, 6, 8, 10, 12 for small gaps.

### Motion

- `breathe`: 2s ease-in-out, opacity 1 to 0.25. Used only by the activity dot.
- Panels animate their width in 200ms ease-out.
- Progress fills animate `width` in 200ms.
- Everything respects `prefers-reduced-motion` (`motion-reduce:` variants): the result is a hard cut.

### Technical notes

- `@theme` must live in an inline `<style type="text/tailwindcss">`; the browser build does not load an external theme file.
- The browser build compiles on the client: expect a short unstyled flash. Alpine blocks use `x-cloak`.
- `static/favicon.svg` has hardcoded colours because it renders outside the page. It is the only exception to "tokens only".
- Tailwind, Alpine and the fonts load from pinned CDN URLs. Offline machines get an unstyled page. Planned: vendor them with pinned versions and hashes.

## 3. Layout

```
<body class="h-screen flex flex-col overflow-hidden">
  topbar          h-66 shrink-0 grid grid-cols-[1fr_auto_1fr] items-center gap-22 px-22 border-b border-line
  <div class="flex flex-1 min-h-0">
    aside#setup   shrink-0 overflow-hidden bg-surface; w-320 border-r | w-0
      inner       w-319 h-full p-22 overflow-y-auto
    main          flex-1 min-w-0 p-33 overflow-y-auto
    aside#archive shrink-0 flex justify-end overflow-hidden bg-surface; w-280 border-l | w-0
      inner       w-279 shrink-0 h-full p-22 overflow-y-auto
  </div>
  live region     sr-only, aria-live="polite"
</body>
```

Three panels: setup (left), work area (centre), archive (right). The side panels collapse so the centre keeps the focus.

- Panels animate their width. The content has a fixed width, so it is clipped, never re-wrapped. A closed panel is `inert`: out of the tab order and the accessibility tree.
- The archive content is anchored to the window edge (`justify-end`), so both panels close like a mirrored curtain.
- Panel state is not persisted across reloads.
- Centre content is `flex flex-col gap-33`. A section is a label row plus content with `gap-15`.

### Panels per screen

| Screen | setup | archive |
|---|---|---|
| start | open | open |
| running | closed (closes automatically when a run starts) | open |
| results | open | open |
| any screen, focus mode | closed | closed |

Any combination is allowed; the table lists the defaults.

### Topbar

Left: setup toggle and the wordmark (`lmao` plus the subtitle, which truncates). Centre: status. Right: archive toggle.

- The wordmark is a button that returns to the first screen. A running evaluation keeps going; the form and the archive stay locked on every screen while it runs.
- Nav toggles: a 20px square with a strip. Open: a 7px filled strip on the panel side. Closed: a 1px line. The strip animates with the panel. The label sits beside the icon (`[icon] setup`, `archive [icon]`), so both toggles share one centre line. Hotkeys are in `aria-keyshortcuts` and in the title.

Status (derived from existing state only):

| State | Status |
|---|---|
| run in progress, any screen | activity dot and `running · 38:05 · 181 / 217` in `tabular-nums`; `back to run` while another screen is shown |
| running screen, run failed | `stopped` (warn) |
| results | run name |
| idle, connecting | `connecting…` |
| idle, no models | `no models found` (warn) |
| idle, local judge | `ollama · N models` (muted) |
| idle, remote judge | `ollama · N models · judge api.openai.com 142 ms` (muted); latency from the last connection test **(backend)** |

### Keyboard

`[` toggles setup, `]` toggles archive, `Esc` returns to the first screen. Keys are matched by `event.code`, so they work on any keyboard layout. They are ignored inside inputs and with modifiers.

## 4. Components

Each component is one Jinja macro in `templates/_components.html`. Arguments named `show`, `model`, `state`, `label`, `meta` and `*_expr` are Alpine expressions.

### Foundations

| Macro | Purpose |
|---|---|
| `section_label` | hairline under a muted caption: `pb-8 border-b border-line text-fg-muted` |
| `activity_dot` | 8px square, `bg-link animate-breathe`; shown only while something runs |
| `field` | label above an input or textarea: `bg-bg border border-line px-12 py-10`, focus `border-fg` |
| `checkbox_row` | label is the group, native input is `sr-only`; box `size-14`, filled when checked; optional hint line |
| `warn_notice` | `border border-warn px-15 py-12 text-warn`, `role="alert"`, optional action button; errors only |
| `tabs` | tablist: active `bg-fg text-bg`, inactive `border-line text-fg-muted`; arrows cycle, Home/End jump |
| `nav_toggle` | see Topbar |
| `card_head` | title (`text-subheading`) left, metrics (muted) right, hairline below |

Buttons:

- primary: `bg-fg text-bg px-22 py-13`, full width in the setup panel; disabled `bg-line text-fg-muted`
- secondary: `border border-fg-muted text-fg px-22 py-13`; hover `border-fg`
- text button (`collapse`, `remove`, `import`, `edit`, `show`): muted, hover `text-fg`
- warn button (inside a warn notice): `border border-warn px-15 py-9`; hover `bg-line`

Select: the same box as a field, native `<select class="appearance-none">` with a 12px chevron.

### Status row

`status_row(state, label, meta)`: state (72px) | label | meta. Used on the first screen, in preflight and in the "now" list.

Colours: `done`, `ready` = fg. `running` = link. `queued`, `skipped` = muted. `error` = warn.

### Rank badge

A 20px square with a two-digit number (`01`), `border border-fg`. The number is the model's rank by mean score and never changes when the table is re-sorted. Variants: thin border = ordinary model; filled (`bg-fg text-bg`) = recommended; thick border = best on the metric shown (best score or fastest). Badges tie rows, chart points and bars together across the page.

### Matrix cell

A 16px square in a models × questions grid. The state is encoded by shape and fill, in the same colours as the rest of the UI:

| State | Look |
|---|---|
| planned | empty, hairline outline |
| answering | filled `link` |
| answer ready | outline `fg` |
| grading | outline `fg` with a small `link` square inside |
| graded | filled `fg` |
| generation error | filled `warn` |
| judge error | outline `warn` |

The legend is always shown under the matrix. A cell has a tooltip (`ministral-3:3b · q4`, `judge error · invalid JSON`).

### Value bar

A thin track (`h-2 bg-line`) under a number, with a `bg-fg` fill proportional to the value. `bg-fg-muted` for muted values (questions without a reference). Empty for errors. A dashed vertical tick marks a reference line (the median) when the column has one.

### Key figure

Label (muted), value (`text-display font-thin`) with a unit, caption (muted). Captions are relative: `best of 10`, `#7 of 10 · best 65`, `only model`.

### Answer box

`bg-surface border border-line`, toolbar on the right (`raw` toggles the source, `copy` copies it), rendered Markdown below. `copy` exists only in a secure context (localhost or https). Used for answers, reference answers and the judge summary.

### Markdown

`parseMarkdown()` produces blocks; `ui.md` renders them with `x-text` only.

- Blocks: headings (h1–h2 use `text-subheading`), paragraphs, lists (ordered lists keep their numbers), code fences (`bg-bg`, `whitespace-pre`, horizontal scroll, a language tag above), tables (hairline cells; the header needs the `|---|` row), rules.
- Inline: `**bold**` is `text-fg`; `` `code` `` is mono with `bg-bg`.
- Not supported, stays text: links, italics, images, HTML, nested lists (flattened).
- A `markdown` fence around the whole text is removed; the judge summary also drops a bare fence.
- Answers are parsed once per run (`WeakMap`); both views share the blocks.

### Code box

`bg-surface border border-line p-15 font-mono`, an optional header row (title left, actions right). Used for the request preview.

## 5. Screens

### 5.1 Start

**Setup panel**, top to bottom, with `run evaluation` pinned to the bottom (`flex flex-col justify-between gap-22`). Any input clears `formError`.

1. **01 judge.** A three-way tab: `local`, `ollama cloud`, `openai api`.
   - `local`: a select of installed models.
   - `ollama cloud`: a select of cloud models; a hint that grading runs in parallel and that prompts and answers leave the machine.
   - `openai api`: shows the saved connection (see *Connection* below) and a model field.
2. **02 candidates.** A scrolling list of checkbox rows (max 240px). Empty state: a warn notice with `reload`.
3. **03 judge criteria (optional).** A textarea; applied to every question.
4. **04 test cases.** See below.
5. Form error (warn notice), then the primary button.

**Test cases.** Expanded case: `border border-line p-15`, header `case 01 · collapse · remove`; fields: tag, question, reference answer, specific criteria. Collapsed: `case 02 · tag · edit` on one line. `+ add test case` is a secondary button. `import` and `export` sit under it as text buttons; `export` is disabled while no case has a question; errors appear in a warn notice.

File format, with the same field names as the `/api/evaluate` payload:

```json
{"version": 1, "base_rationale": "...", "test_cases": [{"tag": "", "question": "", "specific_rationale": "", "reference": ""}]}
```

- Export writes every case that has a question, trimmed, with empty optional fields left out.
- Import checks the size (256 KB) before reading, then validates the version, types and count (at most 200). Errors name the case: `case 03: the question is empty`. Unknown fields are ignored; `null` counts as missing.
- Import into an empty form replaces it; otherwise cases are appended. Blank cases are dropped. Imported cases arrive collapsed. The general criteria of the file are used only while the field is empty.

**Connection (openai api) (backend).** A bordered block in the setup panel.

- Header: `connection · openai`, `cancel` on the right while editing.
- Fields: `base url`, `api key` (shown masked with the last four characters), `model`.
- A note: `stored on the server, never shown again`. The key is never returned to the browser after saving.
- Actions: `test`, `save`.
- States: *no connection* (an empty block with a single call to action), *editing*, *saved* (summary line with the host and `edit`), *error* (warn notice with the reason, for example an authentication or network failure).

**Centre: the first screen.** A block of `max-w-560`: `new evaluation` (`text-heading`), one muted line, then sections separated by `section_label`:

1. **checklist**: `01 judge`, `02 candidates`, `03 test cases`, `04 run evaluation`. Row states: `done`, `queued`, `error`, `ready`, `running`. The judge row says `editing connection` while the connection form is open.
2. **route** (shown for a remote judge): three bordered boxes joined by labelled arrows: `candidates · N · local ollama` → *answers* → `lmao · blind grading` → *prompt* → `judge · api.openai.com`, and *grade* back. Under it: `this machine` on the left, `internet · tls` on the right.
3. **preflight** (remote judge) **(backend)**: status rows run against the connection, with technical labels in mono: model list reachable (status, latency, model count), structured output supported, seed and temperature accepted, token usage reported, rate limit (`unknown · retry on 429`).
4. **budget · estimate for this run** (remote judge): four key figures in hairline columns: `judge calls`, `tokens`, `cost`, `sent out`. The captions explain the basis: `3 refs · 9 grades · 1 summary`, `in ~18k · out ~3k`, `gpt-4.1-mini list price`, `graded blind, no names`.
5. **request preview**: a code box titled `grading call · no model names` with `key redacted · copy as curl`. It shows the real shape of one grading request with placeholders for the question, reference and answer.

Buttons below: `back to run` while a run is in progress; `open setup` while the panel is closed.

### 5.2 Running

The setup panel closes. Elapsed time and the step count are in the topbar.

**Progress.** A grid of four segments (`2fr 2fr 2fr 1fr`, gap 33): `01 reference`, `02 answers`, `03 grading`, `04 summary`. Each segment is a button: the label (with an activity dot while running) and `finished / total` on the right, then an `h-4 bg-line` track with an `h-4 bg-fg` fill. Segments fill independently, because a cloud judge grades while local candidates still answer. A finished phase also shows its duration (wall clock from the first start to the last end). Errors show as `· N err` in warn. Summary is a single call: half width, no counter. Clicking a segment scrolls to its rows. An `sr-only` `progressbar` carries the overall value.

**Matrix.** `models × questions`, with the judge mode noted on the right (`local judge · one model in VRAM at a time`, or the cloud variant).

- Rows: the reference row (judge name in muted text, with its answered count and no graded count) and one row per candidate. The model currently working is coloured `link`.
- Columns: model, `time` (total answering time of the model), question columns, `answered`, `graded`.
- Footer rows: per-question `answered` and `graded` counts; a count in `warn` means an error in that column.
- Cells use the matrix cell states (section 4). Hovering a cell shows its tooltip.
- Legend and a one-line explanation under the grid.

**Long runs (more than 10 questions).** The matrix shows a window of 10 question columns.

- A line above the grid: `24 questions · showing q07–q16`, with `follow current · on/off`, `‹ prev` and `next ›`.
- Columns outside the window collapse into counters at the edges (`‹ 6`, `8 ›`) in every row. A counter turns `warn` if any hidden cell has an error; its tooltip summarises the hidden range (`5 graded · 1 judge error (q4)`).
- `follow current` moves the window with the active question. Manual paging turns it off.

**Now.** Under the matrix, a `now` section lists the calls in flight as status rows: state, label, timer. In cloud mode several rows can run at once.

**Load notice.** Shown only after a row has been `running` for about 8 seconds on the first call of a model load group, so it appears only where a model may still be loading. It says that loading is normal, makes no claim about VRAM, and is announced once through the live region.

**Errors.** A failed run shows a warn notice with `back to setup`. Rows in flight when the stream breaks become `error · interrupted`. The connection is not reopened automatically, because the server replays the stream from the start.

### 5.3 Results

**Header.** Run name (`text-heading`) and a muted line (`finished … · took … · judge … · cloud judge`). On the right: `export json csv md print`.

**Two tabs:** `overview` and `answers`. Under the tabs the overview has an anchor navigation on the right: `summary · models · speed vs quality · details · questions · run`.

#### Overview

**01 summary.**
- The verdict: the label (`recommended` or `no recommendation`), the short model name (`text-heading`) and the rule in words.
- Four key figures of the recommended model in a 2×2 grid beside the verdict: mean score, pass rate, speed (c/s) and median time, each with its place in the run.
- `notes` row (muted): the judge is also a candidate, questions without a reference, low confidence.
- `judge summary`: the judge text as Markdown, collapsed by default (`show`). Full model names in it are replaced with short names.

**02 models.** One sortable table, one row per model.

- Columns: rank badge, model, `mean` (default sort, descending), `median`, `pass`, `c/s`, `time, s`, `length`, `score/GB`, `tok/pass`, `memory GB`. Each numeric cell has a value bar. The first column is the badge, so a re-sorted table keeps the numbers of the models.
- A click on a column header sorts by it; the active column shows the direction.
- Definitions under the table: c/s is characters per second; time is the median answering time (lower is better); length is the average characters per answer; tok/pass is tokens spent per correct answer (lower is better); score/GB is mean score per GB on disk; memory is the loaded size as reported by Ollama **(backend)**.
- Wide tables scroll sideways with a sticky model column; the sticky cell stretches to the row height.
- Cell notes: `err` (generation error, warn), `?` (judge error, warn), `*` (truncated), muted (question without a reference, excluded from the scores).

**03 speed vs quality.** A scatter of mean score (y, fixed 0–100 so runs compare) against median chars/s (x, linear, ticks at 1/2/5 × 10ⁿ).
- Points are 20px rank badges. Filled = recommended; thick border = best score and fastest; thin = other models. Direct labels: `best score`, `recommended`, `fastest`.
- The quadrant faster and better than both medians is `bg-surface`, bounded by dashed median lines with their values in the plot (`median 90.5 c/s`, `median 52.5`). The labels flip near the right edge and the top, so nothing leaves the box.
- A dashed Pareto line joins the models nobody beats on both axes. It is the only SVG; everything else is positioned HTML.
- A legend in one wrapping row under the plot. Models without a score or c/s are listed as "not plotted". The plot has `role="img"` with a text summary.

**04 details.** Four small multiples in a 2×2 grid. Every panel uses the same badges and shares one model order, so a model is found at the same place in each. Each has a title, a one-line explanation on the right and a dashed median line.
- `score / GB`: mean score per GB on disk.
- `tokens / correct`: generated tokens per correct answer; lower is better. An outlier bar is cut with `axis cut`.
- `memory`: size loaded by Ollama, split into `CPU (VRAM)` and `CPU (RAM, offload)`; the label shows the share on the GPU when a model spills over **(backend)**.
- `tokens vs characters`: a scatter of tokens/s (x) against chars/s (y) with reference lines for `3 chars/token` and `4 chars/token`; it shows how far chars/s can be compared across tokenizers.

**Answers by category.** Stacked horizontal bars, one per model: perfect, acceptable, violation of instructions, broken logic, garbage, in five monochrome steps from light to dark, with `uncategorised` and error segments only where they occur (errors in warn). A dashed line marks the 80% pass threshold; the pass share is written at the end of the bar.

**05 hardest questions.** The five questions with the lowest mean score: question, mean, a range track (min–max with the mean as a tick), `passed n/N`, and the best model as a badge.

**06 run.** How the run was made, in a few muted lines: start time, runtime version, judge and mode, the number of candidates, questions and steps, candidate and judge generation parameters (temperature, seed, `num_predict`, `num_ctx`, thinking off). It exists so a result can be reproduced and compared.

#### Answers

**01 scores.** A models × questions matrix with every score and a value bar under it. Rows keep the rank badges. The matrix scrolls sideways with a sticky model column and a `… q30 →` hint. The model name jumps to its block below; a score jumps to its answer. A missing result is a disabled cell. Legend: `err`, `?`, muted.

**02 answers.** `every answer with its grade and the judge comment`, with a `per model` / `per question` tab.
- *Per model*: a list of collapsed rows (badge, name, `mean · median · pass · errors`, `show/hide`). An opened model shows its answers as eval blocks and a `N more answers · show all` footer after the first few.
- *Per question*: one card per question with the score scale (a hairline 0–100 with one tick per distinct score; a taller tick when several models share it), then one eval block per model, best first, failed ones last. Ranks use competition ranking (1, 1, 3).
- Only one view is in the DOM at a time. An answer has the same id in both views, so a link from the matrix lands on the right block.

**Eval block.** Two columns, gap 33. Left (120px): the label (question or model), the score in `text-display font-thin`, `/ 100`, the category. Right: the first line (the question, or `rank 01 / 03`), notes (muted), the judge comment, the answer box. A failed block has a `border border-warn` frame, the score replaced by `err`, and the reason in warn.

**03 reference answers.** `written by the judge unless provided`. One collapsed row per question (`q1 · en-fact-astronomy · provided`), `N more questions · show all`.

### 5.4 Archive

A list in the right panel. Each item: `py-15 border-b border-line`; the title (`text-subheading`; the open run is `text-fg` with a leading `size-6` filled marker, others are muted); three muted lines (date, `N models · N qs`, `judge: <full name>`). Newest first (the time is read from the end of the run id, with the stored timestamp as a fallback). Items are disabled while a run is in progress. Empty and error states have their own muted line or warn notice with `reload`.

## 6. States

| Situation | Treatment |
|---|---|
| waiting for a model to load | one `running` state plus the load notice after ~8 s |
| no models | warn notice with `reload`; status `no models found` |
| connection missing or failed | warn notice inside the connection block; the checklist judge row is `error` |
| generation error | `err` cell, warn eval block, the matching grading step is `skipped` |
| judge error | `?` cell, warn eval block; the answer is kept, excluded from the scores |
| truncated answer | `*` after the score, a note in the eval block; it can never count as a pass |
| no reference | muted cells and bars; notes say `excluded from the scores` |
| run failed | warn notice with `back to setup`; topbar `stopped` |
| unreadable run file | a warn message in the results area; nothing else breaks |
| loading | muted `loading…` |

Disabled controls use `bg-line text-fg-muted cursor-not-allowed` (primary) or muted text (others). The global focus style is a 1px `fg` outline with a 2px offset.

## 7. Accessibility

- One `sr-only aria-live="polite"` region per page. It announces the first event of each phase, the load notice (once per row), imports and the finish. Errors use `role="alert"` on the warn notice.
- Tabs follow the tablist pattern: ids `tab-<state>-<value>`, panel `panel-<state>`, arrows and Home/End, the focus follows the active tab.
- Everything clickable is a native button or link. The matrix, tables and charts have text equivalents: aria labels on cells and headers, `role="img"` with a summary on plots.
- A matrix cell state is never carried by colour alone: shape and fill differ.
- Closed panels are `inert`. Hotkeys do not fire while typing.
- Checkboxes use `:has()` (Firefox 121+, Safari 15.4+); the native input stays in the DOM.

## 8. Data contract

The sources of truth are `static/js/lmao.js` (Alpine state, SSE, requests) and `static/js/lib.js` (pure helpers, tested with `node --test`). Only what the design depends on is repeated here.

State: panel flags, `view` (`idle | running | results`), `resultsTab` (`overview | answers`), `answersView` (`model | question`), the setup form, the judge connection, `history`, `run` (rows, progress, timers), `report` (everything the results screens show, built once by `buildReport()`), `announcement`.

Getters: `busy`, `topStatus`, `checklist`, `phaseProgress`, `elapsed`.

### Stream events

`/api/stream/<task_id>`. Every event except `info`, `completed` and `error` carries `phase`, `model`, `question` and `progress: {done, total}`. The row key is `phase:model:question`; for the reference phase the model is the judge, and for the summary the question is empty.

| Event | UI |
|---|---|
| `reference_start`, `reference_done` | reference row `running`, then `done` (meta = source) or `error` (graded without a reference) |
| `candidate_start` | group marker only |
| `answer_start`, `answer_done` | matrix cell `answering`, then `answer ready` or `generation error`; a failure marks the matching grading cell `skipped` immediately |
| `grading_start`, `grading_done` | matrix cell `grading`, then `graded` or `judge error` |
| `summary_start`, `summary_done` | the summary row |
| `completed` | `done = total`, fetch the results, switch to the results screen, refresh the archive |
| `error` | warn notice |
| `info` | not shown |

Progress is `total = Q × (1 + 2M) + 1` (M = unique candidates). Durations come from event timestamps, so parallel calls are not added up. A duplicate `*_start` does not reset a running row. A finished row ignores later events. The stream is closed on the first `onerror`.

The server sends a `: ping` comment every 15 seconds, so a closed connection fails a write and frees its thread.

## 9. Export and print

In the results header: `export json csv md print` (muted, hidden when printing). `json`, `csv` and `md` are download links to `/api/results/<id>/export?format=…`; `print` calls `window.print()`. CSV cells that look like formulas are defused, and Markdown exports fence model output.

`@media print` (plain CSS, unlayered, so it wins over utilities):
- The tokens get a light variant: `bg #ffffff`, `surface #f5f5f6`, `line #c9c9cf`, `fg #000000`, `fg-muted #55555a`, `link #0b5cad`, `warn #8a5a00`. This is the only place colours differ.
- `print-color-adjust: exact` everywhere, otherwise bars and surface boxes disappear.
- The header and both panels are hidden; the body and `main` flow across pages; tabs are hidden; code blocks wrap.

Limits: only the active tab and view are printed, so switch first. Closed `<details>` print closed. A wide matrix is clipped at the page edge.

## 10. Not designed yet

- Cancel run (needs an endpoint: a flag per task, checks between steps in both modes, unloading in `finally`).
- A queue of runs.
- Light theme.
- Responsive behaviour. Proposal: below ~1024px the panels become overlays (`absolute inset-y-0 z-10`) instead of columns.
- Stream reconnect (needs the server to resume instead of replaying from the start).
- Vendoring Tailwind, Alpine and the fonts.