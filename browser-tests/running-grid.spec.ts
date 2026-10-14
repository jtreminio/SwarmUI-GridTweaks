import { expect, type Locator, type Page, test } from "@playwright/test";
import type {
    RunningGridDocument,
    RunningGridHelper,
    RunningGridSummary,
} from "../frontend/running-grid";
import { assetPath, corePath } from "./paths";
import type { RunningGridTestState } from "./running-grid-types";

declare const window: Window & RunningGridTestState;
declare const runningGridHelper: RunningGridHelper;
declare let gallery: RunningGridDocument;
declare let toolSelector: RunningGridTestState["toolSelector"];
declare let calls: RunningGridTestState["calls"];
declare let permissions: RunningGridTestState["permissions"];
declare let coreModelMap: RunningGridTestState["coreModelMap"];
declare let coreValues: RunningGridTestState["coreValues"];
declare let getGenInput: RunningGridTestState["getGenInput"];
declare let triggerChangeFor: RunningGridTestState["triggerChangeFor"];
declare let deletedValues: RunningGridTestState["deletedValues"];
declare let running: RunningGridTestState["running"];
declare let allComplete: RunningGridTestState["allComplete"];
declare let failNext: RunningGridTestState["failNext"];
declare let failRun: RunningGridTestState["failRun"];
declare let currentForm: RunningGridTestState["currentForm"];
declare let savedBeforeOverrides: RunningGridTestState["savedBeforeOverrides"];
declare let similarityState: RunningGridTestState["similarityState"];
declare function createDiv(id: string, classes: string): HTMLDivElement;
declare const extensionGridGen: {
    mainDiv: HTMLElement;
    settingsDiv: HTMLElement;
    axisDiv: HTMLDivElement;
    addAxis(): void;
    outputFolder: HTMLInputElement;
    outputType: HTMLSelectElement;
    listAxes(): HTMLCollectionOf<HTMLElement>;
};

