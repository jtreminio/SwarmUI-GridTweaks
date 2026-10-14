import { expect, type Page, test } from "@playwright/test";
import type {
    GridViewerAxis,
    RunningGridSimilarityPage,
    SimilarityData,
} from "../frontend/similarity-page";
import { assetPath, fixturePath } from "./paths";

declare const rawData: { axes: GridViewerAxis[] };
declare const runningGridSimilarityData: SimilarityData;
declare const runningGridSimilarityPage: RunningGridSimilarityPage;
declare const popoverLastImg: HTMLImageElement;
declare function setShowVal(axis: string, value: string, show: boolean): void;
declare function canShowVal(axis: string, value: string): boolean;
declare function fillTable(): void;
declare function getCurrentSelectedAxis(prefix: "x" | "y"): string;

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.unrouteAll({ behavior: "wait" });
    await page.route("http://running-grid.test/**", (route) =>
        route.fulfill({
            path: fixturePath(new URL(route.request().url()).pathname.slice(1)),
        }),
    );
    await page.route("**/*.png", (route) =>
        route.fulfill({
            body: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQAAAADcA+lXAAAAjElEQVR4nO3MMQ0AAAwDoPo33YrYtQQEkB5FIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKB4HcwNvqHcrKrBEkAAAAASUVORK5CYII=",
                "base64",
            ),
            contentType: "image/png",
        }),
    );
    await page.route("**/*.metadata.js", (route) =>
        route.fulfill({ body: "", contentType: "text/javascript" }),
    );
    await page.route("**/similarity-page.js?*", (route) =>
        route.fulfill({
            path: assetPath("similarity-page.js"),
            contentType: "text/javascript",
        }),
    );
    await page.route("**/similarity-page.css?*", (route) =>
        route.fulfill({
            path: assetPath("similarity-page.css"),
            contentType: "text/css",
        }),
    );
});

test.afterEach(async ({ page }) => {
    expect(pageErrors.get(page)).toEqual([]);
});

async function openViewer(page: Page) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("http://running-grid.test/index.html");
    return {
        order: page.locator(".running-similarity-order"),
        reference: page.locator(".running-similarity-reference"),
        original: await page.evaluate(() =>
            rawData.axes[0].values.map((value) => value.key),
        ),
    };
}

function visiblePaths(page: Page) {
    return page
        .locator(".table_img")
        .evaluateAll((images: HTMLImageElement[]) =>
            images.map((image) => image.dataset.img_path!).sort(),
        );
}

async function checkComparisons(page: Page) {
    return page.evaluate(() => {
        const visible = rawData.axes[0].values.filter((value) =>
            canShowVal("axis0", value.key),
        );
        const rows = [
            ...document.querySelectorAll<HTMLTableRowElement>(
                ".running-similarity-scores tbody tr",
            ),
        ].filter((row) => row.dataset.reference);
        if (rows.length !== visible.length - 1) {
            throw new Error("Wrong number of adjacent column comparisons.");
        }
        for (let i = 1; i < visible.length; i++) {
            const column = visible[i].key,
                reference = visible[i - 1].key;
            const pair = runningGridSimilarityData.pairs.find(
                (pair) =>
                    [pair.a, pair.b].includes(column) &&
                    [pair.a, pair.b].includes(reference),
            )!;
            const mean =
                pair.rows.reduce((sum, row) => sum + row.lpips, 0) /
                pair.rows.length;
            const actual = rows[i - 1];
            if (
                actual.dataset.column !== column ||
                actual.dataset.reference !== reference ||
                actual.cells[2].textContent !== visible[i].title ||
                actual.cells[3].textContent !== visible[i - 1].title ||
                actual.cells[4].textContent !== mean.toFixed(5)
            ) {
                throw new Error(
                    "Aggregate comparison does not describe adjacent visible columns.",
                );
            }
            for (const image of document.querySelectorAll<HTMLImageElement>(
                ".table_img",
            )) {
                const [key, ...coordinates] =
                    image.dataset.img_path!.split("/");
                if (key !== column) {
                    continue;
                }
                const score = pair.rows.find(
                    (row) => row.key === coordinates.join("/"),
                )!;
                const badge = image.parentElement!.querySelector<HTMLElement>(
                    ".running-similarity-badge",
                )!;
                if (
                    badge.dataset.reference !== reference ||
                    !badge.textContent!.includes(
                        `LPIPS ${score.lpips.toFixed(5)}`,
                    ) ||
                    !badge.textContent!.startsWith("vs previous column")
                ) {
                    throw new Error(
                        "Image badge compares the wrong column or row.",
                    );
                }
            }
        }
    });
}

