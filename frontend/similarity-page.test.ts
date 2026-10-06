import { describe, expect, test } from "@jest/globals";
import {
    RunningGridSimilarityMath as math,
    type SimilarityPair,
} from "./similarity-page";

const pair = (a: string, b: string, scores: number[]): SimilarityPair => ({
    a,
    b,
    rows: scores.map((score, index) => ({
        key: `seed${index}`,
        lpips: score,
        settings: "same",
    })),
});
const edge = (a: string, b: string, score: number) =>
    pair(a, b, [score, score]);
const chain = (columns: string[], pairs: SimilarityPair[]) =>
    math.chain(columns, pairs, 2);
const fromReference = (
    columns: string[],
    pairs: SimilarityPair[],
    reference: string,
) => math.fromReference(columns, pairs, 2, reference);
const pairs = [
    edge("a", "b", 0.5),
    edge("a", "c", 0.4),
    edge("a", "d", 0.3),
    pair("b", "c", [0, 0.02]),
    edge("b", "d", 0.2),
    edge("c", "d", 0.1),
];

describe("similarity chain", () => {
    test("starts with the closest mean distance, independent of saved order and pair order", () => {
        expect(chain(["a", "d", "c", "b"], pairs)).toEqual([
            "b",
            "c",
            "d",
            "a",
        ]);
        expect(chain(["c", "a", "b", "d"], [...pairs].reverse())).toEqual([
            "b",
            "c",
            "d",
            "a",
        ]);
    });

    test("reverses the closest pair when its other endpoint offers a better next link", () => {
        expect(
            chain(
                ["a", "b", "c"],
                [
                    edge("a", "b", 0.01),
                    edge("a", "c", 0.1),
                    edge("b", "c", 0.3),
                ],
            ),
        ).toEqual(["b", "a", "c"]);
    });

    test("includes large distances without an absolute cutoff", () => {
        expect(
            chain(
                ["a", "b", "c"],
                [edge("a", "b", 0.8), edge("a", "c", 0.7), edge("b", "c", 0.4)],
            ),
        ).toEqual(["b", "c", "a"]);
    });

    test("uses the last endpoint and closest unused model, not a cluster average", () => {
        const greedy = [
            edge("a", "b", 0.01),
            edge("a", "c", 0.4),
            edge("a", "d", 0.5),
            edge("a", "e", 0.6),
            edge("b", "c", 0.1),
            edge("b", "d", 0.2),
            edge("b", "e", 0.3),
            edge("c", "d", 0.8),
            edge("c", "e", 0.7),
            edge("d", "e", 0.02),
        ];
        expect(chain(["e", "d", "c", "b", "a"], greedy)).toEqual([
            "a",
            "b",
            "c",
            "e",
            "d",
        ]);
    });

    test("resolves ties deterministically and accepts zero distance", () => {
        expect(
            chain(
                ["c", "b", "a"],
                [edge("a", "b", 0), edge("b", "c", 0), edge("a", "c", 0)],
            ),
        ).toEqual(["a", "b", "c"]);
    });

    test("ignores incomplete perfect matches and retains saved order for unscored tails", () => {
        const missing = [
            edge("a", "b", 0.1),
            pair("a", "missing", [0]),
            edge("c", "d", 0.2),
        ];
        expect(
            chain(["unscored", "d", "missing", "c", "b", "a"], missing),
        ).toEqual(["a", "b", "c", "d", "unscored", "missing"]);
        expect(chain(["b", "a"], [])).toEqual(["b", "a"]);
        expect(chain([], [])).toEqual([]);
        expect(chain(["only"], [])).toEqual(["only"]);
    });

    test("excludes pairs for removed columns", () => {
        expect(
            chain(["b", "a"], [edge("removed", "a", 0), edge("a", "b", 0.2)]),
        ).toEqual(["a", "b"]);
    });
});

describe("similarity aggregation", () => {
    test("reports LPIPS means, worst distance, and complete coverage", () => {
        const score = math.summarize(pair("a", "b", [0, 0.05]), 2);
        expect(score.mean).toBe(0.025);
        expect(score.worst).toBe(0.05);
        expect(score.complete).toBe(true);
    });

    test("ignores retired measurements on old pages", () => {
        const legacyPair = pair("a", "b", [0, 0.05]);
        Object.assign(legacyPair.rows[0], { ssim: null });
        Object.assign(legacyPair.rows[1], { ssim: 0.99 });
        expect(math.summarize(legacyPair, 2)).toEqual(
            math.summarize(pair("a", "b", [0, 0.05]), 2),
        );
    });

    test("does not count missing or non-finite measurements as complete pairs", () => {
        expect(math.summarize(pair("a", "b", [0]), 2).complete).toBe(false);
        expect(math.summarize(null, 2).mean).toBeNull();
        expect(math.summarize(null, 0).complete).toBe(false);
        const invalid = math.summarize(pair("a", "b", [0.1, NaN]), 2);
        expect(invalid.count).toBe(1);
        expect(invalid.complete).toBe(false);
    });

    test("reports changed and unknown settings provenance", () => {
        const provenance = pair("a", "b", [0.1, 0.2]);
        provenance.rows[0].settings = "different";
        provenance.rows[1].settings = "unknown";
        expect(math.summarize(provenance, 2).different).toBe(true);
        expect(math.summarize(provenance, 2).unknown).toBe(true);
    });
});

describe("reference ordering", () => {
    test("pins the selected column and ranks every column against it", () => {
        expect(fromReference(["b", "c", "a", "d"], pairs, "a")).toEqual([
            "a",
            "d",
            "c",
            "b",
        ]);
        expect(fromReference(["b", "c", "a", "d"], pairs, "c")).toEqual([
            "c",
            "b",
            "d",
            "a",
        ]);
    });

    test("ignores pair orientation and input order while retaining unscored tail order", () => {
        const referencePairs = [
            edge("b", "a", 0),
            edge("c", "a", 0.2),
            edge("a", "d", 0.2),
            pair("a", "partial", [0]),
            edge("removed", "a", 0),
        ];
        expect(
            fromReference(
                ["missing", "d", "partial", "c", "b", "a"],
                referencePairs,
                "a",
            ),
        ).toEqual(["a", "b", "c", "d", "missing", "partial"]);
        expect(
            fromReference(
                ["partial", "c", "d", "a", "missing", "b"],
                [...referencePairs].reverse(),
                "a",
            ),
        ).toEqual(["a", "b", "c", "d", "partial", "missing"]);
    });

    test("preserves saved order with absent comparisons or references", () => {
        expect(fromReference(["c", "a", "b"], [], "a")).toEqual([
            "a",
            "c",
            "b",
        ]);
        expect(fromReference(["b", "a"], [], "removed")).toEqual(["b", "a"]);
        expect(fromReference(["a"], [], "a")).toEqual(["a"]);
        expect(fromReference([], [], "a")).toEqual([]);
    });
});
