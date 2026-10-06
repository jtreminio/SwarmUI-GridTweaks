import { test } from "@playwright/test";
import type { RunningGridHelper } from "../frontend/running-grid";
import { assetPath, corePath } from "./paths";
import type { BatchTestState, CoreGenerateHandler } from "./running-grid-types";

declare const window: Window &
    BatchTestState & {
        genericRequest(
            route: string,
            input: Record<string, unknown>,
            success: (response: unknown) => void,
        ): void;
    };
declare const runningGridHelper: RunningGridHelper;
declare const mainGenHandler: CoreGenerateHandler;
declare const GenerateHandler: new () => CoreGenerateHandler;
declare const pixel: string;
declare const metadata: string;
declare const progress: BatchTestState["progress"];
declare const output: BatchTestState["output"];

test("delivers running grid outputs through the core generation handler", async ({
    page,
}) => {
    await page.goto("about:blank");
    await page.setContent(
        '<html><body><div id="current_image_batch"></div></body></html>',
    );
    await page.evaluate(() => {
        window.sessionReadyCallbacks = [];
        window.isVideoExt = () => false;
        window.isAudioExt = () => false;
        window.getUserSetting = () => false;
        window.autoLoadPreviewsElem = { checked: false };
        window.imageFullView = { isOpen: () => false };
        window.createDiv = (_id, classes, html = "") => {
            const element = document.createElement("div");
            element.className = classes;
            element.innerHTML = html;
            return element;
        };
    });
    await page.addScriptTag({
        path: corePath("wwwroot/js/genpage/helpers/generatehandler.js"),
    });
    await page.addScriptTag({ path: assetPath("running-grid.js") });
    await page.evaluate(() => {
        window.mainGenHandler = new GenerateHandler();
        mainGenHandler.setCurrentImage = () => {};
        const addImage = (
            image: string,
            metadata: string,
            batchId: string,
            preview: boolean,
        ) => {
            const row = document.createElement("div");
            row.dataset.batch_id = batchId;
            row.dataset.metadata = metadata;
            row.dataset.src = image;
            if (preview) {
                row.dataset.is_generating = "true";
            }
            const img = document.createElement("img");
            img.src = image;
            row.appendChild(img);
            mainGenHandler.batchDiv.appendChild(row);
            return row;
        };
        mainGenHandler.gotImageResult = (image, metadata, id) =>
            addImage(image, metadata, id, false);
        mainGenHandler.gotImagePreview = (image, metadata, id) =>
            addImage(image, metadata, id, true);
        runningGridHelper.gallery = {
            Id: "gallery",
            Title: "Gallery",
            Axes: [],
            Completed: {},
            TrackModelChanges: false,
            BaseParams: { model: "saved-model", prompt: "saved prompt" },
        };
        runningGridHelper.summary = {
            id: "gallery",
            title: "Gallery",
            running: true,
            status: "Running",
            completed: 0,
            cells: 4,
            published: true,
            url: "",
            similarity_running: false,
            similarity_enabled: false,
            similarity_ready: false,
        };
        window.pixel =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9hoAAAAASUVORK5CYII=";
        window.metadata = JSON.stringify({
            sui_image_params: { prompt: "saved prompt", seed: 123 },
        });
        window.progress = (index) => ({
            gen_progress: {
                request_id: "request1",
                batch_index: String(index),
                preview: pixel,
                metadata,
                current_percent: 0.5,
                overall_percent: 0.5,
            },
        });
        window.output = (index, request = "request1") => ({
            image: pixel,
            metadata,
            request_id: request,
            batch_index: String(index),
        });
        runningGridHelper.handleLiveOutput("gallery", {
            run_id: "run1",
            outputs: [],
            progress: [progress(1), progress(3)],
            next_output: 0,
            has_more: false,
        });
    });
    if ((await page.locator('[data-is_generating="true"]').count()) !== 2) {
        throw new Error(
            "Generation previews did not reach the core image batch column.",
        );
    }
    await page.evaluate(() => {
        runningGridHelper.handleLiveOutput("gallery", {
            run_id: "run1",
            outputs: [],
            progress: [progress(1)],
            next_output: 0,
            has_more: false,
        });
        runningGridHelper.summary!.running = false;
        runningGridHelper.handleLiveOutput("gallery", {
            run_id: "run1",
            outputs: [output(1), output(2)],
            progress: [],
            next_output: 2,
            has_more: false,
        });
    });
    const result = await page.evaluate(() => ({
        count: mainGenHandler.batchDiv.children.length,
        pending: mainGenHandler.batchDiv.querySelectorAll(
            '[data-is_generating="true"]',
        ).length,
        metadata: mainGenHandler.batchDiv.querySelector<HTMLElement>(
            '[data-batch_id="request1_1"]',
        )!.dataset.metadata!,
        cursor: runningGridHelper.outputCursor("gallery"),
    }));
    if (
        result.count !== 2 ||
        result.pending !== 0 ||
        !result.metadata.includes("saved prompt") ||
        result.cursor.afterOutput !== 2
    ) {
        throw new Error(
            "Completed images, metadata, preview replacement or stop cleanup failed.",
        );
    }
    await page.evaluate(() => {
        runningGridHelper.handleLiveOutput("gallery", {
            run_id: "run1",
            outputs: [],
            progress: [],
            next_output: 2,
            has_more: false,
        });
    });
    if ((await page.locator("#current_image_batch > div").count()) !== 2) {
        throw new Error("Polling duplicated already delivered images.");
    }
    await page.evaluate(() => {
        runningGridHelper.handleLiveOutput("gallery", {
            run_id: "run2",
            outputs: [output(1, "request2")],
            progress: [],
            next_output: 1,
            has_more: true,
        });
        runningGridHelper.renderSummary = (summary) => {
            runningGridHelper.summary = summary;
        };
        runningGridHelper.say = (message) => {
            throw new Error(message);
        };
        window.genericRequest = (route, input, success) => {
            if (
                route !== "RunningGridGet" ||
                input.runId !== "run2" ||
                input.afterOutput !== 1 ||
                !input.includeOutputs
            ) {
                throw new Error("Polling sent an incorrect output cursor.");
            }
            success({
                summary: { ...runningGridHelper.summary!, running: false },
                live: {
                    run_id: "run2",
                    outputs: [output(2, "request2")],
                    progress: [],
                    next_output: 2,
                    has_more: false,
                },
            });
        };
        runningGridHelper.schedulePoll();
    });
    await page.waitForFunction(
        () => runningGridHelper.outputCursor("gallery").afterOutput === 2,
    );
    if ((await page.locator("#current_image_batch > div").count()) !== 4) {
        throw new Error(
            "Delivery stopped before the finished run’s remaining outputs arrived.",
        );
    }
});