let browserErrors: string[];
test.beforeEach(async ({ page }) => {
    browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 720 });
    // Reuse the fresh page; a redundant about:blank navigation breaks Chromium pointer capture.
    await page.setContent(
        '<!doctype html><html><head><title>Running Grid tests</title></head><body><select id="tool-selector"></select><div id="tools"><div id="core"></div></div></body></html>',
    );
    await page.evaluate(() => {
        window.sessionReadyCallbacks = [];
        window.postParamBuildSteps = [];
        window.permissions = { hasPermission: () => true };
        window.getUserSetting = () => false;
        window.isParamAdvanced = () => false;
        window.gen_param_types = [
            {
                id: "model",
                name: "Model",
                type: "model",
                subtype: "Stable-Diffusion",
            },
            { id: "prompt", name: "Prompt", type: "text" },
            { id: "steps", name: "Steps", type: "integer" },
            { id: "loras", name: "LoRAs", type: "list" },
            { id: "loraweights", name: "LoRA Weights", type: "list" },
            { id: "testlist", name: "List setting", type: "list" },
            { id: "loratencweights", name: "LoRA Tenc Weights", type: "list" },
            {
                id: "lorasectionconfinement",
                name: "LoRA Section Confinement",
                type: "list",
            },
            {
                id: "magicpromptpostfilter",
                name: "Magic Prompt Post Filter",
                type: "text",
            },
            {
                id: "seed",
                name: "Seed",
                type: "integer",
                min: -1,
                max: 2147483647,
            },
            {
                id: "sampler",
                name: "Sampler",
                type: "dropdown",
                values: ["euler", "heun"],
            },
            { id: "testboolean", name: "Boolean", type: "boolean" },
        ];
        window.coreModelMap = {
            "Stable-Diffusion": [
                "(None)",
                "krea2/a.safetensors",
                "krea2/b.safetensors",
                "krea2/c.safetensors",
            ],
        };
        window.toolSelector =
            document.querySelector<HTMLSelectElement>("#tool-selector")!;
        toolSelector.add(new Option("No tool", ""));
        toolSelector.add(new Option("Grid Generator", "grid_generator"));
        const generate = document.createElement("button");
        generate.id = "main-generate";
        const defaultGenerate = () => {
            generate.dataset.defaultRuns = String(
                Number(generate.dataset.defaultRuns || 0) + 1,
            );
        };
        const toolOverrides = new Map<
            string,
            { text: string; run: () => void }
        >([
            [
                "grid_generator",
                {
                    text: "Generate Grid",
                    run: () => {
                        generate.dataset.coreRuns = String(
                            Number(generate.dataset.coreRuns || 0) + 1,
                        );
                    },
                },
            ],
        ]);
        generate.textContent = "Generate";
        generate.onclick = defaultGenerate;
        document.body.prepend(generate);
        toolSelector.addEventListener("change", () => {
            generate.textContent = "Generate";
            generate.onclick = defaultGenerate;
            document.getElementById("core")!.hidden =
                toolSelector.value !== "grid_generator";
            document.querySelector<HTMLElement>(".running-grid")!.hidden =
                toolSelector.value !== "running_grids";
            const override = toolOverrides.get(toolSelector.value);
            if (override) {
                generate.textContent = override.text;
                generate.onclick = override.run;
            }
            const tool =
                toolSelector.value === "grid_generator"
                    ? document.getElementById("core")!
                    : toolSelector.value === "running_grids"
                      ? document.querySelector(".running-grid")
                      : null;
            tool?.dispatchEvent(new Event("tool-opened"));
        });
        // Match site.js triggerChangeFor, including explicit property callbacks after dispatch.
        // Loading site.js here fails its top-level cookie access on the about:blank fixture.
        window.triggerChangeFor = (element) => {
            element.dispatchEvent(new Event("input"));
            element.oninput?.(element as unknown as InputEvent);
            element.dispatchEvent(new Event("change"));
            element.onchange?.(element as unknown as Event);
        };
        window.registerNewTool = (id, title, genOverride, runOverride) => {
            toolSelector.add(new Option(title, id));
            toolOverrides.set(id, { text: genOverride, run: runOverride });
            const element = document.createElement("div");
            document.getElementById("tools")!.append(element);
            return element;
        };
        window.coreValues = [
            { mode: "model", vals: "krea2/a.safetensors, krea2/b.safetensors" },
            { mode: "seed", vals: " 100, 101, .., 111 \n" },
            { mode: "steps", vals: " \n " },
            { mode: "", vals: "20" },
        ];
        window.getGenInput = () => ({
            prompt: "fixed original prompt",
            steps: 20,
            seed: -1,
        });
        window.resetBatchIfNeeded = () => {
            window.batchReset = true;
        };
        window.calls = [];
        window.gallery = null;
        window.running = false;
        window.allComplete = false;
        window.failNext = false;
        window.failRun = false;
        window.deletedValues = new Map();
        window.genericRequest = (route, input, success, _depth, failure) => {
            calls.push({ route, input: structuredClone(input) });
            queueMicrotask(() => {
                if (failNext || (failRun && route === "RunningGridRun")) {
                    failNext = false;
                    failRun = false;
                    failure("Simulated server error");
                    return;
                }
                const summary = (): RunningGridSummary => ({
                    similarity_running: false,
                    similarity_enabled: false,
                    similarity_ready: false,
                    id: gallery.Id,
                    title: gallery.Title,
                    running,
                    status: running
                        ? "Running"
                        : allComplete
                          ? "Complete"
                          : "Ready",
                    completed: allComplete ? 24 : 0,
                    cells: 24,
                    published: true,
                    url: "Output/example/index.html",
                });
                if (route === "RunningGridCreate") {
                    gallery = {
                        Id: "saved-gallery",
                        Title: input.title!,
                        Completed: {},
                        TrackModelChanges: false,
                        BaseParams: { ...input.baseParams, seed: "100" },
                        Axes: input.gridAxes!.map((axis, index) => ({
                            Mode: axis.mode,
                            Title: axis.mode,
                            Values:
                                index === 0
                                    ? [
                                          {
                                              Id: "a",
                                              Title: "<img src=x onerror=alert(1)>",
                                              Params: { model: "krea2/a" },
                                              Skip: false,
                                          },
                                          {
                                              Id: "b",
                                              Title: "krea2/b",
                                              Params: { model: "krea2/b" },
                                              Skip: false,
                                          },
                                      ]
                                    : [
                                          {
                                              Id: "seed",
                                              Title: "100",
                                              Params: { seed: "100" },
                                              Skip: false,
                                          },
                                      ],
                        })),
                    };
                    success({ id: gallery.Id });
                } else if (route === "RunningGridList") {
                    success({ galleries: gallery ? [summary()] : [] });
                } else if (route === "RunningGridGet") {
                    success({
                        gallery: structuredClone(gallery),
                        summary: summary(),
                        override_parameters: [
                            "testlist",
                            "prompt",
                            "steps",
                            "loras",
                            "loraweights",
                            "loratencweights",
                            "lorasectionconfinement",
                            "magicpromptpostfilter",
                        ],
                    });
                } else if (route === "RunningGridFilterValues") {
                    const covered = new Set(
                        gallery.Axes[0].Values.map(
                            (value) => value.Params.model,
                        ),
                    );
                    const pasted = input.values!.split(/\s*(?:\|\||,)\s*/);
                    const remaining = pasted.filter((value) => {
                        const normalized = value.replace(/\.safetensors$/, "");
                        if (covered.has(normalized)) {
                            return false;
                        }
                        covered.add(normalized);
                        return true;
                    });
                    success({
                        values: remaining.join(" || "),
                        removed: pasted.length - remaining.length,
                        remaining: remaining.length,
                    });
                } else if (route === "RunningGridAppend") {
                    for (const [id, value] of deletedValues) {
                        if (input.values!.includes(value.Params.model)) {
                            gallery.Axes[0].Values.push(structuredClone(value));
                            deletedValues.delete(id);
                        }
                    }
                    allComplete = false;
                    success({ added: 1 });
                } else if (route === "RunningGridMembership") {
                    for (const value of gallery.Axes[0].Values) {
                        if (input.valueIds!.includes(value.Id)) {
                            deletedValues.set(value.Id, structuredClone(value));
                        }
                    }
                    gallery.Axes[0].Values = gallery.Axes[0].Values.filter(
                        (value) => !input.valueIds!.includes(value.Id),
                    );
                    success({ success: true });
                } else if (route === "RunningGridDelete") {
                    window.gallery = null;
                    success({ success: true });
                } else if (route === "RunningGridMoveValue") {
                    const values = gallery.Axes[0].Values;
                    const index = values.findIndex(
                        (value) => value.Id === input.valueId,
                    );
                    const moved = values.splice(index, 1)[0];
                    values.splice(
                        values.findIndex(
                            (value) => value.Id === input.targetId,
                        ) + (input.after ? 1 : 0),
                        0,
                        moved,
                    );
                    success({ success: true, moved: true });
                } else if (
                    route === "RunningGridRun" ||
                    route === "RunningGridCancel"
                ) {
                    running = route === "RunningGridRun" && !allComplete;
                    success({ success: true });
                }
            });
        };
    });
    await page.addScriptTag({ path: corePath("wwwroot/js/util.js") });
    await page.addScriptTag({
        path: corePath("wwwroot/js/genpage/helpers/ui_improvements.js"),
    });
    await page.addScriptTag({
        path: corePath("BuiltinExtensions/GridGenerator/Assets/grid_gen.js"),
    });
    await page.evaluate(() => {
        extensionGridGen.mainDiv = document.getElementById("core")!;
        extensionGridGen.settingsDiv = extensionGridGen.mainDiv;
        extensionGridGen.axisDiv = createDiv("core-axes", "");
        extensionGridGen.mainDiv.appendChild(extensionGridGen.axisDiv);
        extensionGridGen.settingsDiv.appendChild(
            createDiv("", "grid-gen-checkboxes"),
        );
        extensionGridGen.outputFolder = document.createElement("input");
        extensionGridGen.outputType = document.createElement("select");
        for (const [index, axis] of coreValues.entries()) {
            extensionGridGen.addAxis();
            const wrapper = extensionGridGen.listAxes()[index];
            wrapper.querySelector<HTMLSelectElement>(
                ".grid-gen-selector",
            )!.value = axis.mode;
            wrapper.querySelector<HTMLDivElement>(
                ".grid-gen-axis-input",
            )!.innerText = axis.vals;
        }
    });
    await page.addScriptTag({ path: assetPath("running-grid.js") });
    await page.addStyleTag({ path: corePath("wwwroot/css/site.css") });
    await page.addStyleTag({ path: corePath("wwwroot/css/genpage.css") });
    await page.addStyleTag({
        path: corePath("BuiltinExtensions/GridGenerator/Assets/grid_gen.css"),
    });
    await page.addStyleTag({ path: assetPath("running-grid.css") });
    await page.evaluate(() => {
        document.body.style.margin = "0";
        document.getElementById("tools")!.style.cssText =
            "height: calc(100vh - 6rem); overflow: auto;";
    });
    await page.evaluate(() => {
        runningGridHelper.register();
        runningGridHelper.selectTool("running_grids");
    });
});
test.afterEach(() => {
    expect(browserErrors).toEqual([]);
});

async function createSavedGallery(page: Page) {
    await page.locator("#tool-selector").selectOption("grid_generator");
    await page.locator(".running-grid-name").fill("Krea2 ongoing comparison");
    await page.locator(".running-grid-create-run").click();
    await page.waitForFunction(
        () => runningGridHelper.summary?.running && !runningGridHelper.busy,
    );
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
}

