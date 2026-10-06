# GridTweaks

Maintain a growing comparison gallery using SwarmUI's built-in Grid Generator. Capture the grid once, then add or remove **first-axis values** while keeping every other axis and all supplied generation settings fixed.

For example, put **Model** first and **Seed** second. A seed axis of `100, 101, .., 111` produces twelve images per model. Adding another model later generates its twelve images and adds them to the same gallery. Existing completed images are kept.

## Usage

1. Restart SwarmUI after placing this extension in `src/Extensions/SwarmUI-GridTweaks`. SwarmUI discovers and compiles the extension during startup.
2. Configure the normal generation settings and Grid Generator axes. Put the parameter whose values may change on the **first axis**. Other axes can use any supported core parameters, including prompt, seed, CFG scale, sampler, and additional model parameters.
3. Under the axes in Grid Generator, find **Create a running grid**. Enter a gallery name and click **Create & generate**. This saves the current setup, starts the first run, and opens the new gallery's controls in Running Grids automatically.
4. Follow progress in Running Grids and use **Open gallery ↗** beside the gallery title to view results. Results use the core grid viewer, including its axis selectors and image inspection.
5. Later, select the saved gallery under **Running Grids**. **Values to add** uses Grid Generator's editor, including model suggestions, value chips, keyboard completion, and **Fill**. Click an empty entry or type to find values. You can also paste values, or configure the first axis in Grid Generator and click **Copy first axis from Grid Generator**. Click **Run Missing Cells** (the main Generate button) or **Run missing / changed cells**: either saves the entered values before generating. **Add without running** saves them without starting generation.

When adding models, refresh SwarmUI's model list first. You can import the complete updated model list: existing entries are deduplicated. A previously deleted value is added as a new column at the end of the list and can be generated normally. Removing a model from the pasted list does not delete its existing results; use **Remove selected** for that.

Create new galleries in Grid Generator; Running Grids manages saved galleries. Create the running grid before generating an ordinary grid; existing ordinary-grid images are not imported.

Only the first axis is editable in the saved comparison. Changes in the main generation form are ignored unless explicitly selected under **Overrides for this run**. Create another gallery to change the saved baseline or remaining axes. **Run Missing Cells** checks every column, including existing models whose files changed when file tracking is enabled. Checkboxes beside columns select them for deletion, not generation. This extension captures configurations; it does not import image files from previously generated ordinary grids.

## Overrides for this run

To use a LoRA or another setting temporarily, change it in the normal generation form, then open **Overrides for this run** in the saved gallery. The panel compares **Saved** values with **This run** values. Click **Refresh differences** after editing the form, and check only the changes you want to use. Every difference starts unchecked. LoRA names, weights, text encoder weights, and section confinement share one checkbox so they stay together.

Click **Run Missing Cells** to apply the selected changes to all missing or changed cells generated during that run. Existing completed images are kept. The saved baseline, grid axes, and value identities are unchanged; normal image metadata records the actual generation settings. Clearing a setting in the form lets you disable it for this run, including removing saved LoRAs.

Selections clear when a run starts or you switch galleries. Later runs and retries use saved settings unless you select overrides again. If a selected value changes in the form before you run, generation stops so you can review and reselect it. A rejected request keeps your selections for retry. **Add without running**, deleting columns, and reordering do not apply overrides.

Grid axes, seeds, settings controlled by captured presets, and output controls cannot be overridden. This includes the entire LoRA group when any LoRA setting is controlled by an axis or preset. Other registered generation parameters, including extension settings such as Magic Prompt post-filters, use normal SwarmUI validation and permissions.

## Reordering columns

Under **Running Grids**, choose a saved gallery and find **Column order**. The numbered list matches the gallery's columns from left to right. Drag the six-dot grip beside a model (or other first-axis value), then drop at the highlighted line. You can move a column across multiple positions in one drag. Each drop saves automatically. Refresh an open gallery page to see the new order.

Dragging works with mouse, touch, and pen, and scrolls the tool pane near its edges. Press **Escape** or drop outside the list to cancel. For keyboard control, focus a grip and use **Up/Down** to move one position or **Home/End** to move to an end.

Reordering keeps all saved images, seeds, and settings; it does not generate images. Grips are disabled while the gallery is running or has fewer than two columns.

## Similarity on the generated page

