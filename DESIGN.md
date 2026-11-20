# lmao — UI design

The interface of a local engineering tool: strict, utilitarian, pure black. Structure comes from hairlines, not fills. Colour carries state and nothing else. Every screen is a dense, left-aligned column of text, numbers and small square markers.

Stack: Flask templates, Tailwind CSS v4 and Alpine.js, with the front end in TypeScript. Everything is built ahead of time in Docker and nothing loads from another host. This document describes the interface as it is built; the sources of truth are `frontend/lmao.ts` (state, stream, requests), `frontend/lib.ts` and the other pure modules in `frontend/` (tested with `node --test`), and `templates/`.

## 1. Principles

1. **Zero radius, zero shadows, zero gradients.** `static/css/input.css` clears those theme keys, so `rounded-*` and `shadow-*` produce nothing.
2. **Hairlines over fills.** Structure is built from 1px lines (`border-line`). The only elevation is `bg-surface`: side panels, answer and code boxes, the load notice, the chart quadrant.
3. **Colour is rationed.** Neutrals, plus `link` for "in progress" and `warn` for errors. Scores are plain numbers; bars, charts and matrices are monochrome.
4. **Squares, not circles.** Markers, dots, rank badges and chart points are square.
5. **Text is left-aligned, at least 13px.** Only the topbar status and the first screen are centred blocks, and their text stays left-aligned.
6. **Numbers are first-class content.** Large numerals (`text-display font-thin`) for key figures. `tabular-nums` only where digits change live or stand in columns, never on body text: in Inter it widens the hyphen and breaks names like `ministral-3:3b`.
7. **Honest feedback.** Every wait has a visible reason (a breathing dot, a counter, a timer). The UI never claims what the backend does not report.
8. **Model output is text.** Nothing from a model or a connection is rendered as HTML: only `x-text` and the `x-md` directive, which builds elements from `createElement` and text nodes.
9. **Short names in the UI, full names in `title`.** `shortNames()` shortens model names; the full name stays in tooltips, the archive and exports.

## 2. Tokens

| Token | Utilities | Value | Meaning |
|---|---|---|---|
| bg | `bg-bg`, `text-bg` | `#000000` | page |
| surface | `bg-surface` | `#0f0e12` | elevated boxes |
| line | `border-line`, `bg-line` | `#2a292e` | hairlines, empty tracks |
| fg | `text-fg`, `bg-fg`, `border-fg` | `#f6f8f7` | text, filled marks |
| fg-muted | `text-fg-muted`, `border-fg-muted` | `#b2b2b2` | secondary text |
| link | `text-link`, `bg-link` | `#3b9ae1` | something is running now |
| warn | `text-warn`, `border-warn`, `bg-warn` | `#f0a800` | an error or something that needs attention |

`link` and `warn` are used for nothing else. A light theme is not designed; only the tokens would change. The print variant (section 9) is a starting point.

**Typography.** Inter 100 and 300, IBM Plex Mono 300. Body is Inter Light 13px; Thin only for large numerals. Bold is shown by colour (`text-fg`), because only 100 and 300 are loaded.

| Style | Utilities | Size / line height |
|---|---|---|
| caption (body) | `text-caption font-light` | 13 / 1.5 |
| subheading | `text-subheading` | 19 / 1.15 |
| heading-sm / heading | `text-heading-sm` / `text-heading` | 24 / 26, 1.15 |
| numeral | `text-display font-thin` | 40 / 1.11 |
| code | `font-mono text-caption` | 13 / 1.5 |

Mono is for code, request previews and technical labels.

**Spacing.** `--spacing: 1px`, so `p-22` is 22px and `w-320` is 320px. Structure uses 15, 22, 33, 66; small gaps use 4, 6, 8, 10, 12.

**Motion.** `breathe` (2s, opacity 1 to 0.25) is the only animation. Panels animate width in 200ms, progress fills animate `width` in 200ms. `motion-reduce:` variants turn all of it into hard cuts.