async function checkImageIdentity(page: Page, path: string) {
    await page.waitForFunction((path) => {
        const badge = document.querySelector<HTMLElement>(
            ".running-grid-image-identity",
        )!;
        return badge && popoverLastImg.dataset.img_path! === path;
    }, path);
    await page.evaluate((path) => {
        const parts = path.split("/");
        const values = rawData.axes.map(
            (axis, index) =>
                axis.values.find((value) => value.key === parts[index])!,
        );
        const badge = document.querySelector<HTMLElement>(
            ".running-grid-image-identity",
        )!;
        const coordinates = rawData.axes
            .slice(1)
            .map((axis, index) => `${axis.title} ${values[index + 1].title}`)
            .join(" · ");
        if (
            document.querySelectorAll(".running-grid-image-identity").length !==
                1 ||
            badge.querySelector<HTMLElement>(".running-grid-image-name")!
                .title !== values[0].title ||
            badge.querySelector<HTMLElement>(".running-grid-image-coordinates")!
                .textContent !== coordinates
        ) {
            throw new Error(
                "Full-image badge does not identify the displayed cell.",
            );
        }
    }, path);
}

test("persists the collapsed view panel", async ({ page }) => {
    await openViewer(page);
    if (!(await page.locator(".running-similarity-scores").isVisible())) {
        throw new Error("The score table should be visible by default.");
    }
    await page.locator(".running-similarity-summary").click();
    await page.waitForFunction(
        () =>
            JSON.parse(
                localStorage.getItem(runningGridSimilarityPage.storageKey)!,
            ).panelOpen === false,
    );
    await page.reload();
    if (
        (await page.locator(".running-similarity-toolbar").isVisible()) ||
        (await page.locator(".running-similarity-scores").isVisible()) ||
        !(await page.locator(".running-similarity-summary").isVisible())
    ) {
        throw new Error(
            "Collapsing the View panel did not hide its contents or persist through reload.",
        );
    }
    await page.locator(".running-similarity-summary").click();
});

test("persists row visibility across reloads and axis swaps, including all rows hidden", async ({
    page,
}) => {
    const { order, original } = await openViewer(page);
    const paths = await visiblePaths(page);
    const rowAxis = await page.evaluate(() => {
        const index = rawData.axes.findIndex(
            (axis) => axis.id === getCurrentSelectedAxis("y"),
        );
        return { ...rawData.axes[index], index };
    });
    const rowChecks = page.locator(".running-similarity-row-visible");
    await expect(rowChecks).toHaveCount(rowAxis.values.length);
    const hiddenRow = rowAxis.values[0].key;
    const rowCheck = page.locator(
        `.running-similarity-row-visible[value="${hiddenRow}"]`,
    );
    await rowCheck.uncheck();
    const remainingPaths = paths.filter(
        (path) => path.split("/")[rowAxis.index] !== hiddenRow,
    );
    await expect.poll(() => visiblePaths(page)).toEqual(remainingPaths);
    await page.reload();
    await expect(rowCheck).not.toBeChecked();
    await expect.poll(() => visiblePaths(page)).toEqual(remainingPaths);
    await order.selectOption("chain");
    await expect.poll(() => visiblePaths(page)).toEqual(remainingPaths);
    await page.evaluate((rowAxisId) => {
        document.getElementById(`x_${rowAxisId}`)!.click();
        document.getElementById(`y_${rawData.axes[0].id}`)!.click();
    }, rowAxis.id);
    await expect(rowChecks).toHaveCount(original.length);
    await rowChecks.first().uncheck();
    await expect(
        page.locator(".running-similarity-visible").first(),
    ).not.toBeChecked();
    await page
        .getByRole("button", { name: "Show all rows", exact: true })
        .click();
    await page.evaluate((rowAxisId) => {
        document.getElementById(`x_${rawData.axes[0].id}`)!.click();
        document.getElementById(`y_${rowAxisId}`)!.click();
    }, rowAxis.id);
    await expect(rowCheck).not.toBeChecked();
    await expect.poll(() => visiblePaths(page)).toEqual(remainingPaths);
    for (const checkbox of await rowChecks.all()) {
        await checkbox.uncheck();
    }
    await expect(page.locator(".table_img")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".table_img")).toHaveCount(0);
    await page
        .getByRole("button", { name: "Show all rows", exact: true })
        .click();
    await expect.poll(() => visiblePaths(page)).toEqual(paths);
    await expect(
        page.getByRole("button", { name: "Show all rows", exact: true }),
    ).toBeDisabled();
});