async function dragTo(
    page: Page,
    source: Locator,
    target: Locator,
    after: boolean,
) {
    await page.locator(".running-grid-members").scrollIntoViewIfNeeded();
    const from = (await source
        .locator(".running-grid-drag-handle")
        .boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(
        to.x + to.width / 2,
        to.y + to.height * (after ? 0.85 : 0.15),
        { steps: 8 },
    );
}

async function installSimilarityResponses(page: Page) {
    await page.evaluate(async () => {
        const originalRequest = window.genericRequest;
        window.similarityState = {
            running: false,
            ready: false,
            automatic: false,
            completedGets: 0,
        };
        window.genericRequest = (route, input, success, depth, failure) => {
            if (route === "RunningGridSimilarity") {
                calls.push({ route, input: structuredClone(input) });
                similarityState.running =
                    input.action !== "configure" && input.action !== "refresh";
                similarityState.ready = true;
                if (input.action !== "refresh") {
                    similarityState.automatic = input.automatic!;
                }
                queueMicrotask(() =>
                    success({
                        success: true,
                        started: similarityState.running,
                    }),
                );
            } else if (
                route === "RunningGridCancel" &&
                similarityState.running
            ) {
                similarityState.running = false;
                queueMicrotask(() => success({ success: true }));
            } else {
                originalRequest(
                    route,
                    input,
                    (data) => {
                        if (data.summary) {
                            Object.assign(data.summary, {
                                similarity_running: similarityState.running,
                                similarity_ready: similarityState.ready,
                                similarity_enabled: similarityState.automatic,
                                similarity_status: similarityState.running
                                    ? "Analyzing rows"
                                    : "Similarity updated",
                            });
                        }
                        // Let the reload span a rendered frame, like a real network request.
                        requestAnimationFrame(() =>
                            requestAnimationFrame(() => {
                                success(data);
                                if (route === "RunningGridGet") {
                                    similarityState.completedGets++;
                                }
                            }),
                        );
                    },
                    depth,
                    failure,
                );
            }
        };
        await runningGridHelper.load(gallery.Id);
    });
}

async function clickWithoutScrollJump(page: Page, selector: string) {
    const button = page.locator(selector);
    await button.evaluate((element) =>
        element.scrollIntoView({ block: "start" }),
    );
    const scrollBefore = await page
        .locator("#tools")
        .evaluate((element) => element.scrollTop);
    expect(scrollBefore).toBeGreaterThan(100);
    const completedGets = await page.evaluate(
        () => similarityState.completedGets,
    );
    await button.click();
    await page.waitForFunction(
        (completedGets) =>
            !runningGridHelper.busy &&
            similarityState.completedGets > completedGets,
        completedGets,
    );
    await expect(button).toBeInViewport({ ratio: 0.99 });
    expect(
        await page.locator("#tools").evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(100);
}

test("captures core settings and restores Generate when switching tools", async ({
    page,
}) => {
    await page.locator("#tool-selector").selectOption("grid_generator");
    if (
        (await page.locator("#tool-selector").inputValue()) !==
            "grid_generator" ||
        (await page.locator(".running-grid .running-grid-name").count()) ||
        (await page.locator("#core .running-grid-entry").count()) !== 1
    ) {
        throw new Error(
            "New-gallery setup did not lead directly to creation within Grid Generator.",
        );
    }
    await page.locator(".running-grid-create-run").click();
    if (
        await page.evaluate(() =>
            calls.some((call) => call.route === "RunningGridCreate"),
        )
    ) {
        throw new Error("Creation accepted an empty gallery name.");
    }
    await page.locator(".running-grid-name").fill("Krea2 ongoing comparison");
    await page.locator(".running-grid-create-run").click();
    await page.waitForFunction(
        () => runningGridHelper.summary?.running && !runningGridHelper.busy,
    );
    if (
        (await page.locator("#tool-selector").inputValue()) !==
            "running_grids" ||
        !(await page.evaluate(() =>
            calls.some((call) => call.route === "RunningGridRun"),
        ))
    ) {
        throw new Error("Creation did not start generation.");
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
    const capture = await page.evaluate(() => {
        const capture = calls.find(
            (call) => call.route === "RunningGridCreate",
        )!;
        return {
            axes: capture.input.gridAxes!,
            prompt: capture.input.baseParams!.prompt,
            injected: document.querySelectorAll(".running-grid-members img")
                .length,
        };
    });
    if (capture.prompt !== "fixed original prompt" || capture.injected !== 0) {
        throw new Error("Capture or safe model-label rendering failed.");
    }
    expect(capture.axes).toEqual([
        { mode: "model", vals: "krea2/a.safetensors, krea2/b.safetensors" },
        { mode: "seed", vals: " 100, 101, .., 111 \n" },
    ]);
    const callsBeforeToolSwitch = await page.evaluate(() => calls.length);
    await page.locator("#tool-selector").selectOption("grid_generator");
    await expect(page.locator("#main-generate")).toHaveText("Generate Grid");
    await page.locator("#main-generate").click();
    await expect(page.locator("#main-generate")).toHaveAttribute(
        "data-core-runs",
        "1",
    );
    await page.locator("#tool-selector").selectOption("");
    await expect(page.locator("#main-generate")).toHaveText("Generate");
    await page.locator("#main-generate").click();
    await expect(page.locator("#main-generate")).toHaveAttribute(
        "data-default-runs",
        "1",
    );
    await expect(page.locator(".running-grid")).toBeHidden();
    expect(
        await page.evaluate(
            (start) => calls.slice(start),
            callsBeforeToolSwitch,
        ),
    ).toEqual([]);
    await page.evaluate(() => runningGridHelper.selectTool("running_grids"));
    await expect(page.locator("#main-generate")).toHaveText(
        "Run Missing Cells",
    );
});

test("filters pending model values without changing saved columns", async ({
    page,
}) => {
    await createSavedGallery(page);
    const values = page.getByRole("textbox", { name: "Values to add" });
    await expect(
        page.locator('#tool-selector option[value="running_grids"]'),
    ).toHaveText("Grid Tweaks");
    const filter = page.getByRole("button", { name: "Keep only new" });
    await expect(filter).toBeVisible();
    await values.fill(
        "krea2/a.safetensors, krea2/b.safetensors, krea2/c.safetensors, krea2/c.safetensors",
    );
    await filter.click();
    await expect(values).toHaveText("krea2/c.safetensors");
    await expect(
        page.locator(".running-grid > .running-grid-message"),
    ).toContainText(
        "Removed 3 existing or repeated values. 1 new value ready to add.",
    );
    await expect(page.locator(".running-grid-member")).toHaveCount(2);
    await values.fill("krea2/a.safetensors, krea2/b.safetensors");
    await filter.click();
    await expect(values).toHaveText("");
    await expect(
        page.locator(".running-grid > .running-grid-message"),
    ).toContainText("No new values remain.");
    await values.fill("krea2/c.safetensors");
    await page.evaluate(() => {
        failNext = true;
    });
    await filter.click();
    await expect(
        page.locator(".running-grid > .running-grid-message"),
    ).toHaveText("Simulated server error");
    await expect(values).toHaveText("krea2/c.safetensors");
    await expect(filter).toBeEnabled();
    await page.evaluate(() => {
        runningGridHelper.gallery!.Axes[0].Mode = "steps";
        runningGridHelper.updateControls();
    });
    await expect(filter).toBeHidden();
    await page.evaluate(() => {
        runningGridHelper.gallery!.Axes[0].Mode = "loras";
        runningGridHelper.updateControls();
    });
    await expect(filter).toBeVisible();
    await page.evaluate(() => {
        runningGridHelper.gallery!.Axes[0].Mode = "model";
        runningGridHelper.updateControls();
    });
});

test("reorders columns by mouse keyboard and touch with cancellation and autoscroll", async ({
    page,
}) => {
    await createSavedGallery(page);
    const values = page.getByRole("textbox", { name: "Values to add" });
    const columnA = page.locator('.running-grid-member[data-value-id="a"]');
    const columnB = page.locator('.running-grid-member[data-value-id="b"]');
    if ((await page.locator(".running-grid-drag-handle").count()) !== 2) {
        throw new Error("The column list did not provide grip handles.");
    }
    await values.fill("krea2/c.safetensors");
    await page.locator(".running-grid-title").click();
    await columnA.locator("input").check();
    let reorderStart = await page.evaluate(() => calls.length);
    await dragTo(page, columnA, columnB, true);
    if (
        !(await columnB.evaluate((element) =>
            element.classList.contains("running-grid-drop-after"),
        )) ||
        (await page.evaluate(() => calls.length)) !== reorderStart
    ) {
        throw new Error(
            "Dragging did not show a drop line or saved before the drop.",
        );
    }
    await page.mouse.up();
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            runningGridHelper.gallery!.Axes[0].Values[0].Id === "b",
    );
    const reorderCalls = await page.evaluate(
        (start) => calls.slice(start),
        reorderStart,
    );
    if (
        reorderCalls.map((call) => call.route).join(",") !==
            "RunningGridMoveValue,RunningGridGet" ||
        JSON.stringify(reorderCalls[0].input) !==
            JSON.stringify({
                id: "saved-gallery",
                valueId: "a",
                targetId: "b",
                after: true,
            }) ||
        (await page
            .locator(".running-grid-member")
            .first()
            .getAttribute("data-value-id")) !== "b" ||
        (await columnA.locator(".running-grid-position").innerText()) !== "2" ||
        !(await columnA.locator("input").isChecked()) ||
        (await columnB.locator("input").isChecked()) ||
        (await values.innerText()) !== "krea2/c.safetensors"
    ) {
        throw new Error(
            "Moving a column changed selection/pending values, ran generation, or failed to reload saved order.",
        );
    }
    if (
        !(await columnA
            .locator(".running-grid-drag-handle")
            .evaluate((element) => element === document.activeElement))
    ) {
        throw new Error("Moving a column lost keyboard focus.");
    }
    await page.evaluate(() => {
        failNext = true;
    });
    await dragTo(page, columnA, columnB, false);
    await page.mouse.up();
    await page.waitForFunction(() => !runningGridHelper.busy);
    if (
        (await page
            .locator(".running-grid-member")
            .first()
            .getAttribute("data-value-id")) !== "b" ||
        !(
            await page
                .locator(".running-grid > .running-grid-message")
                .innerText()
        ).includes("Simulated server error")
    ) {
        throw new Error(
            "A failed move reordered columns locally or hid its error.",
        );
    }
    reorderStart = await page.evaluate(() => calls.length);
    await dragTo(page, columnA, columnB, false);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await dragTo(page, columnA, columnB, false);
    await page.mouse.move(1, 1);
    await page.mouse.up();
    if (
        (await page.evaluate(() => calls.length)) !== reorderStart ||
        (await page
            .locator(
                ".running-grid-dragging, .running-grid-drop-before, .running-grid-drop-after",
            )
            .count())
    ) {
        throw new Error(
            "Cancelled or out-of-bounds drags saved an order or left drag visuals behind.",
        );
    }
    await columnA.locator(".running-grid-drag-handle").press("ArrowUp");
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            runningGridHelper.gallery!.Axes[0].Values[0].Id === "a",
    );
    await columnA.locator("input").uncheck();
    await page.evaluate(() => {
        permissions.hasPermission = (permission) =>
            permission !== "gridgen_save_grids";
        runningGridHelper.updateControls();
    });
    if (
        await page.locator(".running-grid-drag-handle:not(:disabled)").count()
    ) {
        throw new Error("Read-only users can reorder columns.");
    }
    await page.evaluate(() => {
        permissions.hasPermission = () => true;
        runningGridHelper.updateControls();
    });
    await page.evaluate(async () => {
        gallery.Axes[0].Values.push({
            Id: "c",
            Title: "krea2/c",
            Params: { model: "krea2/c" },
            Skip: false,
        });
        await runningGridHelper.load(gallery.Id);
    });
    const columnC = page.locator('.running-grid-member[data-value-id="c"]');
    await dragTo(page, columnA, columnC, true);
    await page.mouse.up();
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            runningGridHelper
                .gallery!.Axes[0].Values.map((v) => v.Id)
                .join(",") === "b,c,a",
    );
    await columnA.locator(".running-grid-drag-handle").press("Home");
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            runningGridHelper.gallery!.Axes[0].Values[0].Id === "a",
    );
    const touch = await page.context().newCDPSession(page);
    try {
        await touch.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: 1,
        });
        await page.locator(".running-grid-members").scrollIntoViewIfNeeded();
        const from = (await columnC
            .locator(".running-grid-drag-handle")
            .boundingBox())!;
        const to = (await columnA.boundingBox())!;
        await touch.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [
                { x: from.x + from.width / 2, y: from.y + from.height / 2 },
            ],
        });
        await touch.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: to.x + to.width / 2, y: to.y + 8 }],
        });
        await page.waitForFunction(
            () => !!document.querySelector(".running-grid-drop-before"),
        );
        await touch.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
        });
        await page.waitForFunction(
            () =>
                !runningGridHelper.busy &&
                runningGridHelper
                    .gallery!.Axes[0].Values.map((v) => v.Id)
                    .join(",") === "c,a,b",
        );
    } finally {
        await touch.send("Emulation.setTouchEmulationEnabled", {
            enabled: false,
        });
        await touch.detach();
    }
    await page.evaluate(async () => {
        gallery.Axes[0].Values = gallery.Axes[0].Values.filter(
            (value) => value.Id !== "c",
        );
        await runningGridHelper.load(gallery.Id);
    });
    await page.evaluate(async () => {
        for (let i = 0; i < 18; i++) {
            gallery.Axes[0].Values.push({
                Id: `extra-${i}`,
                Title: `Additional model ${i}`,
                Params: {},
                Skip: false,
            });
        }
        await runningGridHelper.load(gallery.Id);
    });
    await columnA.locator(".running-grid-drag-handle").scrollIntoViewIfNeeded();
    const sourceBox = (await columnA
        .locator(".running-grid-drag-handle")
        .boundingBox())!;
    const paneBox = (await page.locator("#tools").boundingBox())!;
    reorderStart = await page.evaluate(() => calls.length);
    const scrollStart = await page
        .locator("#tools")
        .evaluate((element) => element.scrollTop);
    await page.mouse.move(
        sourceBox.x + sourceBox.width / 2,
        sourceBox.y + sourceBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
        sourceBox.x + sourceBox.width / 2,
        paneBox.y + paneBox.height - 4,
        { steps: 8 },
    );
    await page.waitForFunction(
        (start) => document.getElementById("tools")!.scrollTop > start + 80,
        scrollStart,
    );
    await page.keyboard.press("Escape");
    await page.mouse.up();
    if (
        (await page.evaluate(() => calls.length)) !== reorderStart ||
        (await page.evaluate(() => !!runningGridHelper.columnDrag))
    ) {
        throw new Error(
            "Cancelling an auto-scrolling drag saved changes or left the drag active.",
        );
    }
    await page.evaluate(async () => {
        gallery.Axes[0].Values = gallery.Axes[0].Values.filter(
            (value) => !value.Id.startsWith("extra-"),
        );
        await runningGridHelper.load(gallery.Id);
    });
});

