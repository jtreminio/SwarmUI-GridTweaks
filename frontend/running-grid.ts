export interface RunningGridDocument {
    Id: string;
    Title: string;
    BaseParams: Record<string, unknown>;
    Axes: RunningGridAxis[];
    Completed: Record<string, string>;
    TrackModelChanges: boolean;
}

export interface RunningGridAxis {
    Mode: string;
    Title: string;
    Values: RunningGridValue[];
}

export interface RunningGridValue {
    Id: string;
    Title: string;
    Params: Record<string, string>;
    Skip: boolean;
}

export interface RunningGridSummary {
    id: string;
    title: string;
    running: boolean;
    status: string;
    error?: string | null;
    completed: number;
    cells: number;
    url: string;
    published: boolean;
    similarity_running: boolean;
    similarity_status?: string | null;
    similarity_enabled: boolean;
    similarity_ready: boolean;
}

/** Generation events and image holders remain owned by Swarm's generation handler. */
export interface RunningGridLiveOutput {
    run_id: string | null;
    progress?: Record<string, unknown>[];
    outputs?: Record<string, unknown>[];
    next_output: number;
    has_more?: boolean;
}

interface RunningGridLiveState {
    runId: string;
    cursor: number;
    images: Record<string, unknown>;
    discardable: Record<string, unknown>;
    timeLastGenHit: number[];
    batchId: number;
}

interface RunningGridGetResponse {
    gallery?: RunningGridDocument;
    override_parameters?: string[];
    summary: RunningGridSummary;
    live?: RunningGridLiveOutput;
}

interface RunningGridResponses {
    RunningGridList: { galleries: RunningGridSummary[] };
    RunningGridGet: RunningGridGetResponse;
    RunningGridCreate: { id: string };
    RunningGridAppend: { added: number };
    RunningGridRun: { started: boolean; run_id: string };
    RunningGridMoveValue: { success: boolean; moved: boolean };
    RunningGridMembership: { success: boolean };
    RunningGridDelete: { success: boolean };
    RunningGridCancel: { success: boolean };
    RunningGridSimilarity: { success: boolean; started: boolean };
}

type RunningGridMutation = Exclude<
    keyof RunningGridResponses,
    | "RunningGridList"
    | "RunningGridGet"
    | "RunningGridCreate"
    | "RunningGridDelete"
>;

interface CoreAxisInput {
    mode: string;
    vals: string;
}
interface CoreParameter {
    id: string;
    name: string;
    type: string;
}

/** Receiver fields used by GridGeneratorHelper.addAxis and its event callbacks. */
interface CoreGridEditor {
    mainDiv: HTMLElement;
    axisDiv: HTMLElement;
    lastAxisId: number;
    inputFilesCache: string[] | null;
    popover: HTMLElement | null;
    fillSelectorOptions(selector: HTMLSelectElement): void;
    addAxis(this: CoreGridEditor): void;
}

interface CoreGridGenerator extends CoreGridEditor {
    listAxes(): HTMLCollectionOf<HTMLElement>;
}

interface ColumnRow extends HTMLDivElement {
    dataset: DOMStringMap & { valueId: string };
}

interface ColumnDrag {
    handle: HTMLButtonElement;
    row: ColumnRow;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    started: boolean;
    target: { row: ColumnRow; after: boolean } | null;
    frame: number | null;
    scrollPane: Element;
}

declare const extensionGridGen: CoreGridGenerator;
declare const gen_param_types: CoreParameter[];
declare const toolSelector: HTMLSelectElement;
declare const sessionReadyCallbacks: (() => void)[];
declare const permissions: { hasPermission(permission: string): boolean };
declare const mainGenHandler: {
    getBatchId(): number;
    internalHandleData(
        data: Record<string, unknown>,
        images: Record<string, unknown>,
        discardable: Record<string, unknown>,
        timeLastGenHit: number[],
        actualInput: Record<string, unknown>,
        socketId: null,
        socket: null,
        isPreview: boolean,
        batchId: number,
    ): void;
};
declare function genericRequest(
    route: string,
    input: Record<string, unknown>,
    callback: (data: unknown) => void,
    depth: number,
    errorHandle: (message: string) => void,
): void;
declare function registerNewTool(
    id: string,
    label: string,
    actionLabel: string,
    action: () => void,
): HTMLDivElement;
declare function createDiv(
    id: string | null,
    className: string,
): HTMLDivElement;
declare function triggerChangeFor(element: HTMLElement): void;
declare function hidePopover(id: string): void;
declare function getGenInput(): Record<string, unknown>;
declare function resetBatchIfNeeded(): void;