test("connects similarity orders, references and visible-column scores to the grid", async ({
    page,
}) => {
    const { order, original } = await openViewer(page);
    await expect(order.locator('option[value="chain"]')).toBeEnabled();
    const paths = await visiblePaths(page);
    await order.selectOption("saved");
    await order.selectOption("reference");
    if (
        (await page.locator(".running-similarity-reference").inputValue()) !==
            original[0] ||
        (await page.evaluate(() => rawData.axes[0].values[0].key)) !==
            original[0]
    ) {
        throw new Error(
            "Selected-model order is not directly available with the first model as default.",
        );
    }
    await order.selectOption("chain");
    await expect
        .poll(() =>
            page.evaluate(() =>
                rawData.axes[0].values.map((value) => value.key),
            ),
        )
        .toEqual([original[0], original[2], original[1], original[3]]);
    await expect
        .poll(() => visiblePaths(page), "Sorting changed cell identities.")
        .toEqual(paths);
    if (
        (await page.locator(".running-similarity-reference").inputValue()) !==
        ""
    ) {
        throw new Error("Reference selection must default to None.");
    }
    await page.locator(".running-similarity-badges").check();
    await page.waitForFunction(
        () =>
            document.querySelectorAll(".running-similarity-badge").length ===
            48,
    );
    await checkComparisons(page);
    if (
        (await page
            .locator(".running-similarity-badge", { hasText: /^First column$/ })
            .count()) !== 12
    ) {
        throw new Error("First column must have no predecessor.");
    }
    const beforeReference = await page.evaluate(() =>
        JSON.stringify(rawData.axes[0].values.map((value) => value.key)),
    );
    const reference = page.locator(".running-similarity-reference");
    const chooseReference = async (key: string) => {
        if (key && (await order.inputValue()) !== "reference") {
            await order.selectOption("reference");
        }
        await reference.selectOption(key);
    };
    const checkReference = async (key: string, expected: number[]) => {
        if (
            (await order.inputValue()) !== "reference" ||
            (await reference.inputValue()) !== key ||
            (await page
                .locator(".running-similarity-badge", {
                    hasText: /^Reference$/,
                })
                .count()) !== 12
        ) {
            throw new Error(
                "Selected-model controls or badges are inconsistent.",
            );
        }
        await expect
            .poll(() =>
                page.evaluate(() =>
                    rawData.axes[0].values.map((value) => value.key),
                ),
            )
            .toEqual(expected.map((index) => original[index]));
        await page.evaluate((key) => {
            const column = rawData.axes[0].values[1].key;
            const pair = runningGridSimilarityData.pairs.find(
                (pair) =>
                    [pair.a, pair.b].includes(key) &&
                    [pair.a, pair.b].includes(column),
            )!;
            const row = document.querySelector<HTMLTableRowElement>(
                `.running-similarity-scores tr[data-column="${column}"]`,
            )!;
            const mean =
                pair.rows.reduce((sum, score) => sum + score.lpips, 0) /
                pair.rows.length;
            if (
                row.dataset.reference !== key ||
                row.cells[4].textContent !== mean.toFixed(5)
            ) {
                throw new Error("Scores do not match the selected reference.");
            }
            const image = [
                ...document.querySelectorAll<HTMLImageElement>(".table_img"),
            ].find((image) =>
                image.dataset.img_path!.startsWith(`${column}/`),
            )!;
            const coordinates = image.dataset
                .img_path!.split("/")
                .slice(1)
                .join("/");
            const score = pair.rows.find((row) => row.key === coordinates)!;
            const badge = image.parentElement!.querySelector<HTMLElement>(
                ".running-similarity-badge",
            )!;
            if (
                badge.dataset.reference !== key ||
                !badge.textContent!.includes(`LPIPS ${score.lpips.toFixed(5)}`)
            ) {
                throw new Error("Selected-model badge compares the wrong row.");
            }
        }, key);
        await expect
            .poll(
                () => visiblePaths(page),
                "Selected-model ordering changed image identities.",
            )
            .toEqual(paths);
    };
    await chooseReference(original[1]);
    await checkReference(original[1], [1, 3, 0, 2]);
    await chooseReference(original[2]);
    await checkReference(original[2], [2, 0, 1, 3]);
    await reference.selectOption("");
    if (
        (await order.inputValue()) !== "chain" ||
        beforeReference !==
            (await page.evaluate(() =>
                JSON.stringify(
                    rawData.axes[0].values.map((value) => value.key),
                ),
            ))
    ) {
        throw new Error("None failed to restore the previous chain.");
    }
    await checkComparisons(page);
    await order.selectOption("saved");
    await chooseReference(original[3]);
    await checkReference(original[3], [3, 1, 0, 2]);
    await reference.selectOption("");
    if ((await order.inputValue()) !== "saved") {
        throw new Error("None failed to restore Saved order.");
    }
    if (
        JSON.stringify(original) !==
        (await page.evaluate(() =>
            JSON.stringify(rawData.axes[0].values.map((value) => value.key)),
        ))
    ) {
        throw new Error("Saved column order was not restored.");
    }
    await checkComparisons(page);
    await chooseReference(original[2]);
    await order.selectOption("chain");
    if (
        (await reference.inputValue()) !== "" ||
        (await order
            .locator('[value="reference"]')
            .evaluate((option: HTMLOptionElement) => option.disabled))
    ) {
        throw new Error("Choosing a column order retained the model override.");
    }
    await checkComparisons(page);
    await chooseReference(original[1]);
    await order.selectOption("saved");
    if (
        (await reference.inputValue()) !== "" ||
        JSON.stringify(original) !==
            (await page.evaluate(() =>
                JSON.stringify(
                    rawData.axes[0].values.map((value) => value.key),
                ),
            ))
    ) {
        throw new Error(
            "Saved order did not clear the selected model and restore the original columns.",
        );
    }
    await page.evaluate(() => {
        document.getElementById("x_axis1")!.click();
        document.getElementById("y_axis0")!.click();
    });
    await order.selectOption("chain");
    if (
        !(await page.evaluate(
            () =>
                getCurrentSelectedAxis("x") === "axis0" &&
                getCurrentSelectedAxis("y") === "axis1",
        ))
    ) {
        throw new Error(
            "Similarity ordering failed to restore model columns after an axis swap.",
        );
    }
    await page.waitForFunction(
        () =>
            document.querySelectorAll(".running-similarity-badge").length ===
            48,
    );
    await checkComparisons(page);
    const hidden = await page.evaluate(() => rawData.axes[0].values[1].key);
    await page
        .locator(`.running-similarity-visible[value="${hidden}"]`)
        .uncheck();
    await page.waitForFunction(
        () =>
            document.querySelectorAll<HTMLImageElement>(".table_img").length ===
                36 &&
            document.querySelectorAll<HTMLTableRowElement>(
                ".running-similarity-scores tbody tr",
            ).length === 4,
    );
    await checkComparisons(page);
    await order.selectOption("saved");
    await checkComparisons(page);
    await page
        .locator(`.running-similarity-visible[value="${hidden}"]`)
        .check();
    await order.selectOption("chain");
    await checkComparisons(page);
    await page.evaluate((key) => {
        setShowVal("axis0", key, false);
        document.getElementById("x_axis1")!.click();
        document.getElementById("y_axis0")!.click();
        fillTable();
    }, original[1]);
    await chooseReference(original[1]);
    await page.waitForFunction(
        () =>
            document.querySelectorAll<HTMLImageElement>(".table_img").length ===
            48,
    );
    await checkReference(original[1], [1, 3, 0, 2]);
    if (
        !(await page.evaluate(
            () =>
                getCurrentSelectedAxis("x") === "axis0" &&
                getCurrentSelectedAxis("y") === "axis1",
        ))
    ) {
        throw new Error("Selecting a model did not restore model columns.");
    }
});