test("uses core model editor and resumes saved cells with retryable edits", async ({
    page,
}) => {
    await createSavedGallery(page);
    const values = page.getByRole("textbox", { name: "Values to add" });
    await values.fill("");
    await values.click();
    const suggestions = page.locator(".running-grid .sui_popover_model_button");
    if (
        (await suggestions.count()) !== 4 ||
        !(await suggestions.first().isVisible())
    ) {
        throw new Error(
            "Clicking the empty model editor did not show the model list and Add All.",
        );
    }
    await suggestions.filter({ hasText: "krea2/b.safetensors" }).click();
    if ((await values.innerText()) !== "krea2/b.safetensors") {
        throw new Error("Mouse completion did not insert the selected model.");
    }
    await page.locator(".running-grid-copy").click();
    if (
        (await values.innerText()) !==
        "krea2/a.safetensors, krea2/b.safetensors"
    ) {
        throw new Error("Copy changed the axis values.");
    }
    await page.evaluate(() => {
        runningGridHelper.selectTool("grid_generator");
        const selector = document.querySelector<HTMLSelectElement>(
            "#grid-gen-axis-type-0",
        )!;
        selector.value = "model";
        triggerChangeFor(selector);
    });
    await page.locator("#grid-gen-axis-input-0").fill("krea2/");
    await page.evaluate(() => runningGridHelper.selectTool("running_grids"));
    await values.fill("krea2/");
    if (
        (await page.locator("#popover_grid_search").count()) !== 1 ||
        !(await suggestions.first().isVisible())
    ) {
        throw new Error(
            "Running grid suggestions conflicted with the core editor.",
        );
    }
    await page.evaluate(() => {
        extensionGridGen.mainDiv.hidden = true;
    });
    await page.evaluate(() => {
        gallery.Axes[0].Mode = "model";
        gallery.Axes[0].Title = "Model";
        return runningGridHelper.load(gallery.Id);
    });
    await page.evaluate(() => {
        extensionGridGen
            .listAxes()[0]
            .querySelector<HTMLDivElement>(".grid-gen-axis-input")!.innerText =
            "krea2/c.safetensors";
        extensionGridGen
            .listAxes()[1]
            .querySelector<HTMLDivElement>(".grid-gen-axis-input")!.innerText =
            "900, 901";
        getGenInput = () => ({ prompt: "unrelated edited prompt", seed: 999 });
    });
    await page.locator(".running-grid-copy").click();
    await page.locator(".running-grid-add").click();
    await page.waitForFunction(() => !runningGridHelper.busy);
    const appendInput = await page.evaluate(
        () => calls.find((call) => call.route === "RunningGridAppend")!.input,
    );
    expect(
        appendInput,
        "Append submitted settings outside the first axis.",
    ).toEqual({ id: "saved-gallery", values: "krea2/c.safetensors" });
    if (await values.innerText()) {
        throw new Error(
            "Successfully saved values remain in the pending editor.",
        );
    }
    const resumeCallStart = await page.evaluate(() => {
        window.batchReset = false;
        return calls.length;
    });
    await page.locator(".running-grid-run").click();
    await page.waitForFunction(() => runningGridHelper.summary!.running);
    const resumeInput = await page.evaluate(
        (start) =>
            calls.slice(start).find((call) => call.route === "RunningGridRun")!
                .input,
        resumeCallStart,
    );
    expect(
        resumeInput,
        "Resume leaked current generation form into the saved grid.",
    ).toEqual({ id: "saved-gallery" });
    if (!(await page.evaluate(() => window.batchReset))) {
        throw new Error(
            "Starting a gallery did not apply the normal batch clearing preference.",
        );
    }
    if (
        !(await page.locator(".running-grid-add").isDisabled()) ||
        (await values.isEditable()) ||
        !(await page
            .locator(".running-grid .grid-gen-axis-fill-button")
            .isDisabled()) ||
        !(await page.locator(".running-grid-copy").isDisabled()) ||
        !(await page.locator(".running-grid-delete").isDisabled()) ||
        (await page.locator(".running-grid-drag-handle:not(:disabled)").count())
    ) {
        throw new Error("Mutations remain enabled during generation.");
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
    await page.evaluate(() => {
        allComplete = true;
    });
    await values.fill("krea2/new.safetensors");
    let callStart = await page.evaluate(() => calls.length);
    await page.locator("#main-generate").click();
    await page.waitForFunction(() => !runningGridHelper.busy);
    const pendingRunCalls = await page.evaluate(
        (start) => calls.slice(start),
        callStart,
    );
    if (
        pendingRunCalls.map((call) => call.route).join(",") !==
            "RunningGridAppend,RunningGridRun,RunningGridGet" ||
        JSON.stringify(pendingRunCalls[0].input) !==
            JSON.stringify({
                id: "saved-gallery",
                values: "krea2/new.safetensors",
            }) ||
        JSON.stringify(pendingRunCalls[1].input) !==
            JSON.stringify({ id: "saved-gallery" }) ||
        !(await page.evaluate(() => runningGridHelper.summary!.running)) ||
        (await values.innerText())
    ) {
        throw new Error(
            "The main Generate override did not save pending models before starting from frozen settings.",
        );
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
    await page.evaluate(() => {
        allComplete = true;
    });
    callStart = await page.evaluate(() => calls.length);
    await page.locator("#main-generate").click();
    await page.waitForFunction(() => !runningGridHelper.busy);
    const completeRunCalls = await page.evaluate(
        (start) => calls.slice(start).map((call) => call.route),
        callStart,
    );
    if (
        completeRunCalls.join(",") !== "RunningGridRun,RunningGridGet" ||
        !(
            await page
                .locator(".running-grid > .running-grid-message")
                .innerText()
        ).includes("up to date")
    ) {
        throw new Error(
            "An unchanged complete gallery did not report that there is no work to run.",
        );
    }
    await values.fill("invalid-model");
    await page.evaluate(() => {
        failNext = true;
    });
    callStart = await page.evaluate(() => calls.length);
    await page.locator("#main-generate").click();
    await page.waitForFunction(() => !runningGridHelper.busy);
    const failedAppendCalls = await page.evaluate(
        (start) => calls.slice(start).map((call) => call.route),
        callStart,
    );
    if (
        failedAppendCalls.join(",") !== "RunningGridAppend" ||
        (await values.innerText()) !== "invalid-model" ||
        !(
            await page
                .locator(".running-grid > .running-grid-message")
                .innerText()
        ).includes("Simulated server error")
    ) {
        throw new Error(
            "Failed append started generation or discarded pending values.",
        );
    }
    for (const action of ["#main-generate", ".running-grid-add"]) {
        const removed = await page.evaluate(() => {
            for (const checkbox of runningGridHelper.members.querySelectorAll(
                "input",
            )) {
                checkbox.checked = false;
            }
            return structuredClone(gallery.Axes[0].Values[0]);
        });
        await page
            .locator(
                `.running-grid-member[data-value-id="${removed.Id}"] input`,
            )
            .check();
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator(".running-grid-remove").click();
        await page.waitForFunction(
            (id) =>
                !runningGridHelper.busy &&
                !runningGridHelper.gallery!.Axes[0].Values.some(
                    (value) => value.Id === id,
                ),
            removed.Id,
        );
        if (
            (await page
                .locator(`.running-grid-member[data-value-id="${removed.Id}"]`)
                .count()) ||
            (await page
                .locator(".running-grid-drag-handle:not(:disabled)")
                .count())
        ) {
            throw new Error(
                "Deletion retained a row or a deleted drag neighbor.",
            );
        }
        await values.fill(removed.Params.model);
        callStart = await page.evaluate(() => calls.length);
        await page.locator(action).click();
        await page.waitForFunction(() => !runningGridHelper.busy);
        const readdCalls = await page.evaluate(
            (start) => calls.slice(start).map((call) => call.route),
            callStart,
        );
        const expected =
            action === "#main-generate"
                ? "RunningGridAppend,RunningGridRun,RunningGridGet"
                : "RunningGridAppend,RunningGridGet";
        if (
            readdCalls.join(",") !== expected ||
            (await values.innerText()) ||
            !(await page
                .locator(`.running-grid-member[data-value-id="${removed.Id}"]`)
                .count())
        ) {
            throw new Error(
                "Readding a deleted model did not save it normally.",
            );
        }
        if (action === "#main-generate") {
            await page.locator(".running-grid-stop").click();
            await page.waitForFunction(
                () =>
                    !runningGridHelper.busy &&
                    !runningGridHelper.summary!.running,
            );
        }
    }
    await values.fill("krea2/new.safetensors");
    await page.locator(".running-grid-title").click();
    await page.locator(".running-grid-run").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && runningGridHelper.summary!.running,
    );
    if (await values.innerText()) {
        throw new Error("The in-tool Run button did not save pending values.");
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
    await values.fill("krea2/new.safetensors");
    await page.evaluate(async () => {
        gallery.Id = "another-gallery";
        await runningGridHelper.load(gallery.Id);
    });
    if (await values.innerText()) {
        throw new Error(
            "Pending values leaked into another gallery with the same first-axis type.",
        );
    }
    await page.evaluate(async () => {
        gallery.Id = "saved-gallery";
        await runningGridHelper.load(gallery.Id);
    });
    await values.fill("krea2/c.safetensors");
    await page.locator(".running-grid-title").click();
    await page.evaluate(() => {
        failNext = true;
    });
    await page.locator(".running-grid-add").click();
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            document
                .querySelector(".running-grid > .running-grid-message")!
                .textContent!.includes("Simulated server error"),
    );
    if (await page.locator(".running-grid-add").isDisabled()) {
        throw new Error("Server error left the interface disabled.");
    }
});

test("isolates one-off overrides and clears selections after runs", async ({
    page,
}) => {
    await createSavedGallery(page);
    let callStart: number;
    await page.evaluate(async () => {
        window.currentForm = {
            prompt: "<img src=x onerror=alert(1)>",
            steps: "20",
            seed: 999,
            model: "unrelated-model",
            loras: [
                "Krea2_TextFusion_Refusal-Reduction_LoRA_-Updated-_-_v2-0_Full_Rank",
            ],
            loraweights: "0.75",
            loratencweights: "0.5",
            lorasectionconfinement: "0",
            magicpromptpostfilter: "temporary filter",
        };
        getGenInput = () => structuredClone(currentForm);
        window.savedBeforeOverrides = JSON.stringify(
            runningGridHelper.gallery!.BaseParams,
        );
        allComplete = false;
        await runningGridHelper.load(gallery.Id);
        runningGridHelper.values.innerText = "";
    });
    await page.locator(".running-grid-overrides > summary").click();
    await page.locator(".running-grid-compare").click();
    const loraOverride = page.locator(
        '.running-grid-override-choice input[value="loras"]',
    );
    if (
        (await page
            .locator(".running-grid-override-choice input:checked")
            .count()) ||
        (await page
            .locator(
                '.running-grid-override-choice input[value="seed"], .running-grid-override-choice input[value="model"], .running-grid-override-choice input[value="steps"]',
            )
            .count()) ||
        (await page.locator(".running-grid-override-list img").count()) ||
        !(await loraOverride.count())
    ) {
        throw new Error(
            "Override review preselected changes, offered axes, miscompared numeric values, or rendered unsafe markup.",
        );
    }
    await loraOverride.check();
    callStart = await page.evaluate(() => calls.length);
    await page.locator("#main-generate").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && runningGridHelper.summary!.running,
    );
    const loraRunInput = await page.evaluate(
        (start) =>
            calls.slice(start).find((call) => call.route === "RunningGridRun")!
                .input,
        callStart,
    );
    if (
        JSON.stringify(Object.keys(loraRunInput.overrides!).sort()) !==
            JSON.stringify(
                [
                    "loras",
                    "loraweights",
                    "loratencweights",
                    "lorasectionconfinement",
                ].sort(),
            ) ||
        loraRunInput.overrides!.loraweights !== "0.75" ||
        loraRunInput.overrides!.loratencweights !== "0.5" ||
        (await page
            .locator(".running-grid-override-choice input:checked")
            .count()) ||
        !(await page.evaluate(
            () =>
                savedBeforeOverrides ===
                JSON.stringify(runningGridHelper.gallery!.BaseParams),
        ))
    ) {
        throw new Error(
            "Run did not isolate the selected LoRA group or clear its one-off selection.",
        );
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
    callStart = await page.evaluate(() => calls.length);
    await page.locator("#main-generate").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && runningGridHelper.summary!.running,
    );
    const nextRunInput = await page.evaluate(
        (start) =>
            calls.slice(start).find((call) => call.route === "RunningGridRun")!
                .input,
        callStart,
    );
    if ("overrides" in nextRunInput) {
        throw new Error("The next run reused one-off overrides.");
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
    await loraOverride.check();
    await page.evaluate(() => {
        currentForm.loraweights = "0.9";
    });
    callStart = await page.evaluate(() => calls.length);
    await page.locator("#main-generate").click();
    if (
        (await page.evaluate((start) => calls.length !== start, callStart)) ||
        (await loraOverride.isChecked()) ||
        !(
            await page
                .locator(".running-grid > .running-grid-message")
                .innerText()
        ).includes("Review and reselect")
    ) {
        throw new Error(
            "A changed selected override started generation without being reviewed.",
        );
    }
    const filterOverride = page.locator(
        '.running-grid-override-choice input[value="magicpromptpostfilter"]',
    );
    await filterOverride.check();
    await page.evaluate(() => {
        failNext = true;
    });
    await page.locator(".running-grid-run").click();
    await page.waitForFunction(() => !runningGridHelper.busy);
    if (!(await filterOverride.isChecked())) {
        throw new Error("A rejected run discarded selected overrides.");
    }
    callStart = await page.evaluate(() => calls.length);
    await page.locator(".running-grid-run").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && runningGridHelper.summary!.running,
    );
    const filterRunInput = await page.evaluate(
        (start) =>
            calls.slice(start).find((call) => call.route === "RunningGridRun")!
                .input,
        callStart,
    );
    if (
        JSON.stringify(filterRunInput.overrides!) !==
        JSON.stringify({ magicpromptpostfilter: "temporary filter" })
    ) {
        throw new Error(
            "An extension setting override did not reach Run or leaked other form changes.",
        );
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
    await page.evaluate(async () => {
        gallery.BaseParams.loras = ["saved-lora"];
        gallery.BaseParams.loraweights = "1";
        delete currentForm.loras;
        delete currentForm.loraweights;
        delete currentForm.loratencweights;
        delete currentForm.lorasectionconfinement;
        await runningGridHelper.load(gallery.Id);
    });
    await loraOverride.check();
    callStart = await page.evaluate(() => calls.length);
    await page.locator("#main-generate").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && runningGridHelper.summary!.running,
    );
    const removedLorasInput = await page.evaluate(
        (start) =>
            calls.slice(start).find((call) => call.route === "RunningGridRun")!
                .input,
        callStart,
    );
    if (
        Object.keys(removedLorasInput.overrides!).length !== 4 ||
        Object.values(removedLorasInput.overrides!).some(
            (value) => value !== null,
        )
    ) {
        throw new Error(
            "Disabling saved LoRAs did not send explicit removals for the complete group.",
        );
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
    await loraOverride.check();
    await page.evaluate(async () => {
        await runningGridHelper.load("");
        await runningGridHelper.load(gallery.Id);
    });
    if (
        await page
            .locator(".running-grid-override-choice input:checked")
            .count()
    ) {
        throw new Error("Switching galleries retained one-off selections.");
    }
});

test("fits long model names and reorders columns on mobile", async ({
    page,
}) => {
    await createSavedGallery(page);
    const values = page.getByRole("textbox", { name: "Values to add" });
    const columnA = page.locator('.running-grid-member[data-value-id="a"]');
    const columnB = page.locator('.running-grid-member[data-value-id="b"]');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => {
        gallery.Axes[0].Values[0].Title =
            "krea/-BSS-_-_DesireX_-_-Krea2-_-_X2_INT8_ConvRot_-Fastest-.safetensors";
        await runningGridHelper.load(gallery.Id);
    });
    await values.fill(
        "krea/-BSS-_-_DesireX_-_-Krea2-_-_X2_INT8_ConvRot_-Fastest-.safetensors",
    );
    await page.locator(".running-grid-title").click();
    const mobileFits = await page.evaluate(() => {
        const tools = document.getElementById("tools")!;
        return (
            document.documentElement.scrollWidth <= window.innerWidth &&
            tools.scrollWidth <= tools.clientWidth
        );
    });
    if (!mobileFits) {
        throw new Error("Mobile layout overflows horizontally.");
    }
    await dragTo(page, columnB, columnA, false);
    await page.mouse.up();
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            runningGridHelper.gallery!.Axes[0].Values[0].Id === "b",
    );
});