**Technical notes.**
- `static/css/input.css` (tokens in `@theme`, fonts, base and print styles) is compiled to `static/css/app.css`; Alpine and the font files come from npm packages pinned by `package-lock.json` (`scripts/build-assets.sh`). Production builds it in the Dockerfile, development with `make css` or the `css` service of `make dev`. Generated files are not committed.
- The class scan reads `templates/` and `frontend/`. Classes composed from a variable (`nav_toggle`) are listed in `@source inline(...)`; a test checks them.
- Alpine blocks use `x-cloak`. Eval blocks use `.defer-render` (`content-visibility: auto`) to keep long reports cheap; print turns it off, and jumps scroll instantly because the heights of skipped blocks are estimates.
- Inter and IBM Plex Mono are split into latin and cyrillic files (Inter Thin is latin only); other scripts fall back to the system font. The body font is preloaded.
- `static/favicon.svg` has hardcoded colours because it renders outside the page; it is the only exception to "tokens only". While a run is on, the tab icon shows its four phases as four bars (off, blue = active, white = done) and the title shows the clock and step count.

## 3. Layout

```
<body class="h-screen flex flex-col overflow-hidden">
  topbar          h-66 grid grid-cols-[1fr_auto_1fr] items-center gap-22 px-22 border-b border-line
  <div class="flex flex-1 min-h-0">
    aside#setup   bg-surface; w-320 border-r | w-0
    main          flex-1 min-w-0 p-33 overflow-y-auto
    aside#archive bg-surface; w-280 border-l | w-0
  </div>
  live region     sr-only, aria-live="polite"
</body>
```

Three panels: setup (left), work area (centre), archive (right). Panels animate their width; their content has a fixed width, so it is clipped, never re-wrapped. A closed panel is `inert`. The archive is anchored to the window edge (`justify-end`), so both close like a mirrored curtain. Panel state is not persisted. Centre content is `flex flex-col gap-33`; a section is a label row plus content with `gap-15`.

| Screen | setup | archive |
|---|---|---|
| start | open | open |
| running | closed (closes when a run starts) | open |
| results | open | open |

**Topbar.** Left: setup toggle and the wordmark, a button that returns to the first screen (a running evaluation keeps going). Centre: status. Right: archive toggle. Toggles are a 20px square with a strip (open: 7px filled strip on the panel side, closed: 1px line) and the label beside it. The form stays locked on every screen while a run is in progress; the archive does not, so past results can be opened and `back to run` leads back.

| State | Status |
|---|---|
| run in progress | activity dot, `running · 38:05 · 181 / 217` (`tabular-nums`); `back to run` on another screen |
| stop requested | `stopping · …` |
| stopped | `stopped · …` (muted), plus `back to run` on another screen |
| failed or connection lost | `failed · …` (warn); the notice offers `reconnect` (the run may still go on) |
| finished while another screen is shown | `finished · …` and `open results` |
| results | run name |
| idle | `connecting…`, `no models found` (warn), or `ollama · N models` (muted), with `judge api.openai.com 142 ms` for a remote judge (latency of the last connection test) |

**Keyboard.** `[` toggles setup, `]` toggles archive, `Esc` returns to the first screen. Keys are matched by `event.code`, so they work on any layout, and are ignored inside inputs and with modifiers.

## 4. Components

One Jinja macro per component in `templates/_components.html`. Arguments named `show`, `model`, `state`, `label`, `meta` and `*_expr` are Alpine expressions.

| Macro | Look |
|---|---|
| `section_label` | muted caption over a hairline: `pb-8 border-b border-line` |
| `activity_dot` | 8px `bg-link` square, shown only while something runs |
| `field` | label above an input or textarea: `bg-bg border border-line px-12 py-10`, focus `border-fg` |
| `checkbox_row` | the label is the group, the native input is `sr-only`; box `size-14`, filled when checked |
| `warn_notice` | `border border-warn px-15 py-12 text-warn`, `role="alert"`, optional action button; errors only |
| `info_strip` | a note with a hairline under it, not an error |
| `tabs` | tablist; active `bg-fg text-bg`, inactive `border-line text-fg-muted`; arrows cycle, Home/End jump |
| `fold_head`, `more_row` | folded row (`+` / `–`, name, metrics, `show` / `hide`) and `N more … · show all` |
| `status_row` | state (72px) \| label \| meta; `done`/`ready` fg, `running` link, `queued`/`skipped` muted, `error` warn |
| `eval_block` | see section 5.3 |
| `section_nav` | anchor buttons that scroll to `sec-<id>` of the open tab |