for (const mode of ["chain", "reference"]) {
    test(`${mode} order preserves view preferences across reloads`, async ({
        page,
    }) => {
        const { order, reference, original } = await openViewer(page);
        await order.selectOption(mode);
        await page.locator(".running-similarity-badges").check();
        if (
            (await page.locator(".running-similarity-visible").count()) !==
            original.length
        ) {
            throw new Error(`Missing visibility checkboxes in ${mode} order.`);
        }
        await page
            .locator(`.running-similarity-visible[value="${original[3]}"]`)
            .uncheck();
        await page.waitForFunction(
            () =>
                document.querySelectorAll<HTMLImageElement>(".table_img")
                    .length === 36,
        );
        const preference = await page.evaluate(() => ({
            order: runningGridSimilarityPage.order.value,
            reference: runningGridSimilarityPage.reference.value,
            keys: rawData.axes[0].values.map((value) => value.key),
            badges: runningGridSimilarityPage.badges.checked,
        }));
        await page.reload();
        if (
            (await order.inputValue()) !== mode ||
            !(await page
                .locator(".running-similarity")
                .evaluate((element: HTMLDetailsElement) => element.open)) ||
            !(await page.locator(".running-similarity-badges").isChecked()) ||
            (await page
                .locator(`.running-similarity-visible[value="${original[3]}"]`)
                .isChecked()) ||
            JSON.stringify(preference.keys) !==
                (await page.evaluate(() =>
                    JSON.stringify(
                        rawData.axes[0].values.map((value) => value.key),
                    ),
                )) ||
            preference.reference !== (await reference.inputValue())
        ) {
            throw new Error(
                `Refreshing lost view preferences in ${mode} order.`,
            );
        }
        await page.locator(".running-similarity-show-all").click();
        await expect(page.locator(".table_img")).toHaveCount(48);
    });
}