1. Restart SwarmUI after installing this version. Select an existing gallery in **Running Grids** and find the **Image similarity** card.
2. Click **Analyze similarity** in the always-visible **Image similarity** card. When setup is needed, it downloads approximately 250 MB of AlexNet weights and installs `lpips==0.1.4` into this extension's private cache. Setup requires **Install Features** permission; later analyses use the installed dependencies without reinstalling. No image generation is started.
3. Once analysis finishes, open or reload the gallery page. Under **View**, choose **Similarity chain**, **Saved order**, or **Similarity to selected column** directly. Reference sorting defaults to the first saved column; **Reference column** lets you choose another. Choosing **None — restore previous order** returns to the previous chain or saved order. Sorting changes this view without changing saved column order or image paths.
4. The column table is always visible inside the expanded **View** panel and has its own scrollbar. Click **View** to collapse or expand the entire panel. Show or hide columns using their names or checkboxes. Drag a grip to move a column; this switches to **Custom order** and saves the arrangement only in this browser. Grips also support Up/Down and Home/End keys. **Saved order** restores the gallery's published order. **Show all columns** restores visibility, and **Show row scores** adds scores beneath images.
5. Set **Images per row** to fit that many images across the screen, up to the number of currently visible columns. The limit follows column visibility and axis changes. Remaining columns are available by scrolling sideways; matching rows stay aligned. Row labels use only the width their text needs, with long values wrapping. Clear the input or select **Reset size** to restore the core viewer's image sizing. The controls stay centered when scrolling horizontally, and the score table headers stay above the scrolling column names.

Column order, custom arrangements, image size, reference column, visibility, row scores, and the expanded/collapsed View panel are remembered in this browser separately for each gallery. Removed column keys are ignored; newly added columns start with their default visibility. If browser storage is blocked, controls still work for the current visit. Selecting a reference reveals it; you can subsequently hide it while continuing to compare against its images.

Opening an image shows a persistent badge in the viewer's top-left corner with its first-axis value and remaining axis values, such as model and seed. The badge follows arrow-key navigation, including sorted or hidden columns. Model filenames appear without the folder and file extension; hover or tap the name to see the full value.

After updating the extension, restart SwarmUI, choose the saved gallery in Running Grids, and click **Refresh gallery page** beside **Open gallery** and **Delete gallery…**. Reload its open page to get the new controls. This republishes the viewer using existing scores without generating images, running analysis, or changing automatic analysis preferences.

Enable **Update after each generation run** to refresh scores automatically, or click **Analyze similarity** to refresh manually. Manual analysis preserves the checkbox setting. **Stop this gallery** also stops scoring, keeping the previous completed analysis. Appending, removing, reordering, and generation are blocked while that gallery is being analyzed. Analysis is serialized across galleries. LPIPS uses the local backend's configured GPU when CUDA is available. The worker processes one image at a time and caches at most 12 prepared feature entries. It falls back to CPU if GPU initialization fails or scoring exhausts GPU memory, reusing completed row checkpoints. Progress reports whether LPIPS is using GPU or CPU.

GPU scoring uses full FP32 precision, without TF32 or mixed precision, to retain sensitivity to very similar images. The metric and cache identity are unchanged by device selection, so existing CPU scores remain reusable with the same weights and dependencies. Small floating-point differences between CPU and GPU calculations are possible.

The worker uses the Python runtime of a running local ComfyUI backend. That runtime must already contain compatible `torch`, `torchvision`, `numpy`, `Pillow`, `scipy`, `tqdm`, and `pip`. Setup installs only LPIPS into this extension; it does not change backend packages. For remote backends, set the server environment variable `RUNNING_GRID_PYTHON` to a local Python executable with those dependencies. If dependency or weight initialization fails, the same **Analyze similarity** button retries setup on the next click. Scoring errors do not cause unnecessary reinstallation.

### What the scores mean