test("sets up similarity and preserves preferences and scroll while scoring", async ({
    page,
}) => {
    await createSavedGallery(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installSimilarityResponses(page);
    await page
        .getByRole("textbox", { name: "Values to add" })
        .fill("pending-column");
    await page.locator(".running-grid-title").click();
    await page.evaluate(() => {
        permissions.hasPermission = (permission) =>
            permission !== "install_features";
        runningGridHelper.updateControls();
    });
    if (!(await page.locator(".running-grid-analyze").isDisabled())) {
        throw new Error("Initial setup ignored the install permission.");
    }
    await page.evaluate(() => {
        permissions.hasPermission = () => true;
        runningGridHelper.updateControls();
    });
    const analyzeWithoutScrollJump = async () => {
        await clickWithoutScrollJump(page, ".running-grid-analyze");
        expect(
            await page.evaluate(
                () => runningGridHelper.summary!.similarity_running,
            ),
        ).toBe(true);
    };
    let similarityCallStart = await page.evaluate(() => calls.length);
    await analyzeWithoutScrollJump();
    let similarityCalls = await page.evaluate(
        (start) =>
            calls
                .slice(start)
                .filter((call) =>
                    [
                        "RunningGridSimilarity",
                        "RunningGridRun",
                        "RunningGridAppend",
                    ].includes(call.route),
                ),
        similarityCallStart,
    );
    if (
        similarityCalls.length !== 1 ||
        similarityCalls[0].input.action !== "setup" ||
        similarityCalls[0].input.automatic
    ) {
        throw new Error(
            "Similarity setup started generation, saved pending values, or sent the wrong action.",
        );
    }
    if (
        !(await page.locator(".running-grid-run").isDisabled()) ||
        !(await page.locator(".running-grid-remove").isDisabled()) ||
        !(await page.locator(".running-grid-delete").isDisabled())
    ) {
        throw new Error(
            "Scoring did not disable conflicting gallery mutations.",
        );
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            !runningGridHelper.summary!.similarity_running,
    );
    await page.locator(".running-grid-similarity-auto").check();
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            runningGridHelper.summary!.similarity_enabled,
    );
    await page.locator(".running-grid-similarity-auto").uncheck();
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            !runningGridHelper.summary!.similarity_enabled,
    );
    await page.evaluate(() => {
        permissions.hasPermission = (permission) =>
            permission !== "install_features";
        runningGridHelper.updateControls();
    });
    similarityCallStart = await page.evaluate(() => calls.length);
    await analyzeWithoutScrollJump();
    similarityCalls = await page.evaluate(
        (start) =>
            calls
                .slice(start)
                .filter((call) => call.route === "RunningGridSimilarity"),
        similarityCallStart,
    );
    if (
        similarityCalls.length !== 1 ||
        similarityCalls[0].input.action !== "analyze" ||
        similarityCalls[0].input.automatic
    ) {
        throw new Error(
            "Normal analysis tried to install again or changed the automatic-update preference.",
        );
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            !runningGridHelper.summary!.similarity_running,
    );
    await page.evaluate(async () => {
        permissions.hasPermission = () => true;
        similarityState.ready = false;
        await runningGridHelper.load(gallery.Id);
    });
    similarityCallStart = await page.evaluate(() => calls.length);
    await analyzeWithoutScrollJump();
    if (
        (await page.evaluate(
            (start) =>
                calls
                    .slice(start)
                    .find((call) => call.route === "RunningGridSimilarity")
                    ?.input.action,
            similarityCallStart,
        )) !== "setup"
    ) {
        throw new Error(
            "The same analysis button did not recover invalidated setup.",
        );
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () =>
            !runningGridHelper.busy &&
            !runningGridHelper.summary!.similarity_running,
    );
});

