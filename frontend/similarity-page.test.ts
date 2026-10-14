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
    });

    test("excludes pairs for removed columns", () => {
        expect(
            chain(["b", "a"], [edge("removed", "a", 0), edge("a", "b", 0.2)]),
        ).toEqual(["a", "b"]);
    });
});

describe("similarity aggregation", () => {
    test("averages LPIPS across all rows", () => {
        const score = math.summarize(pair("a", "b", [0, 0.05]), 2);
        expect(score.mean).toBe(0.025);
    });
});

describe("reference ordering", () => {
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

    test("pins the reference when comparisons are absent", () => {
        expect(fromReference(["c", "a", "b"], [], "a")).toEqual([
            "a",
            "c",
            "b",
        ]);
    });
});