**Buttons.** Primary `bg-fg text-bg px-22 py-13` (disabled `bg-line text-fg-muted`); secondary `border border-fg-muted text-fg px-22 py-13` (hover `border-fg`); text buttons (`collapse`, `remove`, `import`, `edit`, `show`) are muted, hover `text-fg`; warn button inside a notice `border border-warn px-15 py-9`. A select is the field box with a native `<select class="appearance-none">` and a 12px chevron.

**Rank badge.** A 20px square with the model's two-digit rank by mean score (`01`), `border border-fg`. It never changes when a table is re-sorted and ties rows, chart points and bars together across the page. Thin border = ordinary, filled (`bg-fg text-bg`) = recommended, thick border = best on the metric shown (best score or fastest).

**Matrix cell.** An 18px square (12px in the legend) in a models × questions grid. State is encoded by shape and fill, never by colour alone, and every state is a class of the cell, never an `x-show` of a child (Alpine shows an `x-show` element one frame late but hides it at once, so a step that finished within a frame would keep its old mark).

| State | Look |
|---|---|
| planned | empty, hairline outline |
| answering | filled `link`, breathes |
| answer ready | outline `fg` |
| grading | outline `fg` with a small breathing `link` square inside |
| graded | filled `fg` |
| generation error | filled `warn` |
| judge error | outline `fg` with a small `warn` square inside |
| stopped | outline `fg-muted` with a short dash: a step that did not run because the run was stopped |

The inner square is about 55% of the mark. A cell has a tooltip (`ministral-3:3b · q4: answer ready · 4.1 s`) and the legend under the matrix lists all eight states.

**Value bar.** A thin track (`h-2 bg-line`) under a number with a `bg-fg` fill proportional to the value (`bg-fg-muted` for muted values). Empty for errors. A dashed tick marks a reference line such as the median.

**Key figure.** Muted label, value (`text-display font-thin`) with a unit, muted caption relative to the run: `best of 10`, `#7 of 10 · best 65`, `only model`.

**Answer box.** `bg-surface border border-line` with `raw` (shows the source) and `copy` (secure context only) on the right, rendered Markdown below. Used for answers, reference answers and the judge summary. **Code box:** the same surface with `font-mono` and an optional header row; used for the request preview.

**Markdown.** `parseMarkdown()` gives blocks, `markdownTree()` a plain element tree, the `x-md` directive builds the DOM. Supported: headings (h1–h2 use `text-subheading`), paragraphs, lists (ordered keep their numbers; nested lists are flattened), code fences (language tag above, horizontal scroll), tables (the header needs the `|---|` row), rules, `**bold**` (`text-fg`) and `` `code` ``. Links, italics, images and HTML stay text. A `markdown` fence around the whole text is removed (the judge summary also drops a bare fence). Answers are parsed once when opened and shared by both views.

## 5. Screens

### 5.1 Start

**Setup panel**, top to bottom, with `run evaluation` pinned to the bottom. Any input clears `formError`.

1. **01 judge**: a full-width tab `local` / `ollama cloud` / `openai api`. Local: a select of installed non-cloud models. Ollama cloud: a select of models named `…-cloud` or `…:cloud`, with a hint that grading runs in parallel and data leaves the machine. OpenAI api: the saved connection is the judge (below).
2. **02 candidates**: a scrolling list of checkbox rows (max 240px); empty state is a warn notice with `reload`.
3. **03 judge criteria (optional)**: a textarea applied to every question.
4. **04 test cases**: an expanded case (`case 01 · collapse · remove`) has tag, question, reference answer and specific criteria; a collapsed one is `case 02 · tag · edit`. `+ add test case`, then `import` and `export`.

Test case file, with the field names of the `/api/evaluate` payload:

```json
{"version": 1, "base_rationale": "...", "test_cases": [{"tag": "", "question": "", "specific_rationale": "", "reference": ""}]}
```

Export writes every case that has a question, trimmed, without empty optional fields. Import checks the size (256 KB), version, types and count (200), and names the case in errors (`case 03: the question is empty`). Unknown fields are ignored, `null` counts as missing. Into an empty form the file replaces it, otherwise cases are appended; blank cases are dropped and imported ones arrive collapsed. The file's general criteria are used only while that field is empty.