- **LPIPS** uses the upstream learned AlexNet perceptual metric, version 0.1. Lower distance means more similar appearance; zero means identical metric features. It is not a probability or a percentage.
- Images are EXIF-oriented, composited onto white if transparent, and resized without distortion to at most 512 pixels on the longest side. Small full-resolution differences can disappear at this scale. Images must have equal original dimensions. Animated images, unsupported formats, missing files, and images too small or narrow for LPIPS remain unscored.
- **Difference** is the average LPIPS distance between matching images in the **Column** and **Compared with** columns. Lower means more alike. It averages across matching grid rows, not across neighboring entries in the checkbox list. A row means the exact combination of **every axis after the first**, including axes hidden by the viewer. Different seeds or other row coordinates are never compared. Incomplete averages are marked **partial**; hover over a score for the number of matching pairs.
- **Similarity chain** starts with the closest pair overall, measured by mean LPIPS across every matching row. It then repeatedly appends the closest unused column to the last column. Either column in the initial pair can come first; the orientation with the better available next link wins. Stable column keys break ties. No cutoffs apply. This is a greedy chain, not a globally optimal arrangement or a least-to-most ranking: later links can be weaker, and similarity is not transitive.
- **Similarity to selected column** places the selected column first, revealing it if it was hidden. Every other fully scored column is sorted by increasing mean LPIPS against that column across all matching rows. Incomplete or unscored comparisons follow in saved order. Scores and row badges use the selected column as their reference throughout. Selecting a different column immediately changes the order; no scoring run is needed.
- Only fully scored pairs guide ordering. If an endpoint has no scored link to any remaining column, a new chain starts with the closest remaining pair. Unscored leftovers retain saved order at the end. Missing scores never count as zero distance. Ordering uses all saved columns; hiding columns updates adjacent comparisons without rebuilding the chain. The score table names both columns in each comparison and reports incomplete coverage. Row scores compare the same row in those columns.
- Visually similar outputs do not establish that two model files have identical weights or were generated with identical settings.

Scores are cached by image SHA-256, exact scoring weights, dependency versions, and preprocessing version. Adding a column computes its new pairs while retaining old pair scores; reordering does not invalidate scores. Older cached LPIPS scores and completed setup remain valid; retired measurements are dropped when caches and gallery pages are refreshed. Replacing or deleting a generated cell immediately excludes its old published scores. A completed analysis prunes unused cached pairs. Private jobs, packages, weights, and scores live under `.cache/similarity/` inside the extension. Published results contain measurements and setting-match flags, without prompt text or server file paths.

Analysis supports up to 1,000,000 matching-row pairs per gallery. Existing galleries work without regenerating images. The generated page remains a portable static page; reload it after an analysis finishes to load new scores.