test("image identity follows navigation through reordered and hidden columns", async ({
    page,
}) => {
    const { original } = await openViewer(page);
    await page.locator(".running-similarity-grip").first().focus();
    await page.keyboard.press("End");
    await page
        .locator(`.running-similarity-visible[value="${original[3]}"]`)
        .uncheck();
    await expect(page.locator(".table_img")).toHaveCount(36);
    const visiblePaths = await page
        .locator(".table_img")
        .evaluateAll((images: HTMLImageElement[]) =>
            images.map((image) => image.dataset.img_path!),
        );
    await page.locator(".table_img").first().click();
    await checkImageIdentity(page, visiblePaths[0]);
    const imageName = page.locator(".running-grid-image-name");
    const fullName = await imageName.getAttribute("title");
    if (
        (await imageName.textContent())!.includes("/") ||
        (await imageName.textContent())!.endsWith(".safetensors")
    ) {
        throw new Error("Full-image badge did not shorten the model filename.");
    }
    await imageName.click();
    if (
        (await imageName.textContent()) !== fullName ||
        !(await page.locator("#image_info_modal").isVisible())
    ) {
        throw new Error(
            "Tapping the badge did not reveal the full name while keeping the viewer open.",
        );
    }
    await imageName.click();
    for (const [key, index] of [
        ["ArrowRight", 1],
        ["ArrowDown", 4],
    ] as const) {
        await page.keyboard.press(key);
        await checkImageIdentity(page, visiblePaths[index]);
    }
    await page.keyboard.press("Escape");
    if (await page.locator(".running-grid-image-identity").isVisible()) {
        throw new Error(
            "Full-image badge remained visible after closing the viewer.",
        );
    }
});

test("keeps score headers above names and preserves scroll and focus when toggling columns", async ({
    page,
}) => {
    await openViewer(page);
    await page
        .locator(".running-similarity-scroll")
        .evaluate((scroll: HTMLElement) => {
            scroll.style.maxHeight = "100px";
            scroll.scrollTop = 80;
        });
    await page.locator(".running-similarity-scroll").scrollIntoViewIfNeeded();
    const headerPaint = await page
        .locator(".running-similarity-scores th")
        .nth(2)
        .evaluate((header) => {
            const box = header.getBoundingClientRect();
            const top = document.elementFromPoint(
                box.x + 10,
                box.y + box.height / 2,
            );
            return {
                onTop: top === header || header.contains(top),
                background: getComputedStyle(header).backgroundColor,
            };
        });
    if (!headerPaint.onTop || headerPaint.background === "rgba(0, 0, 0, 0)") {
        throw new Error(
            "The Column header does not paint above scrolling model names.",
        );
    }
    const lastColumnName = page
        .locator(".running-similarity-column-name")
        .last();
    for (const checked of [false, true]) {
        await lastColumnName.scrollIntoViewIfNeeded();
        const beforeScroll = await page
            .locator(".running-similarity-scroll")
            .evaluate((scroll) => scroll.scrollTop);
        if (beforeScroll <= 0) {
            throw new Error(
                "Scroll preservation check requires a scrolled column list.",
            );
        }
        await lastColumnName.click();
        await page.waitForFunction(
            (count) =>
                document.querySelectorAll<HTMLImageElement>(".table_img")
                    .length === count,
            checked ? 48 : 36,
        );
        const retained = await page
            .locator(".running-similarity-scroll")
            .evaluate((scroll) => ({
                top: scroll.scrollTop,
                max: scroll.scrollHeight - scroll.clientHeight,
                focused:
                    document.activeElement ===
                    scroll.querySelector("tbody tr:last-child input"),
            }));
        if (
            Math.abs(retained.top - Math.min(beforeScroll, retained.max)) > 1 ||
            !retained.focused
        ) {
            throw new Error(
                `Toggling Show lost scroll or focus: ${JSON.stringify({ beforeScroll, retained })}`,
            );
        }
    }
    await page
        .locator(".running-similarity-scroll")
        .evaluate((scroll: HTMLElement) => {
            scroll.style.maxHeight = "";
            scroll.scrollTop = 0;
        });
});

