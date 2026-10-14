import type {
    GridViewerAxis,
    GridViewerValue,
    RunningGridSimilarityMath,
    RunningGridSimilarityPage,
    SimilarityData,
} from "./similarity-page";

declare global {
    const rawData: { axes: GridViewerAxis[] };
    const popoverLastImg: HTMLImageElement | null;
    function setShowVal(axis: string, value: string, show: boolean): void;
    function toggleShowVal(axis: string, value: string): void;
    function canShowVal(axis: string, value: string): boolean;
    function fillTable(): void;
    function getAxisById(id: string): GridViewerAxis | undefined;
    function getShownItemsOfAxis(axis: GridViewerAxis): GridViewerValue[];
    function getCurrentSelectedAxis(prefix: "x" | "y"): string;

    interface Window {
        RunningGridSimilarityMath: typeof RunningGridSimilarityMath;
        RunningGridSimilarityPage: typeof RunningGridSimilarityPage;
        runningGridSimilarityData?: SimilarityData;
        runningGridSimilarityPage?: RunningGridSimilarityPage;
    }
}