function query<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) {
        throw new Error(`Missing running grid element: ${selector}`);
    }
    return element;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class RunningGridHelper {
    gallery: RunningGridDocument | null = null;
    summary: RunningGridSummary | null = null;
    busy = false;
    pollTimer: ReturnType<typeof setTimeout> | undefined;
    loadVersion = 0;
    listVersion = 0;
    registered = false;
    liveRuns = new Map<string, RunningGridLiveState>();
    hasMoreOutputs = false;
    valueGalleryId: string | null = null;
    columnDrag: ColumnDrag | null = null;
    overrideGalleryId: string | null = null;
    overrideParameters = new Set<string>();
    overrideChoices = new Map<
        string,
        { values: Record<string, unknown>; signature: string }
    >();

    root!: HTMLDivElement;
    selector!: HTMLSelectElement;
    message!: HTMLElement;
    saved!: HTMLElement;
    title!: HTMLElement;
    progress!: HTMLElement;
    open!: HTMLAnchorElement;
    settings!: HTMLElement;
    axis_title!: HTMLElement;
    members!: HTMLDivElement;
    entry!: HTMLDivElement;
    name!: HTMLInputElement;
    track!: HTMLInputElement;
    setupMessage!: HTMLElement;
    valueType!: HTMLSelectElement;
    values!: HTMLDivElement;
    valueFill!: HTMLButtonElement;

    request<Route extends keyof RunningGridResponses>(
        route: Route,
        input: Record<string, unknown>,
    ): Promise<RunningGridResponses[Route]> {
        return new Promise<RunningGridResponses[Route]>((resolve, reject) => {
            genericRequest(
                route,
                input,
                (data) => resolve(data as RunningGridResponses[Route]),
                0,
                (message) => reject(new Error(message)),
            );
        });
    }

    register() {
        if (
            this.registered ||
            typeof extensionGridGen === "undefined" ||
            !extensionGridGen.mainDiv
        ) {
            return;
        }
        this.registered = true;
        this.root = registerNewTool(
            "running_grids",
            "Running Grids",
            "Run Missing Cells",
            () => this.run(),
        );
        this.root.classList.add("running-grid");
        this.root.innerHTML = `
            <p class="running-grid-intro">Add columns to saved comparisons. Prompts, seeds, and other saved settings stay fixed.</p>
            <div class="running-grid-toolbar running-grid-gallery-toolbar">
                <label class="running-grid-field running-grid-gallery-field">Saved gallery
                    <select class="running-grid-selector"><option value="">Choose a gallery</option></select>
                </label>
                <button type="button" class="basic-button running-grid-refresh">Refresh list</button>
            </div>
            <p class="running-grid-empty running-grid-hint" hidden>No saved galleries yet. Create one in Grid Generator using <strong>Create &amp; generate</strong>.</p>
            <p class="running-grid-message" role="status" aria-live="polite"></p>
            <div class="running-grid-saved" hidden>
                <div class="running-grid-gallery-heading">
                    <div class="running-grid-gallery-identity">
                        <h4 class="running-grid-title"></h4>
                        <p class="running-grid-progress" role="status" aria-live="polite"></p>
                    </div>
                    <div class="running-grid-gallery-actions">
                        <a class="running-grid-open" target="_blank" rel="noopener" hidden>Open gallery <span aria-hidden="true">↗</span></a>
                        <button type="button" class="basic-button running-grid-page-refresh">Refresh gallery page</button>
                        <button type="button" class="basic-button running-grid-delete">Delete gallery…</button>
                    </div>
                </div>
                <section class="running-grid-workflow" aria-label="Add columns and generate">
                    <h5 class="running-grid-axis-title"></h5>
                    <p class="running-grid-hint">Enter new values, then click <strong>Run missing / changed cells</strong>. Existing completed images are kept.</p>
                    <label class="running-grid-values-label" for="running-grid-values">Values to add</label>
                    <div class="running-grid-value-editor"></div>
                    <p class="running-grid-hint running-grid-editor-hint">Use the same lists and ranges as Grid Generator. Running saves new values automatically.</p>
                    <div class="running-grid-toolbar">
                        <button type="button" class="basic-button running-grid-copy">Copy first axis from Grid Generator</button>
                        <button type="button" class="basic-button running-grid-add">Add without running</button>
                    </div>
                    <details class="running-grid-section running-grid-overrides">
                        <summary>Overrides for this run <span class="running-grid-meta running-grid-override-count">None selected</span></summary>
                        <div class="running-grid-section-body">
                            <p>Select differences from the current generation form for this run only. Saved settings and existing images stay as they are.</p>
                            <p class="running-grid-hint">Seeds, axes and preset-controlled settings stay locked. LoRAs and weights are selected together.</p>
                            <button type="button" class="basic-button running-grid-compare">Refresh differences</button>
                            <div class="running-grid-override-list"></div>
                        </div>
                    </details>
                    <div class="running-grid-run-actions">
                        <div class="running-grid-toolbar">
                            <button type="button" class="basic-button btn-primary running-grid-run">Run missing / changed cells</button>
                            <button type="button" class="basic-button running-grid-stop" hidden>Stop this gallery</button>
                        </div>
                        <p class="running-grid-hint running-grid-run-note"></p>
                    </div>
                </section>
                <section class="running-grid-section running-grid-similarity" aria-label="Image similarity">
                    <h5>Image similarity</h5>
                    <p class="running-grid-hint">Compare saved images to sort columns by similarity in the gallery.</p>
                    <div class="running-grid-toolbar">
                        <button type="button" class="basic-button running-grid-analyze">Analyze similarity</button>
                        <label class="running-grid-option"><input type="checkbox" class="running-grid-similarity-auto"> Update after each generation run</label>
                    </div>
                    <p class="running-grid-similarity-status" role="status" aria-live="polite" hidden></p>
                    <p class="running-grid-hint running-grid-similarity-setup-note">Analysis sets up scoring when needed (about 250 MB). Requires a local ComfyUI runtime and Install Features permission.</p>
                </section>
                <details class="running-grid-section running-grid-locked">
                    <summary>Saved generation settings <span class="running-grid-meta">Read-only</span></summary>
                    <div class="running-grid-section-body">
                        <p class="running-grid-hint">Captured generation settings and fixed axes for this gallery.</p>
                        <pre class="running-grid-settings"></pre>
                    </div>
                </details>
                <section class="running-grid-columns" aria-label="Manage gallery columns">
                    <div class="running-grid-columns-heading">
                        <h5>Column order <span class="running-grid-meta running-grid-column-count"></span></h5>
                        <div class="running-grid-toolbar">
                            <span class="running-grid-meta running-grid-selection" role="status"></span>
                            <button type="button" class="basic-button running-grid-remove">Remove selected</button>
                        </div>
                    </div>
                    <p class="running-grid-members-empty" hidden>No columns yet. Add values above to get started.</p>
                    <div class="running-grid-members" role="list" aria-label="Gallery column order"></div>
                </section>
            </div>`;
        this.selector = query<HTMLSelectElement>(
            this.root,
            ".running-grid-selector",
        );
        this.message = query<HTMLElement>(this.root, ".running-grid-message");
        this.saved = query<HTMLElement>(this.root, ".running-grid-saved");
        this.title = query<HTMLElement>(this.root, ".running-grid-title");
        this.progress = query<HTMLElement>(this.root, ".running-grid-progress");
        this.open = query<HTMLAnchorElement>(this.root, ".running-grid-open");
        this.settings = query<HTMLElement>(this.root, ".running-grid-settings");
        this.axis_title = query<HTMLElement>(
            this.root,
            ".running-grid-axis-title",
        );
        this.members = query<HTMLDivElement>(
            this.root,
            ".running-grid-members",
        );
        this.createValueEditor();
        this.members.addEventListener("pointerdown", (event) =>
            this.startColumnDrag(event),
        );
        this.members.addEventListener("pointermove", (event) =>
            this.updateColumnDrag(event),
        );
        this.members.addEventListener("pointerup", (event) =>
            this.finishColumnDrag(event),
        );
        this.members.addEventListener("pointercancel", () =>
            this.cancelColumnDrag(),
        );
        this.members.addEventListener("lostpointercapture", () =>
            this.cancelColumnDrag(),
        );
        this.members.addEventListener("keydown", (event) =>
            this.columnDragKey(event),
        );
        this.members.addEventListener("change", () => this.updateControls());
        const actions = {
            refresh: () => this.refreshList(this.selector.value),
            run: () => this.run(),
            stop: () => this.stop(),
            copy: () => this.copyFirstAxis(),
            compare: () => this.refreshOverrides(),
            analyze: () => this.analyzeSimilarity(),
            "page-refresh": () => {
                this.mutate(
                    "RunningGridSimilarity",
                    { action: "refresh" },
                    "Gallery page refreshed. Reload the open gallery to see the latest controls. Images and saved scores were kept.",
                );
            },
            add: () => this.append(),
            remove: () => this.removeSelected(),
            delete: () => this.deleteGallery(),
        };
        for (const [name, action] of Object.entries(actions)) {
            query<HTMLButtonElement>(
                this.root,
                `.running-grid-${name}`,
            ).addEventListener("click", action);
        }
        this.selector.addEventListener("change", () =>
            this.load(this.selector.value),
        );
        query<HTMLInputElement>(
            this.root,
            ".running-grid-similarity-auto",
        ).addEventListener("change", (event) => {
            this.mutate(
                "RunningGridSimilarity",
                {
                    action: "configure",
                    automatic: (event.currentTarget as HTMLInputElement)
                        .checked,
                },
                "Similarity refresh preference saved.",
            );
        });
        query<HTMLDetailsElement>(
            this.root,
            ".running-grid-overrides",
        ).addEventListener("toggle", (event) => {
            if (
                (event.currentTarget as HTMLDetailsElement).open &&
                this.gallery &&
                !this.busy &&
                !this.summary?.running &&
                !this.summary?.similarity_running
            ) {
                this.refreshOverrides();
            }
        });
        this.root.addEventListener("tool-opened", () => {
            if (!this.busy) {
                this.refreshList(this.selector.value);
            }
        });
        this.createSetupPanel();
        this.refreshList();
    }

    createSetupPanel() {
        this.entry = createDiv(null, "running-grid-entry");
        this.entry.innerHTML = `
            <h5>Create a running grid</h5>
            <p>Keep this comparison and add more columns later. Create it here before generating.</p>
            <p class="running-grid-setup-info running-grid-hint"></p>
            <label class="running-grid-field">Gallery name
                <input class="auto-input-text running-grid-name" maxlength="200" placeholder="e.g. Krea2 comparison" required>
            </label>
            <label class="running-grid-option"><input type="checkbox" class="running-grid-track" checked>
                Regenerate results when their local model files change</label>
            <div class="running-grid-toolbar">
                <button type="button" class="basic-button btn-primary running-grid-create-run">Create &amp; generate</button>
            </div>
            <p class="running-grid-hint">Opens in Running Grids automatically. Prompts, seeds, other settings, and all axes after the first are saved for future runs.</p>
            <p class="running-grid-setup-message running-grid-message" role="status" aria-live="polite"></p>`;
        extensionGridGen.mainDiv.appendChild(this.entry);
        this.name = query<HTMLInputElement>(this.entry, ".running-grid-name");
        this.track = query<HTMLInputElement>(this.entry, ".running-grid-track");
        this.setupMessage = query<HTMLElement>(
            this.entry,
            ".running-grid-setup-message",
        );
        query<HTMLButtonElement>(
            this.entry,
            ".running-grid-create-run",
        ).addEventListener("click", () => this.capture());
        extensionGridGen.axisDiv.addEventListener("input", () =>
            this.renderSetup(),
        );
        extensionGridGen.axisDiv.addEventListener("change", () =>
            this.renderSetup(),
        );
        extensionGridGen.mainDiv.addEventListener("tool-opened", () =>
            this.renderSetup(),
        );
        this.renderSetup();
    }

    renderSetup() {
        const axes = this.coreAxes();
        const title = (axis: CoreAxisInput) =>
            gen_param_types.find((type) => type.id === axis.mode)?.name ||
            axis.mode;
        query<HTMLElement>(this.entry, ".running-grid-setup-info").textContent =
            axes.length
                ? `Columns you can add later: ${title(axes[0])}.${axes.length > 1 ? ` Fixed axes: ${axes.slice(1).map(title).join(", ")}.` : ""}`
                : "Add at least one axis above. Put the setting you want to extend later, such as Model, first.";
    }

    configureGrid() {
        this.selectTool("grid_generator");
        this.renderSetup();
        extensionGridGen.axisDiv.scrollIntoView({ block: "start" });
        extensionGridGen.axisDiv
            .querySelector<HTMLSelectElement>(".grid-gen-selector")
            ?.focus({ preventScroll: true });
    }

    createValueEditor() {
        const host = query<HTMLDivElement>(
            this.root,
            ".running-grid-value-editor",
        );
        const editor: CoreGridEditor = {
            mainDiv: this.root,
            axisDiv: host,
            lastAxisId: 0,
            inputFilesCache: null,
            // Core uses one fixed popover ID. Share its owner so switching tools cannot duplicate it.
            get popover() {
                return extensionGridGen.popover;
            },
            set popover(value) {
                extensionGridGen.popover = value;
            },
            fillSelectorOptions: () => {},
            addAxis: () => {},
        };
        extensionGridGen.addAxis.call(editor);
        this.valueType = query<HTMLSelectElement>(host, ".grid-gen-selector");
        this.valueType.id = "running-grid-value-type";
        this.valueType.hidden = true;
        this.valueType.disabled = true;
        this.values = query<HTMLDivElement>(host, ".grid-gen-axis-input");
        this.values.id = "running-grid-values";
        this.values.classList.add("running-grid-values");
        this.values.setAttribute("role", "textbox");
        this.values.setAttribute("aria-label", "Values to add");
        this.values.setAttribute("aria-multiline", "true");
        this.values.dataset.placeholder = "Type or paste values to add…";
        this.values.setAttribute(
            "aria-placeholder",
            this.values.dataset.placeholder,
        );
        this.valueFill = query<HTMLButtonElement>(
            host,
            ".grid-gen-axis-fill-button",
        );
        this.valueFill.type = "button";
        const suggest = () => {
            if (
                this.values.isContentEditable &&
                window.getSelection()?.isCollapsed
            ) {
                triggerChangeFor(this.values);
            }
        };
        this.values.addEventListener("click", suggest);
        this.values.addEventListener("focus", suggest);
    }

    closeValueSuggestions() {
        const popover = extensionGridGen.popover;
        if (popover && this.root.contains(popover)) {
            hidePopover("grid_search");
            popover.remove();
            extensionGridGen.popover = null;
        }
    }

    selectTool(name: string) {
        toolSelector.value = name;
        triggerChangeFor(toolSelector);
    }

    coreAxes(): CoreAxisInput[] {
        const axes = [];
        for (const axis of extensionGridGen.listAxes()) {
            const mode = query<HTMLSelectElement>(
                axis,
                ".grid-gen-selector",
            ).value;
            const vals = query<HTMLDivElement>(
                axis,
                ".grid-gen-axis-input",
            ).innerText;
            if (mode && vals.trim()) {
                axes.push({ mode, vals });
            }
        }
        return axes;
    }

    say(message: string, error = false) {
        this.message.textContent = message;
        this.message.classList.toggle("running-grid-error", error);
    }

    updateControls() {
        const running =
            this.summary?.running || this.summary?.similarity_running || false;
        const canSave = permissions.hasPermission("gridgen_save_grids");
        for (const action of ["add", "remove"]) {
            query<HTMLButtonElement>(
                this.root,
                `.running-grid-${action}`,
            ).disabled = this.busy || running || !canSave;
        }
        query<HTMLButtonElement>(
            this.entry,
            ".running-grid-create-run",
        ).disabled =
            this.busy ||
            !canSave ||
            !permissions.hasPermission("gridgen_generate_grids");
        this.name.disabled = this.busy;
        this.track.disabled = this.busy;
        query<HTMLButtonElement>(this.root, ".running-grid-run").disabled =
            this.busy || running || !this.gallery || !canSave;
        query<HTMLButtonElement>(
            this.root,
            ".running-grid-page-refresh",
        ).disabled = this.busy || running || !this.gallery || !canSave;
        const deleteButton = query<HTMLButtonElement>(
            this.root,
            ".running-grid-delete",
        );
        deleteButton.hidden = !this.gallery;
        deleteButton.disabled =
            this.busy ||
            running ||
            !this.gallery ||
            !canSave ||
            !permissions.hasPermission("user_delete_image");
        query<HTMLButtonElement>(this.root, ".running-grid-remove").disabled ||=
            !permissions.hasPermission("user_delete_image");
        const selected =
            this.members.querySelectorAll<HTMLInputElement>(
                "input:checked",
            ).length;
        query<HTMLButtonElement>(this.root, ".running-grid-remove").disabled ||=
            selected === 0;
        query<HTMLElement>(this.root, ".running-grid-selection").textContent =
            selected ? `${selected} selected` : "";
        query<HTMLButtonElement>(this.root, ".running-grid-stop").disabled =
            this.busy || !running;
        query<HTMLButtonElement>(this.root, ".running-grid-stop").hidden =
            !running;
        const analyze = query<HTMLButtonElement>(
            this.root,
            ".running-grid-analyze",
        );
        analyze.disabled =
            this.busy ||
            running ||
            !canSave ||
            !this.gallery ||
            (!this.summary?.similarity_ready &&
                !permissions.hasPermission("install_features"));
        analyze.textContent = this.summary?.similarity_running
            ? "Analyzing…"
            : "Analyze similarity";
        query<HTMLInputElement>(
            this.root,
            ".running-grid-similarity-auto",
        ).disabled =
            this.busy || running || !canSave || !this.summary?.similarity_ready;
        this.selector.disabled = this.busy;
        const valuesDisabled =
            this.busy || running || !this.gallery || !canSave;
        this.values.contentEditable = String(!valuesDisabled);
        this.values.setAttribute("aria-disabled", String(valuesDisabled));
        this.valueFill.disabled = valuesDisabled;
        query<HTMLButtonElement>(this.root, ".running-grid-copy").disabled =
            valuesDisabled;
        query<HTMLButtonElement>(this.root, ".running-grid-compare").disabled =
            valuesDisabled;
        for (const checkbox of this.root.querySelectorAll<HTMLInputElement>(
            ".running-grid-override-choice input",
        )) {
            checkbox.disabled = valuesDisabled;
        }
        const singleColumn =
            this.members.querySelectorAll<HTMLButtonElement>(
                ".running-grid-drag-handle",
            ).length < 2;
        for (const handle of this.members.querySelectorAll<HTMLButtonElement>(
            ".running-grid-drag-handle",
        )) {
            handle.disabled = valuesDisabled || singleColumn;
        }
        if (valuesDisabled) {
            this.cancelColumnDrag();
            this.closeValueSuggestions();
        }
    }

    async refreshList(selected = "") {
        const version = ++this.listVersion;
        try {
            const data = await this.request("RunningGridList", {});
            if (version !== this.listVersion) {
                return;
            }
            this.selector.replaceChildren(new Option("Choose a gallery", ""));
            for (const item of data.galleries) {
                this.selector.add(new Option(item.title, item.id));
            }
            query<HTMLElement>(this.root, ".running-grid-empty").hidden =
                data.galleries.length > 0;
            this.selector.value = selected;
            await this.load(this.selector.value);
        } catch (error) {
            if (version === this.listVersion) {
                this.say(errorMessage(error), true);
            }
        }
    }

    async load(id: string) {
        this.cancelColumnDrag();
        clearTimeout(this.pollTimer);
        const version = ++this.loadVersion;
        if (this.overrideGalleryId !== id) {
            this.clearOverrides();
        }
        this.overrideGalleryId = id;
        // Keep the selected gallery visible during every reload so its scroll area never collapses.
        if (this.gallery?.Id !== id) {
            this.gallery = null;
            this.summary = null;
            this.saved.hidden = true;
            this.open.hidden = true;
        }
        this.updateControls();
        if (!id) {
            return;
        }
        try {
            const data = await this.request("RunningGridGet", {
                id,
                ...this.outputCursor(id),
            });
            if (version !== this.loadVersion) {
                return;
            }
            if (!data.gallery) {
                throw new Error("Gallery response is missing its definition.");
            }
            this.gallery = data.gallery;
            this.overrideParameters = new Set(data.override_parameters || []);
            this.saved.hidden = false;
            this.renderDefinition();
            this.refreshOverrides();
            this.renderSummary(data.summary);
            this.handleLiveOutput(id, data.live);
            this.schedulePoll();
        } catch (error) {
            if (version === this.loadVersion) {
                this.say(errorMessage(error), true);
            }
        }
    }

    overrideComparable(
        type: CoreParameter,
        value: unknown,
    ): string[] | string | null {
        if (
            [
                "loras",
                "loraweights",
                "loratencweights",
                "lorasectionconfinement",
            ].includes(type.id) &&
            value == null
        ) {
            return [];
        }
        if (value == null) {
            return null;
        }
        if (type.type === "list") {
            return Array.isArray(value)
                ? value.map(String)
                : String(value)
                      .split(/\s*(?:,|\|\|\|)\s*/)
                      .filter((part) => part.length);
        }
        return String(value);
    }

    overrideDisplay(value: unknown) {
        if (value == null) {
            return "Not set / disabled";
        }
        if (Array.isArray(value)) {
            return value.length ? value.join(", ") : "None";
        }
        const text = String(value);
        if (!text) {
            return "Empty";
        }
        return text.length > 4000
            ? `[Captured value: ${text.length.toLocaleString()} characters]`
            : text;
    }

    refreshOverrides() {
        if (!this.gallery) {
            return false;
        }
        const selected = new Map<string, string | undefined>();
        for (const checkbox of this.root.querySelectorAll<HTMLInputElement>(
            ".running-grid-override-choice input:checked",
        )) {
            selected.set(
                checkbox.value,
                this.overrideChoices.get(checkbox.value)?.signature,
            );
        }
        const current = getGenInput();
        const saved = this.gallery.BaseParams;
        const types = gen_param_types.filter((type) =>
            this.overrideParameters.has(type.id),
        );
        const loraKeys = [
            "loras",
            "loraweights",
            "loratencweights",
            "lorasectionconfinement",
        ];
        const groups = [];
        const loras = types.filter((type) => loraKeys.includes(type.id));
        if (loras.length === loraKeys.length) {
            groups.push({
                key: "loras",
                label: "LoRAs and weights",
                types: loras,
            });
        }
        for (const type of types) {
            if (!loraKeys.includes(type.id)) {
                groups.push({ key: type.id, label: type.name, types: [type] });
            }
        }
        const host = query<HTMLElement>(
            this.root,
            ".running-grid-override-list",
        );
        host.replaceChildren();
        this.overrideChoices.clear();
        for (const group of groups) {
            const before = group.types.map((type) =>
                this.overrideComparable(type, saved[type.id]),
            );
            const after = group.types.map((type) =>
                this.overrideComparable(type, current[type.id]),
            );
            if (JSON.stringify(before) === JSON.stringify(after)) {
                continue;
            }
            const values = Object.fromEntries(
                group.types.map((type) => [type.id, current[type.id] ?? null]),
            );
            const signature = JSON.stringify([before, after]);
            this.overrideChoices.set(group.key, { values, signature });
            const row = createDiv(null, "running-grid-override-choice");
            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.value = group.key;
            checkbox.checked = selected.get(group.key) === signature;
            checkbox.addEventListener("change", () =>
                this.updateOverrideCount(),
            );
            label.append(checkbox, document.createTextNode(group.label));
            row.appendChild(label);
            const comparison = createDiv(
                null,
                "running-grid-override-comparison",
            );
            for (const [heading, snapshot] of [
                ["Saved", before],
                ["This run", after],
            ] as const) {
                const column = createDiv(null, "running-grid-override-value");
                const title = document.createElement("strong");
                title.textContent = heading;
                const text = document.createElement("pre");
                text.textContent = group.types
                    .map(
                        (type, index) =>
                            `${group.types.length > 1 ? `${type.name}: ` : ""}${this.overrideDisplay(snapshot[index])}`,
                    )
                    .join("\n");
                column.append(title, text);
                comparison.appendChild(column);
            }
            row.appendChild(comparison);
            host.appendChild(row);
        }
        if (!this.overrideChoices.size) {
            const note = document.createElement("p");
            note.textContent = this.overrideParameters.size
                ? "No eligible differences. Change settings in the generation form, then refresh differences."
                : "Run overrides are unavailable. Restart SwarmUI to load the updated extension.";
            host.appendChild(note);
        }
        this.updateOverrideCount();
        this.updateControls();
        return Array.from(selected).some(
            ([key, signature]) =>
                this.overrideChoices.get(key)?.signature !== signature,
        );
    }

    updateOverrideCount() {
        const count = this.root.querySelectorAll<HTMLInputElement>(
            ".running-grid-override-choice input:checked",
        ).length;
        query<HTMLElement>(
            this.root,
            ".running-grid-override-count",
        ).textContent = count ? `${count} selected` : "None selected";
    }

    clearOverrides() {
        for (const checkbox of this.root.querySelectorAll<HTMLInputElement>(
            ".running-grid-override-choice input",
        )) {
            checkbox.checked = false;
        }
        this.overrideChoices.clear();
        this.updateOverrideCount();
    }

    async capture() {
        if (this.busy) {
            return;
        }
        const title = this.name.value.trim();
        const axes = this.coreAxes();
        if (!title) {
            this.name.focus();
            this.name.reportValidity();
            this.setupMessage.textContent = "Enter a name for this gallery.";
            return;
        }
        if (!axes.length) {
            this.setupMessage.textContent =
                "Add at least one Grid Generator axis above before creating a running grid.";
            extensionGridGen.axisDiv.scrollIntoView({ block: "start" });
            return;
        }
        this.busy = true;
        this.setupMessage.textContent =
            "Saving the gallery and starting generation…";
        this.setupMessage.classList.remove("running-grid-error");
        this.updateControls();
        let createdId = null;
        try {
            const checkbox = (name: string) =>
                (
                    document.getElementById(
                        `grid-gen-opt-${name}`,
                    ) as HTMLInputElement | null
                )?.checked;
            const data = await this.request("RunningGridCreate", {
                title,
                baseParams: getGenInput(),
                gridAxes: axes,
                publishMetadata: checkbox("publish-metadata"),
                weightOrder: checkbox("weight-order"),
                continueOnError: checkbox("continue-on-error"),
                trackModelChanges: this.track.checked,
            });
            createdId = data.id;
            await this.refreshList(data.id);
            this.selectTool("running_grids");
            await this.request("RunningGridRun", { id: data.id });
            resetBatchIfNeeded();
            await this.load(data.id);
            const message =
                "Gallery created. Generating the first images from your saved setup.";
            this.say(message);
            this.setupMessage.textContent = message;
            this.name.value = "";
        } catch (error) {
            const message = createdId
                ? `Gallery saved, but generation could not start: ${errorMessage(error)} Retry with Run missing / changed cells.`
                : errorMessage(error);
            this.say(message, true);
            this.setupMessage.textContent = message;
            this.setupMessage.classList.add("running-grid-error");
        } finally {
            this.busy = false;
            this.updateControls();
        }
    }

    renderDefinition() {
        const gallery = this.gallery;
        if (!gallery) {
            return;
        }
        this.title.textContent = gallery.Title;
        this.axis_title.textContent = `Add columns · ${gallery.Axes[0].Title}`;
        query<HTMLElement>(this.root, ".running-grid-run-note").textContent =
            gallery.TrackModelChanges
                ? "Fills missing images and refreshes models whose file size or modification time changed."
                : "Fills missing images across all columns using this gallery’s saved settings.";
        const axis = gallery.Axes[0];
        const type = gen_param_types.find((type) => type.id === axis.Mode);
        this.values.dataset.placeholder =
            type?.type === "model"
                ? "Click to choose models, or type to search…"
                : "Type or paste values to add…";
        this.values.setAttribute(
            "aria-placeholder",
            this.values.dataset.placeholder,
        );
        if (
            this.valueGalleryId !== gallery.Id ||
            this.valueType.value !== axis.Mode
        ) {
            this.values.innerText = "";
            this.valueGalleryId = gallery.Id;
            this.valueType.replaceChildren(
                new Option(axis.Title, axis.Mode, true, true),
            );
            // Core restores the editor's caret on change; avoid stealing focus during a reload.
            triggerChangeFor(this.valueType);
            triggerChangeFor(this.values);
        }
        this.closeValueSuggestions();
        const settings = {
            baseParams: gallery.BaseParams,
            lockedAxes: gallery.Axes.slice(1).map((axis) => ({
                parameter: axis.Title,
                values: axis.Values.map((value) => value.Params),
            })),
        };
        this.settings.textContent = JSON.stringify(
            settings,
            (_key: string, value: unknown) => {
                if (typeof value === "string" && value.length > 4000) {
                    return `[Captured input: ${value.length.toLocaleString()} characters]`;
                }
                return value;
            },
            2,
        );
        this.members.replaceChildren();
        let position = 0;
        for (const value of gallery.Axes[0].Values) {
            const row = createDiv(null, "running-grid-member");
            row.setAttribute("role", "listitem");
            row.dataset.valueId = value.Id;
            const handle = document.createElement("button");
            handle.type = "button";
            handle.className = "basic-button running-grid-drag-handle";
            handle.innerHTML =
                '<svg viewBox="0 0 16 24" aria-hidden="true"><g fill="currentColor"><circle cx="5" cy="6" r="1.6"/><circle cx="11" cy="6" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="12" r="1.6"/><circle cx="5" cy="18" r="1.6"/><circle cx="11" cy="18" r="1.6"/></g></svg>';
            handle.title =
                "Drag to reorder. Keyboard: Up/Down to move, Home/End to jump.";
            handle.setAttribute("aria-label", `Reorder ${value.Title}`);
            row.appendChild(handle);
            const label = document.createElement("label");
            label.className = "running-grid-member-label";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.value = value.Id;
            const number = document.createElement("span");
            number.className = "running-grid-position";
            number.textContent = String(++position);
            number.title = `Column ${position}`;
            const text = document.createElement("span");
            text.textContent = `${value.Title}${value.Skip ? " (skipped)" : ""}`;
            label.append(checkbox, number, text);
            row.appendChild(label);
            this.members.appendChild(row);
        }
        query<HTMLElement>(
            this.root,
            ".running-grid-column-count",
        ).textContent = `${position} column${position === 1 ? "" : "s"}`;
        query<HTMLElement>(this.root, ".running-grid-members-empty").hidden =
            position > 0;
        this.members.hidden = position === 0;
    }

    renderSummary(summary: RunningGridSummary) {
        this.summary = summary;
        this.progress.textContent = `${summary.status} — ${summary.completed} / ${summary.cells} cells saved.${summary.error ? ` ${summary.error}` : ""}`;
        this.progress.classList.toggle("running-grid-error", !!summary.error);
        this.open.hidden = !summary.published;
        this.open.href = summary.url;
        const similarityStatus = query<HTMLElement>(
            this.root,
            ".running-grid-similarity-status",
        );
        similarityStatus.textContent = summary.similarity_status || "";
        similarityStatus.hidden =
            !summary.similarity_running &&
            (!summary.similarity_status ||
                summary.similarity_status === "Similarity updated");
        if (
            this.message.textContent ===
                "Similarity analysis started. When complete, reload the gallery page to view the similarity order." &&
            !summary.similarity_running
        ) {
            this.say(
                summary.similarity_status ||
                    "Similarity analysis finished. Reload the gallery page to see the results.",
            );
        }
        query<HTMLInputElement>(
            this.root,
            ".running-grid-similarity-auto",
        ).checked = !!summary.similarity_enabled;
        query<HTMLElement>(
            this.root,
            ".running-grid-similarity-setup-note",
        ).hidden = !!summary.similarity_ready;
        this.updateControls();
    }

    outputCursor(id: string) {
        const state = this.liveRuns.get(id);
        return {
            includeOutputs: true,
            runId: state?.runId || "",
            afterOutput: state?.cursor || 0,
        };
    }

    handleLiveOutput(id: string, live?: RunningGridLiveOutput) {
        this.hasMoreOutputs = live?.has_more || false;
        if (!live?.run_id || !this.gallery || !this.summary) {
            return;
        }
        let state = this.liveRuns.get(id);
        if (!state || state.runId !== live.run_id) {
            state = {
                runId: live.run_id,
                cursor: 0,
                images: {},
                discardable: {},
                timeLastGenHit: [Date.now()],
                batchId: mainGenHandler.getBatchId(),
            };
            this.liveRuns.set(id, state);
        }
        for (const output of [
            ...(live.progress || []),
            ...(live.outputs || []),
        ]) {
            mainGenHandler.internalHandleData(
                output,
                state.images,
                state.discardable,
                state.timeLastGenHit,
                this.gallery.BaseParams,
                null,
                null,
                false,
                state.batchId,
            );
        }
        // Completed images already live in the batch DOM; the core grid does not discard them later.
        state.discardable = {};
        state.cursor = live.next_output;
        if (!this.summary.running) {
            mainGenHandler.internalHandleData(
                { discard_indices: Object.keys(state.images) },
                state.images,
                state.discardable,
                state.timeLastGenHit,
                this.gallery.BaseParams,
                null,
                null,
                false,
                state.batchId,
            );
            state.images = {};
        }
    }

    schedulePoll() {
        clearTimeout(this.pollTimer);
        if (!this.gallery) {
            return;
        }
        if (
            !this.summary?.running &&
            !this.summary?.similarity_running &&
            !this.hasMoreOutputs
        ) {
            return;
        }
        const id = this.gallery.Id;
        const version = this.loadVersion;
        this.pollTimer = setTimeout(
            async () => {
                try {
                    const data = await this.request("RunningGridGet", {
                        id,
                        summaryOnly: true,
                        ...this.outputCursor(id),
                    });
                    if (version !== this.loadVersion) {
                        return;
                    }
                    this.renderSummary(data.summary);
                    this.handleLiveOutput(id, data.live);
                    this.schedulePoll();
                } catch (error) {
                    if (version === this.loadVersion) {
                        this.say(
                            `Progress connection interrupted: ${errorMessage(error)}. Refresh the gallery to reconnect.`,
                            true,
                        );
                    }
                }
            },
            this.hasMoreOutputs ? 0 : 1500,
        );
    }

    copyFirstAxis() {
        if (!this.gallery) {
            return;
        }
        const axis = this.coreAxes()[0];
        if (!axis || axis.mode !== this.gallery.Axes[0].Mode) {
            this.say(
                `Grid Generator's first axis must be ${this.gallery.Axes[0].Title}.`,
                true,
            );
            return;
        }
        this.values.innerText = axis.vals;
        triggerChangeFor(this.values);
        this.closeValueSuggestions();
        this.say(
            "First-axis values copied. Run Missing Cells will add new entries and generate them; existing entries will be skipped.",
        );
    }

    async mutate<Route extends RunningGridMutation>(
        route: Route,
        payload: Record<string, unknown>,
        message: string | ((result: RunningGridResponses[Route]) => string),
    ) {
        if (!this.gallery || this.busy) {
            return;
        }
        const id = this.gallery.Id;
        this.busy = true;
        this.updateControls();
        try {
            if (route === "RunningGridRun" && this.values.innerText.trim()) {
                await this.request("RunningGridAppend", {
                    id,
                    values: this.values.innerText,
                });
            }
            const result = await this.request(route, { id, ...payload });
            if (route === "RunningGridAppend" || route === "RunningGridRun") {
                this.values.innerText = "";
                triggerChangeFor(this.values);
                this.closeValueSuggestions();
            }
            if (route === "RunningGridRun") {
                this.clearOverrides();
                resetBatchIfNeeded();
            }
            await this.load(id);
            this.say(typeof message === "function" ? message(result) : message);
        } catch (error) {
            this.say(errorMessage(error), true);
        } finally {
            this.busy = false;
            this.updateControls();
        }
    }

    async analyzeSimilarity() {
        await this.mutate(
            "RunningGridSimilarity",
            {
                action: this.summary?.similarity_ready ? "analyze" : "setup",
                automatic: !!this.summary?.similarity_enabled,
            },
            () =>
                this.summary?.similarity_running
                    ? "Similarity analysis started. When complete, reload the gallery page to view the similarity order."
                    : this.summary?.similarity_status ||
                      "Similarity analysis finished. Reload the gallery page to see the results.",
        );
    }

    startColumnDrag(event: PointerEvent) {
        const handle = (event.target as Element).closest<HTMLButtonElement>(
            ".running-grid-drag-handle",
        );
        if (
            !handle ||
            handle.disabled ||
            event.button !== 0 ||
            !event.isPrimary ||
            this.columnDrag
        ) {
            return;
        }
        const row = handle.closest<ColumnRow>(".running-grid-member");
        if (!row) {
            return;
        }
        event.preventDefault();
        handle.focus({ preventScroll: true });
        let scrollPane = this.members.parentElement;
        while (
            scrollPane &&
            !(
                scrollPane.scrollHeight > scrollPane.clientHeight &&
                /auto|scroll/.test(getComputedStyle(scrollPane).overflowY)
            )
        ) {
            scrollPane = scrollPane.parentElement;
        }
        this.columnDrag = {
            handle,
            row,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            started: false,
            target: null,
            frame: null,
            scrollPane:
                scrollPane ||
                document.scrollingElement ||
                document.documentElement,
        };
        handle.setPointerCapture(event.pointerId);
    }

    updateColumnDrag(event: PointerEvent) {
        const drag = this.columnDrag;
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        event.preventDefault();
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (
            !drag.started &&
            Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5
        ) {
            drag.started = true;
            drag.row.classList.add("running-grid-dragging");
            this.members.classList.add("running-grid-drag-active");
            this.scrollColumnDrag();
        }
        if (drag.started) {
            this.markColumnDrop();
        }
    }

    markColumnDrop() {
        const drag = this.columnDrag;
        if (!drag) {
            return;
        }
        drag.target?.row.classList.remove(
            "running-grid-drop-before",
            "running-grid-drop-after",
        );
        drag.target = null;
        const bounds = this.members.getBoundingClientRect();
        const pane = drag.scrollPane.getBoundingClientRect();
        // Include a small drop zone beyond the end rows, including the pane's padding after auto-scroll.
        if (
            drag.x < bounds.left ||
            drag.x > bounds.right ||
            drag.y < Math.max(0, bounds.top - 24, pane.top) ||
            drag.y >
                Math.min(window.innerHeight, bounds.bottom + 24, pane.bottom)
        ) {
            return;
        }
        const rows = Array.from(this.members.children) as ColumnRow[];
        const original = rows.indexOf(drag.row);
        rows.splice(original, 1);
        let destination = rows.findIndex((row) => {
            const rect = row.getBoundingClientRect();
            return drag.y < rect.top + rect.height / 2;
        });
        const after = destination < 0;
        if (after) {
            destination = rows.length;
        }
        if (destination === original) {
            return;
        }
        const row = rows[after ? rows.length - 1 : destination];
        drag.target = { row, after };
        row.classList.add(
            after ? "running-grid-drop-after" : "running-grid-drop-before",
        );
    }

    scrollColumnDrag() {
        const drag = this.columnDrag;
        if (!drag?.started) {
            return;
        }
        const pane = drag.scrollPane;
        const rect = pane.getBoundingClientRect();
        const top = Math.max(0, rect.top),
            bottom = Math.min(window.innerHeight, rect.bottom);
        if (
            drag.x >= rect.left &&
            drag.x <= rect.right &&
            drag.y >= top &&
            drag.y <= bottom
        ) {
            const speed =
                drag.y < top + 36
                    ? -Math.min(12, (top + 36 - drag.y) / 3)
                    : drag.y > bottom - 36
                      ? Math.min(12, (drag.y - bottom + 36) / 3)
                      : 0;
            const previous = pane.scrollTop;
            pane.scrollTop += speed;
            if (pane.scrollTop !== previous) {
                this.markColumnDrop();
            }
        }
        drag.frame = requestAnimationFrame(() => this.scrollColumnDrag());
    }

    cancelColumnDrag() {
        const drag = this.columnDrag;
        if (!drag) {
            return;
        }
        this.columnDrag = null;
        if (drag.frame !== null) {
            cancelAnimationFrame(drag.frame);
        }
        drag.target?.row.classList.remove(
            "running-grid-drop-before",
            "running-grid-drop-after",
        );
        drag.row.classList.remove("running-grid-dragging");
        this.members.classList.remove("running-grid-drag-active");
        if (drag.handle.hasPointerCapture(drag.pointerId)) {
            drag.handle.releasePointerCapture(drag.pointerId);
        }
    }

    finishColumnDrag(event: PointerEvent) {
        const drag = this.columnDrag;
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        this.updateColumnDrag(event);
        const target = drag.target;
        this.cancelColumnDrag();
        if (target) {
            this.moveValue(
                drag.row.dataset.valueId,
                target.row.dataset.valueId,
                target.after,
            );
        } else if (drag.started) {
            this.say("Column order unchanged.");
        }
    }

    columnDragKey(event: KeyboardEvent) {
        if (event.key === "Escape" && this.columnDrag) {
            event.preventDefault();
            this.cancelColumnDrag();
            this.say("Column move cancelled.");
            return;
        }
        const handle = (event.target as Element).closest<HTMLButtonElement>(
            ".running-grid-drag-handle",
        );
        if (
            !handle ||
            handle.disabled ||
            this.columnDrag ||
            !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
        ) {
            return;
        }
        event.preventDefault();
        const rows = Array.from(this.members.children) as ColumnRow[];
        const row = handle.closest<ColumnRow>(".running-grid-member");
        if (!row) {
            return;
        }
        const index = rows.indexOf(row);
        const after = event.key === "ArrowDown" || event.key === "End";
        const target =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rows.length - 1
                  : index + (after ? 1 : -1);
        if (target >= 0 && target < rows.length && target !== index) {
            this.moveValue(
                rows[index].dataset.valueId,
                rows[target].dataset.valueId,
                after,
            );
        }
    }

    async moveValue(valueId: string, targetId: string, after: boolean) {
        if (
            !this.gallery ||
            this.busy ||
            this.summary?.running ||
            this.summary?.similarity_running
        ) {
            return;
        }
        const id = this.gallery.Id;
        const selected = new Set(
            Array.from(
                this.members.querySelectorAll<HTMLInputElement>(
                    "input:checked",
                ),
            ).map((input) => input.value),
        );
        await this.mutate(
            "RunningGridMoveValue",
            { valueId, targetId, after },
            (result) =>
                result.moved
                    ? "Column order saved. Refresh the gallery page to see the new order."
                    : "Column order unchanged.",
        );
        if (this.gallery?.Id !== id) {
            return;
        }
        for (const row of Array.from(this.members.children) as ColumnRow[]) {
            query<HTMLInputElement>(row, "input").checked = selected.has(
                row.dataset.valueId,
            );
            if (row.dataset.valueId === valueId) {
                row.querySelector<HTMLButtonElement>(
                    ".running-grid-drag-handle",
                )?.focus({ preventScroll: true });
            }
        }
        this.updateControls();
    }

    async append() {
        const values = this.values.innerText;
        if (!values.trim()) {
            this.say("Enter first-axis values to add.", true);
            return;
        }
        await this.mutate(
            "RunningGridAppend",
            { values },
            (result) =>
                `${result.added} new values added. Run missing cells when ready.`,
        );
    }

    async deleteGallery() {
        if (
            !this.gallery ||
            this.busy ||
            this.summary?.running ||
            this.summary?.similarity_running
        ) {
            return;
        }
        const { Id: id, Title: title } = this.gallery;
        const count =
            this.summary?.completed ??
            Object.keys(this.gallery.Completed || {}).length;
        if (
            !window.confirm(
                `Permanently delete “${title}” (${count} saved cells)?\n\nThis deletes its saved settings, gallery page, all gallery images, and similarity results. This cannot be undone. Model files and other galleries are kept.`,
            )
        ) {
            return;
        }
        this.busy = true;
        this.updateControls();
        try {
            await this.request("RunningGridDelete", { id });
            this.liveRuns.delete(id);
            this.hasMoreOutputs = false;
            this.values.innerText = "";
            await this.load("");
            // Remove the stale option immediately, even if refreshing the remaining list fails.
            this.selector
                .querySelector<HTMLOptionElement>(
                    `option[value="${CSS.escape(id)}"]`,
                )
                ?.remove();
            this.selector.value = "";
            await this.refreshList();
            this.say(`Deleted “${title}” and its gallery files.`);
        } catch (error) {
            this.say(errorMessage(error), true);
        } finally {
            this.busy = false;
            this.updateControls();
        }
    }

    async removeSelected() {
        const valueIds = Array.from(
            this.members.querySelectorAll<HTMLInputElement>("input:checked"),
        ).map((input) => input.value);
        if (!valueIds.length) {
            this.say("Select first-axis values first.", true);
            return;
        }
        if (
            !window.confirm(
                "Remove the selected columns and permanently delete their generated images from this gallery? Model files and other galleries will remain unchanged.",
            )
        ) {
            return;
        }
        await this.mutate(
            "RunningGridMembership",
            { valueIds, removed: true },
            "Selected columns and their gallery images deleted.",
        );
    }

    async run() {
        if (
            this.busy ||
            this.summary?.running ||
            this.summary?.similarity_running
        ) {
            return;
        }
        if (!this.gallery) {
            this.configureGrid();
            this.setupMessage.textContent =
                "Set up the axes above, name your gallery here, then click Create & generate.";
            return;
        }
        if (this.refreshOverrides()) {
            query<HTMLDetailsElement>(
                this.root,
                ".running-grid-overrides",
            ).open = true;
            this.say(
                "Selected settings changed in the generation form. Review and reselect those overrides before running.",
                true,
            );
            return;
        }
        const overrides = {};
        for (const checkbox of this.root.querySelectorAll<HTMLInputElement>(
            ".running-grid-override-choice input:checked",
        )) {
            Object.assign(
                overrides,
                this.overrideChoices.get(checkbox.value)?.values,
            );
        }
        const hasOverrides = Object.keys(overrides).length > 0;
        await this.mutate(
            "RunningGridRun",
            hasOverrides ? { overrides } : {},
            () =>
                this.summary?.status === "Complete"
                    ? "Gallery is up to date. All cells are complete."
                    : hasOverrides
                      ? "Generating missing or changed cells with selected overrides for this run only."
                      : "Generating missing or changed cells from saved settings.",
        );
    }

    async stop() {
        await this.mutate(
            "RunningGridCancel",
            {},
            "Stop requested. Completed cells will be kept.",
        );
    }
}

export const runningGridHelper = new RunningGridHelper();
// Keep the original script globals available after bundling as an IIFE.
Object.assign(globalThis, { RunningGridHelper, runningGridHelper });
sessionReadyCallbacks.push(() => {
    if (
        permissions.hasPermission("gridgen_read_grids") &&
        permissions.hasPermission("gridgen_generate_grids")
    ) {
        // Extension callback order is not guaranteed; defer until this callback batch has completed.
        setTimeout(() => runningGridHelper.register(), 0);
    }
});