test("drag and keyboard reordering preserve custom order through size changes and reloads", async ({
    page,
}) => {
    const { order, reference, original } = await openViewer(page);
    await page.locator(".running-similarity-badges").check();
    await order.selectOption("reference");
    const before = await page.evaluate(() =>
        rawData.axes[0].values.map((value) => value.key),
    );
    const grip = page.locator(".running-similarity-grip").first();
    await grip.scrollIntoViewIfNeeded();
    const from = (await grip.boundingBox())!;
    const to = (await page
        .locator(".running-similarity-scores tbody tr")
        .nth(2)
        .boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + to.height - 3, {
        steps: 8,
    });
    if (
        (await page
            .locator(
                ".running-similarity-drop-after, .running-similarity-drop-before",
            )
            .count()) !== 1
    ) {
        throw new Error("Dragging did not show an insertion line.");
    }
    await page.mouse.up();
    const expected = [before[1], before[2], before[0], before[3]];
    if (
        (await order.inputValue()) !== "custom" ||
        (await reference.inputValue()) !== "" ||
        JSON.stringify(expected) !==
            (await page.evaluate(() =>
                JSON.stringify(
                    rawData.axes[0].values.map((value) => value.key),
                ),
            ))
    ) {
        throw new Error("Dragging did not create the expected custom order.");
    }
    await checkComparisons(page);
    const grips = page.locator(".running-similarity-grip");
    await grips.first().focus();
    const firstKey = await grips.first().getAttribute("value");
    await page.keyboard.press("End");
    if (
        (await grips.last().getAttribute("value")) !== firstKey ||
        !(await grips
            .last()
            .evaluate((grip) => grip === document.activeElement))
    ) {
        throw new Error("Keyboard reordering lost the column or grip focus.");
    }
    const custom = await page.evaluate(() =>
        rawData.axes[0].values.map((value) => value.key),
    );
    const size = page.locator(".running-similarity-size");
    await size.fill("2");
    const verifySize = async () =>
        page.waitForFunction(() => {
            const cells = document.querySelector<HTMLTableRowElement>(
                "#image_table tr:nth-child(2)",
            )!.children;
            const first = cells[1].getBoundingClientRect(),
                second = cells[2].getBoundingClientRect();
            const label = cells[0].getBoundingClientRect();
            const available =
                document.documentElement.clientWidth - label.width;
            return (
                Math.abs(first.width + second.width - available) <= 6 &&
                Math.abs(first.width - second.width) <= 1
            );
        });
    await verifySize();
    await page.reload();
    if (
        (await size.inputValue()) !== "2" ||
        (await order.inputValue()) !== "custom" ||
        JSON.stringify(custom) !==
            (await page.evaluate(() =>
                JSON.stringify(
                    rawData.axes[0].values.map((value) => value.key),
                ),
            ))
    ) {
        throw new Error("Reload lost the custom order or image size.");
    }
    await verifySize();
    await page.setViewportSize({ width: 390, height: 844 });
    await verifySize();
    await page.setViewportSize({ width: 1280, height: 900 });
    await order.selectOption("saved");
    if (
        JSON.stringify(original) !==
        (await page.evaluate(() =>
            JSON.stringify(rawData.axes[0].values.map((value) => value.key)),
        ))
    ) {
        throw new Error(
            "Custom arrangement overwrote the published saved order.",
        );
    }
    await order.selectOption("custom");
    if (
        JSON.stringify(custom) !==
        (await page.evaluate(() =>
            JSON.stringify(rawData.axes[0].values.map((value) => value.key)),
        ))
    ) {
        throw new Error("Switching order discarded the custom arrangement.");
    }
    await page.locator(".running-similarity-size-reset").click();
    if (
        await page
            .locator("#image_table")
            .evaluate((table) => table.classList.contains("running-grid-sized"))
    ) {
        throw new Error("Reset size did not restore core sizing.");
    }
});