Metric reference: [LPIPS implementation and paper](https://github.com/richzhang/PerceptualSimilarity).

## Removing results

To delete an entire saved gallery, select it and click **Delete gallery…** beside **Refresh gallery page**. The confirmation names the gallery and shows its saved cell count. Deletion permanently removes its saved settings, published page, all gallery images (including older revisions), and private similarity results. Other galleries, model files, ordinary image history, and shared similarity weights remain intact. Stop generation or similarity analysis before deleting a gallery.

Select first-axis values and click **Remove selected**. After confirmation, the values disappear from the published grid and their generated files are deleted from this gallery. This never deletes model weights, ordinary image history, or another gallery's images.

Deletion removes the entry entirely from both the management list and the published gallery. To use that value again, enter it in **Values to add** and run normally; its images are generated anew using the saved settings and any selected run overrides. Removing every value produces an empty gallery until new values are added.

Older comparisons that contain entries marked `(removed)` are normalized when loaded: those entries and their completion records are discarded. They no longer appear in the list or block adding the same values again. The next save persists the cleaned definition.

## Persistence and generation

- Gallery definitions, captured inputs, and successful cell records are stored in the current user's SwarmUI database. Reference inputs are included in the captured generation request.
- Published pages and images live under the user's output directory at `Grids/RunningGrid/<user digest>/<gallery ID>/`.
- Stable cell paths use full parameter identities, not abbreviated model names or list positions. Reordering a model list does not regenerate its images or confuse models with similar names.
- A cell counts as complete only after core reports saving its output. Failed, missing, or unfinished cells are retried. A server restart or browser refresh does not lose completed cells.
- **Stop this gallery** interrupts its generation claim. Editing and deletion are blocked until the run finishes stopping.
- While the selected gallery runs, previews and completed images appear in SwarmUI's normal image batch column. Starting a run honors the normal automatic batch-clearing preference. Refreshing the gallery reconnects to the current server run without duplicating results already displayed by this browser.
- Random seed controls supplied as `-1`, including wildcard and variation seeds, are locked when captured. Random seed axis values are also locked independently.
- Capture preserves core's metadata, generation ordering, and continue-on-error choices. Output is always a persistent web gallery, with one output per cell as in the core grid tool.
- The optional **Regenerate results when their local model files change** setting compares file size and modification time. It regenerates only affected first-axis values. It does not hash model contents or detect changes that preserve both attributes. Superseded revisions remain on disk until that value is removed.
- Named presets are checked against their captured parameter maps before each run. Changed or missing presets block the run rather than silently mixing settings. Presets with random seeds require explicit seed values before capture.
- The extension uses current SwarmUI generation code and model files. Locked inputs do not freeze backend versions, wildcard file contents, or external resources.

Grid permissions control reading, saving, and generation. Removing generated files additionally requires SwarmUI's **User Delete Image** permission. Galleries are limited to eight axes and 100,000 combinations.

## Development

The projects, assembly, and C# namespace use `GridTweaks`; `SwarmUI-GridTweaks` is the repository folder name. The build and test layout follows the sister VideoStages extension:

- `frontend/`: strict TypeScript sources and co-located Jest unit tests.
- `Assets/`: CSS and checked-in JavaScript bundles generated by esbuild. Edit TypeScript, then regenerate the bundles; SwarmUI loads these files without Node.js.
- `Tests/`: xUnit tests referencing the extension project and the existing SwarmUI host assemblies.
- `browser-tests/`: Playwright tests using a mocked SwarmUI shell and the real core grid viewer.
- `Similarity/tests/`: Python tests for the similarity worker.
- `scripts/`: bundle builder, Python test runner, and locked Python test dependencies.

Keep the extension under SwarmUI's `src/Extensions/` directory. The .NET 8 projects use `src/bin/live_release/SwarmUI.dll` and its dependencies, produced by an existing SwarmUI build. Tests compile the extension itself without rebuilding core or invoking generation on a GPU. `GridTweaks.sln` contains the extension; `GridTweaks.Tests.sln` adds its tests. Optional, ignored `Directory.Build.local.props` files can customize local build paths.

Install Node.js 20 or newer and uv, then initialize dependencies and test weights once:

```sh
npm ci
uv sync --project scripts/python-tests --locked
uv run --project scripts/python-tests --locked python -c "from pathlib import Path; from Similarity.worker import initialize; p = Path('.cache/test-weights').resolve(); p.mkdir(parents=True, exist_ok=True); initialize(p, True)"
```

The Python environment uses CPU PyTorch wheels on Linux and Windows. The weight setup downloads AlexNet weights (about 250 MB) into the ignored `.cache/test-weights/` directory. To run with an existing compatible Python environment, set `GRIDTWEAKS_TEST_PYTHON` to its Python executable and initialize the same test weights with that executable. CUDA parity is checked when that environment has a GPU and skips otherwise.

Run the standard checks from this extension directory:

```sh
./run-tests
```

This runs Biome, strict TypeScript checks, Jest, regenerates both JavaScript bundles, then runs the C# and Python suites. Individual commands:

```sh
npm run build             # Check, test, and rebuild the checked-in bundles
npm run check             # Biome and TypeScript checks
npm test                  # Frontend unit tests
npm run test:coverage     # Frontend coverage
npm run fix               # Apply Biome formatting and safe fixes

dotnet test GridTweaks.Tests.sln
./scripts/run-python-tests
```

Browser checks run separately:

```sh
npx playwright install chromium
npm run test:browser
# Optional visible browser:
npm run test:browser:headed
```

The browser command rebuilds the JavaScript and generates a fresh static viewer fixture through the C# suite before running Playwright. No live server is required. If local MSBuild settings relocate test output, set `GRIDTWEAKS_VIEWER_FIXTURE` to the generated `SimilarityViewer` directory. Tests cover management flows, previews and final images through core's generation handler, similarity ordering, restored preferences, cell identities, filtering, and mobile controls. Failure traces and screenshots are written under `test-results/`; the HTML report is under `playwright-report/`.

Similarity tests use synthetic images and compare feature reuse against upstream LPIPS. They cover cache compatibility, content changes, appends, removals, missing images, overrides, setup recovery, device selection, and memory fallback. Live generation still needs verification in a running SwarmUI instance.
