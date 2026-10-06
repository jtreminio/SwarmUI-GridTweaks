import type {
    RunningGridDocument,
    RunningGridSummary,
} from "../frontend/running-grid";

export interface RequestInput {
    id?: string;
    title?: string;
    baseParams?: Record<string, unknown>;
    gridAxes?: { mode: string; vals: string }[];
    values?: string;
    valueIds?: string[];
    valueId?: string;
    targetId?: string;
    after?: boolean;
    action?: string;
    automatic?: boolean;
    overrides?: Record<string, unknown>;
}

interface Response {
    id?: string;
    galleries?: RunningGridSummary[];
    gallery?: RunningGridDocument;
    summary?: RunningGridSummary;
    override_parameters?: string[];
    success?: boolean;
    added?: number;
    moved?: boolean;
    started?: boolean;
}

export interface RunningGridTestState {
    sessionReadyCallbacks: (() => void)[];
    postParamBuildSteps: (() => void)[];
    permissions: { hasPermission(permission: string): boolean };
    getUserSetting(): boolean;
    isParamAdvanced(): boolean;
    gen_param_types: {
        id: string;
        name: string;
        type: string;
        subtype?: string;
        min?: number;
        max?: number;
        values?: string[];
    }[];
    coreModelMap: Record<string, string[]>;
    toolSelector: HTMLSelectElement;
    triggerChangeFor(element: HTMLElement): void;
    registerNewTool(
        id: string,
        title: string,
        generateLabel: string,
        run: () => void,
    ): HTMLDivElement;
    coreValues: { mode: string; vals: string }[];
    getGenInput(): Record<string, unknown>;
    resetBatchIfNeeded(): void;
    batchReset: boolean;
    calls: { route: string; input: RequestInput }[];
    gallery: RunningGridDocument | null;
    running: boolean;
    allComplete: boolean;
    failNext: boolean;
    failRun: boolean;
    deletedValues: Map<
        string,
        RunningGridDocument["Axes"][number]["Values"][number]
    >;
    genericRequest(
        route: string,
        input: RequestInput,
        success: (data: Response) => void,
        depth: number,
        failure: (message: string) => void,
    ): void;
    currentForm: Record<string, unknown>;
    savedBeforeOverrides: string;
    similarityState: {
        running: boolean;
        ready: boolean;
        automatic: boolean;
        completedGets: number;
    };
}

export interface CoreGenerateHandler {
    batchDiv: HTMLDivElement;
    setCurrentImage(): void;
    gotImageResult(image: string, metadata: string, id: string): HTMLDivElement;
    gotImagePreview(
        image: string,
        metadata: string,
        id: string,
    ): HTMLDivElement;
}

interface ImageOutput extends Record<string, unknown> {
    image: string;
    metadata: string;
    request_id: string;
    batch_index: string;
}

interface ProgressOutput extends Record<string, unknown> {
    gen_progress: {
        request_id: string;
        batch_index: string;
        preview: string;
        metadata: string;
        current_percent: number;
        overall_percent: number;
    };
}

export interface BatchTestState {
    sessionReadyCallbacks: (() => void)[];
    isVideoExt(): boolean;
    isAudioExt(): boolean;
    getUserSetting(): boolean;
    autoLoadPreviewsElem: { checked: boolean };
    imageFullView: { isOpen(): boolean };
    createDiv(id: string, classes: string, html?: string): HTMLDivElement;
    mainGenHandler: CoreGenerateHandler;
    pixel: string;
    metadata: string;
    progress(index: number): ProgressOutput;
    output(index: number, request?: string): ImageOutput;
}