**Connection (openai api).** Four states:
- *none*: `no connection`, a one-line explanation and `+ add connection`.
- *saved*: a mono spec sheet on `bg-bg` (`source`, `endpoint`, `model`, `auth` as `Bearer ••••a1b2`, `output` as `json_schema · seed 42` once tested, `egress`) with a status line (`reachable · 142 ms · 12 models`, or `not tested yet`), then `edit connection` and `test`.
- *editing*: `base url`, `api key`, `model`, optional `price in` / `price out` (per million tokens, only for the budget), the note `stored on the server, never shown again`, and `test`, `save` and `remove`. An empty key keeps the saved one only while the base url stays the same. `Enter` saves.
- *error*: the status line shows the first failed check in warn (`model list · no models (HTTP 404): …`). A pasted endpoint (`…/chat/completions`) is cut back to the base url on save.

`test` saves a form being edited first, then tests the saved connection: the key never comes from the request.

**Centre: the first screen.** A `max-w-560` block, `new evaluation` (`text-heading`), one muted line, then sections separated by `section_label`:
1. **checklist**: `01 judge`, `02 candidates`, `03 test cases`, `04 run evaluation` as status rows.
2. **route** (remote judge): three boxes joined by labelled arrows (`candidates · N · local ollama` → *answers* → `lmao · blind grading` → *prompt* → `judge · api.openai.com`, *grade* back), with `this machine` on the left and `internet · tls` on the right (`network · no tls` in warn for an http base url).
3. **preflight** (openai): status rows for model list, structured output, seed and temperature, token usage and rate limit (`not measured`); a failed model list skips the rest.
4. **budget · estimate for this run** (remote judge): four cells between hairlines, with the exact range in the tooltip: `judge calls`, `tokens`, `cost` (`–` without prices) and `sent out`. It follows the form with a short delay and disappears while the form is incomplete.
5. **request preview** (remote judge): a code box `grading call · no model names` with `copy as curl`. It is the real request of one grading call, built by the provider that sends it, with placeholders for the question, reference and answer; the key is redacted and the curl line reads `$API_KEY`.

`back to run` appears while a run is in progress, `open setup` while the panel is closed.

### 5.2 Running

The setup panel closes. Elapsed time and step count are in the topbar.

**Progress.** Four segments (`2fr 2fr 2fr 1fr`, gap 33): `01 reference`, `02 answers`, `03 grading`, `04 summary`. Each is a button-like block with the label (and an activity dot while running), `finished / total` and the phase duration on the right, and an `h-4 bg-line` track with an `h-4 bg-fg` fill. Segments fill independently, because a cloud judge grades while local candidates answer. Errors show as `· N err` in warn. Summary is one call: half width, no counter. An `sr-only` `progressbar` carries the overall value.

**Matrix.** One row for the reference (the judge's name muted beside it) and one per candidate; the row of the model in memory is `link`, waiting rows are muted. Columns: model (270px), one 52px column per question, time (80px, the model's total answering time). Cell states are in section 4. A local judge is `link` for the references and again for grading and the summary; a cloud judge from its first call until the summary.

**Columns fit the width.** The matrix shows as many question columns as fit (`ResizeObserver`), so wide windows or closed panels show more. When not all fit, the window follows the question in progress and each row gets edge counters (`‹ 6`, `8 ›`, warn if a hidden cell has an error). A line above the grid reads `24 questions · showing q07–q16`, with `follow current · on/off`, `‹ prev` and `next ›`; manual paging turns `follow current` off.

**Now.** The calls in flight as status rows (verb, label, timer). In cloud mode several can run at once.

**Load notice.** Shown only after the first call of a model load group has been `running` for about 8 seconds. It says loading is normal, makes no claim about VRAM, and is announced once through the live region.

**Stop and resume.** `stop` at the right end of the matrix label row asks `stop run?` (`stop` in warn, `keep going`) before the server is asked. The status becomes `stopping` with an info strip (the call in flight is not interrupted; a large local model can take up to 10 minutes). The run stops between two steps, unloads its models and keeps everything finished. The screen then shows `stopped`: an info strip with the steps done, `resume` and `back to setup`, and the unfinished steps as `stopped` cells. The run is saved after every step, so `resume` also works from the archive, after an error and after a server restart. The stream of a resumed run starts with the events of the finished steps, so rows fill the same way as in a live run. Only one run is in progress at a time.