test("refreshes gallery pages and confirms permission-checked retryable deletion", async ({
    page,
}) => {
    await createSavedGallery(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installSimilarityResponses(page);
    const values = page.getByRole("textbox", { name: "Values to add" });
    const deleteButton = page.locator(".running-grid-delete");
    if (
        !(await deleteButton.isVisible()) ||
        !(await page.locator(".running-grid-page-refresh").isVisible()) ||
        !(await page.locator(".running-grid-open").isVisible())
    ) {
        throw new Error("Gallery actions are not visible.");
    }
    const refreshStart = await page.evaluate(() => calls.length);
    await values.fill("pending-column");
    await values.press("End");
    await clickWithoutScrollJump(page, ".running-grid-page-refresh");
    await expect(values).not.toBeFocused();
    await expect(values).toHaveText("pending-column");
    const refreshCalls = await page.evaluate(
        (start) =>
            calls
                .slice(start)
                .filter((call) => call.route !== "RunningGridGet"),
        refreshStart,
    );
    if (
        refreshCalls.length !== 1 ||
        refreshCalls[0].route !== "RunningGridSimilarity" ||
        refreshCalls[0].input.action !== "refresh" ||
        "automatic" in refreshCalls[0].input
    ) {
        throw new Error(
            "Refreshing a gallery page started other work or changed similarity preferences.",
        );
    }
    await clickWithoutScrollJump(page, ".running-grid-refresh");
    await expect(values).not.toBeFocused();
    await expect(values).toHaveText("pending-column");
    for (const denied of ["gridgen_save_grids", "user_delete_image"]) {
        await page.evaluate((denied) => {
            permissions.hasPermission = (permission) => permission !== denied;
            runningGridHelper.updateControls();
        }, denied);
        if (!(await deleteButton.isDisabled())) {
            throw new Error(
                `Gallery deletion remained enabled without ${denied}.`,
            );
        }
    }
    const toDelete = await page.evaluate(async () => {
        permissions.hasPermission = () => true;
        allComplete = true;
        await runningGridHelper.load(gallery.Id);
        runningGridHelper.liveRuns.set(gallery.Id, {
            runId: "old-run",
            cursor: 24,
            images: {},
            discardable: {},
            timeLastGenHit: [],
            batchId: 0,
        });
        return { id: gallery.Id, title: gallery.Title, calls: calls.length };
    });
    let confirmText = "";
    page.once("dialog", async (dialog) => {
        confirmText = dialog.message();
        await dialog.dismiss();
    });
    await deleteButton.click();
    if (
        !confirmText.includes(toDelete.title) ||
        !confirmText.includes("24 saved cells") ||
        !confirmText.includes("cannot be undone") ||
        (await page.evaluate(() => calls.length)) !== toDelete.calls
    ) {
        throw new Error(
            "Delete confirmation omitted the gallery/count or cancellation sent a request.",
        );
    }
    await page.evaluate(() => {
        failNext = true;
    });
    page.once("dialog", (dialog) => dialog.accept());
    await deleteButton.click();
    await page.waitForFunction(() => !runningGridHelper.busy);
    if (
        !(await page
            .locator(".running-grid > .running-grid-message")
            .textContent()
            .then((text) => text!.includes("Simulated server error"))) ||
        (await deleteButton.isDisabled()) ||
        (await page.locator(".running-grid-selector").inputValue()) !==
            toDelete.id
    ) {
        throw new Error(
            "Failed gallery deletion lost the selection or prevented retry.",
        );
    }
    page.once("dialog", (dialog) => dialog.accept());
    await deleteButton.click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.gallery,
    );
    const deletedGalleryState = await page.evaluate(
        (id) => ({
            calls: calls
                .filter((call) => call.route === "RunningGridDelete")
                .map((call) => call.input),
            retained: runningGridHelper.liveRuns.has(id),
            options: runningGridHelper.selector.options.length,
            selected: runningGridHelper.selector.value,
            summary: runningGridHelper.summary,
        }),
        toDelete.id,
    );
    if (
        deletedGalleryState.calls.length !== 2 ||
        deletedGalleryState.calls.some(
            (input) =>
                input.id !== toDelete.id || Object.keys(input).length !== 1,
        ) ||
        deletedGalleryState.retained ||
        deletedGalleryState.options !== 1 ||
        deletedGalleryState.selected ||
        deletedGalleryState.summary ||
        !(await page.locator(".running-grid-saved").isHidden()) ||
        !(await page.locator(".running-grid-open").isHidden()) ||
        !(await deleteButton.isHidden()) ||
        !(await page.locator(".running-grid-run").isDisabled())
    ) {
        throw new Error(
            "Successful deletion retained stale gallery state or sent the wrong ID.",
        );
    }
});

