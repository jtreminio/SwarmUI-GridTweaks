# GridTweaks

Build comparison galleries you can keep adding to in SwarmUI. Compare models, prompts, samplers, or other settings without starting the whole comparison over.

## Features

- **Grow a saved comparison.** Add new columns later using the same saved settings and seeds.
- **Generate only what’s needed.** Fill missing results, resume interrupted runs, and optionally regenerate results when model files change.
- **Try temporary changes.** Apply a LoRA or other selected settings for one run while keeping your saved setup and completed images.
- **Compare by visual similarity.** Arrange similar columns together or rank them against a column you choose. Show scores for individual images or entire columns.
- **Make large galleries easier to browse.** Drag columns to reorder them, hide columns, and adjust how many images fit across the screen. View preferences are remembered per gallery in your browser.
- **Clean up results.** Remove unwanted columns or whole galleries, including their images. Your model files are kept.

## Get started

Install the extension in `src/Extensions/SwarmUI-GridTweaks` and restart SwarmUI.

1. Set up your generation settings and axes in **Grid Generator**. Put the setting you want to expand later on the **first axis**—for example, Model first and Seed second.
2. Under **Create a running grid**, enter a name and click **Create & generate**.
3. Use **Running Grids** to manage the comparison and **Open gallery** to browse it.
4. To expand it, enter **Values to add** and click **Run missing / changed cells**. Completed images are kept.

Only the first axis can be edited later. To change the saved setup or other axes, create another gallery. Existing ordinary grids cannot be imported.

## Similarity sorting

Click **Analyze similarity**, then open or reload the gallery. Under **View**, choose:

- **Similarity chain** to place visually similar columns next to one another.
- **Similarity to selected column** to compare everything against your chosen **Reference column**.

Scores compare matching rows; lower means more alike. Enable **Update after each generation run** to keep scores current automatically.

First-time analysis downloads about 250 MB and requires **Install Features** permission.

After an extension update, restart SwarmUI, click **Refresh gallery page** in Running Grids, and reload the gallery to get the latest controls.