**Errors.** A failed run shows a warn notice with `back to setup`, and `resume` when the server reported the failure. Rows in flight when the stream breaks become `error · interrupted`. A broken stream offers `reconnect`, which reopens the stream (the server replays the events from the start); if the run is still going, `resume` reconnects instead.

### 5.3 Results

**Header.** Run name (`text-heading`); on the right `resume` (unfinished runs), `export json csv md print`. Two tabs, `overview` and `answers`, with an anchor navigation of the open tab on their right. A run that did not finish shows a note and the label `recommended so far`.

**Overview**
- **01 summary**: the verdict (`recommended` or `no recommendation`, short model name, the rule in words) beside four key figures of the recommended model (mean score, pass rate, speed in c/s, median time); a muted `notes` row (the judge is also a candidate, questions without a reference, low confidence); `judge summary`, the judge text as Markdown, collapsed by default, with full model names replaced by short ones.
- **02 models**: one sortable table, one row per model: rank badge, model, `mean` (default sort, descending), `median`, `pass`, `c/s`, `t/s`, `time, s`, `length`, `score/GB`, `tok/pass`, `memory GB`, each numeric cell with a value bar. Clicking a header sorts by it. Definitions sit under the table. Wide tables scroll sideways with a sticky model column.
- **03 speed vs quality**: a scatter of mean score (y, fixed 0–100 so runs compare) against median chars/s (x, ticks at 1/2/5 × 10ⁿ). Points are rank badges with direct labels (`best score`, `recommended`, `fastest`). The quadrant faster and better than both medians is `bg-surface`, bounded by dashed median lines labelled inside the plot. A dashed Pareto line joins the models nobody beats on both axes; it is the only SVG. A one-row legend sits under the plot, models without a score or c/s are listed as "not plotted", and the plot has `role="img"` with a text summary.
- **04 details**: a 2×2 grid of panels with the same badges and model order, each with a title, a one-line explanation and a dashed median where it applies: `score / GB`; `tokens / correct` (lower is better, an outlier bar is cut with `axis cut`); `memory` (loaded size from `ollama ps`, filled for VRAM and outlined for RAM offload, with the GPU share when a model spills over); `tokens vs characters` (tokens/s against chars/s with two rays for the fewest and the most characters per token). Below, **answers by category**: stacked bars per model in five monochrome steps (errors in warn), a dashed 70% pass threshold and the pass share at the end.
- **05 hardest questions**: the five questions with the lowest mean score: question, mean, a range track (min–max with the mean as a tick), `passed n/N`, and the best model as a badge.
- **06 run**: a few muted lines on how the run was made (times, versions, judge and mode, counts, candidate and judge parameters), so a result can be reproduced.

**Answers**
- **01 scores**: a models × questions matrix with every score and a value bar. It scrolls sideways with a sticky model column. A model name jumps to its block below, a score to its answer; a missing result is a disabled cell. `err`, `?` and muted cells are explained in a legend.
- **02 answers**: a `per model` / `per question` tab. *Per model*: folded rows with `mean · median · pass · errors`; the best model starts open, an open row shows its metrics, answers by category and the first four answers, then `N more answers · show all`. *Per question*: one card per question, the first seven listed and the first two open, with a score scale (0–100, one tick per distinct score, taller when several models share it) and one eval block per model, best first, failed ones last (competition ranking: 1, 1, 3). Only one view is in the DOM at a time; an answer has the same id in both, and a jump first opens the folded row and any hidden answers.
- **03 reference answers**: one collapsed row per question (`q1 · en-fact-astronomy · provided`), the first three listed, then `show all`.

**Eval block.** Two columns, gap 33. Left (120px): label (question or model), score in `text-display font-thin`, `/ 100`, category. Right: first line (the question, or `rank 01 / 03`), muted notes, judge comment, `show answer` / `hide answer` and the answer box, which exists only while open. A failed block has a `border border-warn` frame, `err` instead of the score and the reason in warn.

### 5.4 Archive