test("keeps the panel centered while scrolling and within the mobile viewport", async ({
    page,
}, testInfo) => {
    await openViewer(page);
    await page.evaluate(() => window.scrollTo(600, window.scrollY));
    const horizontal = await page
        .locator(".running-similarity")
        .evaluate((panel) => ({
            left: panel.getBoundingClientRect().left,
            width: panel.getBoundingClientRect().width,
            viewport: window.innerWidth,
            x: window.scrollX,
        }));
    if (
        horizontal.x < 100 ||
        Math.abs(
            horizontal.left - (horizontal.viewport - horizontal.width) / 2,
        ) > 1
    ) {
        throw new Error(
            `Similarity panel did not stay centered while scrolling horizontally: ${JSON.stringify(horizontal)}`,
        );
    }
    await page.evaluate(() => window.scrollTo(0, window.scrollY));
    await page
        .locator(".running-similarity")
        .screenshot({ path: testInfo.outputPath("similarity-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const panelFits = await page
        .locator(".running-similarity")
        .evaluate(
            (panel) =>
                panel.scrollWidth <= panel.clientWidth + 1 &&
                panel.getBoundingClientRect().width <= window.innerWidth,
        );
    if (!panelFits) {
        throw new Error("Similarity controls overflow on mobile.");
    }
    await page
        .locator(".running-similarity")
        .screenshot({ path: testInfo.outputPath("similarity-mobile.png") });
});

test("ignores deleted preferences and remains usable when storage is blocked", async ({
    page,
}) => {
    const { order, reference, original } = await openViewer(page);
    await page.evaluate(() => {
        localStorage.setItem(
            runningGridSimilarityPage.storageKey,
            JSON.stringify({
                order: "reference",
                reference: "deleted-model",
                details: true,
                badges: true,
                visibility: { "deleted-model": false },
            }),
        );
    });
    await page.reload();
    if (
        (await reference.inputValue()) !== original[0] ||
        (await page.locator(".running-similarity-visible:checked").count()) !==
            4
    ) {
        throw new Error(
            "Stale saved preferences hid new columns or retained a deleted reference.",
        );
    }
    await page.addInitScript(() => {
        Storage.prototype.getItem = () => {
            throw new Error("Storage blocked");
        };
        Storage.prototype.setItem = () => {
            throw new Error("Storage blocked");
        };
    });
    await page.reload();
    await order.selectOption("reference");
    if (
        (await reference.inputValue()) !== original[0] ||
        (await page.locator(".running-similarity-visible").count()) !== 4
    ) {
        throw new Error("Storage failure prevented using the controls.");
    }
});

test("hiding the active tab uses the next visible value in a three-axis grid", async ({
    page,
}) => {
    await page.goto("http://running-grid.test/ThreeAxes/index.html");
    await page.locator(".running-similarity-order").selectOption("saved");
    const keys = await page.evaluate(() => {
        document.getElementById("x_axis1")!.click();
        document.getElementById("y_axis2")!.click();
        return rawData.axes[0].values.map((value) => value.key);
    });
    const visibleColumns = () =>
        page
            .locator(".table_img")
            .evaluateAll((images: HTMLImageElement[]) => [
                ...new Set(
                    images.map(
                        (image) => image.dataset.img_path!.split("/")[0],
                    ),
                ),
            ]);
    await expect(page.locator(".table_img")).toHaveCount(4);
    await expect.poll(visibleColumns).toEqual([keys[0]]);
    await page
        .locator(`.running-similarity-visible[value="${keys[0]}"]`)
        .uncheck();
    await expect.poll(visibleColumns).toEqual([keys[1]]);
    await expect(page.locator(".table_img")).toHaveCount(4);
});