test("retries failed first generation without duplicating galleries", async ({
    page,
}) => {
    await page.evaluate(() => {
        failRun = true;
        runningGridHelper.selectTool("grid_generator");
    });
    await page.locator(".running-grid-name").fill("First run retry");
    await page.locator(".running-grid-create-run").click();
    await page.waitForFunction(() => !runningGridHelper.busy);
    if (
        !(await page
            .locator(".running-grid > .running-grid-message")
            .textContent()
            .then((text) =>
                text!.includes("Gallery saved, but generation could not start"),
            )) ||
        !(await page.locator(".running-grid-run").isEnabled())
    ) {
        throw new Error(
            "A failed first run lost its saved gallery or retry instructions.",
        );
    }
    const creationStart = await page.evaluate(() => calls.length);
    await page.locator(".running-grid-run").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && runningGridHelper.summary!.running,
    );
    if (
        await page.evaluate(
            (start) =>
                calls
                    .slice(start)
                    .some((call) => call.route === "RunningGridCreate"),
            creationStart,
        )
    ) {
        throw new Error("Retrying the first run created a duplicate gallery.");
    }
    await page.locator(".running-grid-stop").click();
    await page.waitForFunction(
        () => !runningGridHelper.busy && !runningGridHelper.summary!.running,
    );
});