A list in the right panel. Each item: `py-15 border-b border-line`, title in `text-subheading` (the open run is `text-fg` with a leading `size-6` filled marker, the others muted), then muted lines for date, `N models · N qs` and `judge: <full name>`. Newest first. A stopped or failed run has a fourth line (`stopped · 31 / 73 steps`) and can be opened and resumed. A run in progress is not in the archive, so it cannot be deleted. `rename` swaps the buttons for a field with `save` and `cancel` (an empty name restores the default; the name is stored in `meta.json`, run ids and export file names do not change). `delete` asks `delete this run?` with `delete` (warn) and `cancel`.

## 6. States

| Situation | Treatment |
|---|---|
| waiting for a model to load | one `running` state, plus the load notice after ~8 s |
| no models | warn notice with `reload`; status `no models found` |
| connection missing or failed | warn notice in the connection block; the checklist judge row is `error` |
| generation error | `err` cell, warn eval block, the matching grading step is `skipped` |
| judge error | `?` cell, warn eval block; the answer is kept but excluded from the scores |
| truncated answer | `*` after the score and a note; it can never count as a pass |
| no reference | muted cells and bars, `excluded from the scores` |
| unreadable run file | a warn message in the results area; nothing else breaks |
| loading | muted `loading…` |

Stop, stopped and failed runs are described in 5.2. Disabled controls use `bg-line text-fg-muted cursor-not-allowed` (primary) or muted text. The global focus style is a 1px `fg` outline with a 2px offset.

## 7. Accessibility

- One `sr-only aria-live="polite"` region announces the first event of each phase, the load notice (once per row), imports and the finish. Errors use `role="alert"`.
- Tabs follow the tablist pattern (ids `tab-<state>-<value>`, panel `panel-<state>`, arrows and Home/End).
- Everything clickable is a native button or link. Matrices, tables and charts have text equivalents (aria labels, `role="img"` with a summary). A matrix cell state is never carried by colour alone.
- Closed panels are `inert`; hotkeys do not fire while typing. Checkboxes use `:has()` (Firefox 121+, Safari 15.4+); the native input stays in the DOM.

## 8. Stream events

`/api/stream/<task_id>`. Every event except `info`, `completed` and `error` carries `phase`, `model`, `question` and `progress: {done, total}`. The row key is `phase:model:question`; for the reference phase the model is the judge, for the summary the question is empty. Progress is `total = Q × (1 + 2M) + 1` (M = unique candidates).

| Event | UI |
|---|---|
| `reference_start`, `reference_done` | reference row `running`, then `done` (meta = source) or `error` (graded without a reference) |
| `candidate_start` | group marker only |
| `answer_start`, `answer_done` | cell `answering`, then `answer ready` or `generation error`; a failure marks the grading step `skipped` at once |
| `grading_start`, `grading_done` | cell `grading`, then `graded` or `judge error` |
| `summary_start`, `summary_done` | the summary row |
| `cancelling`, `cancelled` | status `stopping`, then `stopped` (the archive is refreshed) |
| `completed` | `done = total`, archive refreshed; results open if the running screen is shown, otherwise the topbar offers `open results` |
| `error` | warn notice, `resume` is offered |
| `info` | not shown |

Durations come from event timestamps, so parallel calls are not added up. A duplicate `*_start` does not reset a running row and a finished row ignores later events. The stream is closed on the first `onerror`. The server sends a `: ping` comment every 15 seconds, so a closed connection fails a write and frees its thread.

## 9. Export and print

`json`, `csv` and `md` are download links to `/api/results/<id>/export?format=…`; `print` calls `window.print()`. CSV cells that look like formulas are defused and Markdown exports fence model output. Export and print controls are hidden when printing.

`@media print` (plain CSS, unlayered, so it wins over utilities) gives the tokens a light variant (`bg #ffffff`, `surface #f5f5f6`, `line #c9c9cf`, `fg #000000`, `fg-muted #55555a`, `link #0b5cad`, `warn #8a5a00`), the only place colours differ. It sets `print-color-adjust: exact` (otherwise bars and surfaces disappear), hides the header, panels and tabs, and lets the body flow across pages. Only the active tab and view are printed, so switch first. Closed `<details>` and answers that were not opened print closed, and a wide matrix is clipped at the page edge.

## 10. Not designed yet

- A queue of runs.
- A light theme.
- Responsive behaviour. Proposal: below ~1024px the panels become overlays (`absolute inset-y-0 z-10`) instead of columns.