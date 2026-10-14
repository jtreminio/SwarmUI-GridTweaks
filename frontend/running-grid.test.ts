import { beforeAll, expect, test } from "@jest/globals";
import type { RunningGridHelper } from "./running-grid";

let helper: RunningGridHelper;
beforeAll(async () => {
    Object.assign(globalThis, { sessionReadyCallbacks: [] });
    helper = (await import("./running-grid")).runningGridHelper;
});

test.each([
    ["red|||blue", ["red|||blue"], true],
    [" , red , , green, ", ["red", "green"], true],
    [" \n|||\n red,blue \n|||\n \n|||\n green ", ["red,blue", "green"], true],
])("compares saved list %p with current list %p", (saved, current, equal) => {
    const type = { id: "testlist", name: "Test list", type: "list" };
    const savedValue = helper.overrideComparable(type, saved);
    const currentValue = helper.overrideComparable(type, current);
    expect(JSON.stringify(savedValue) === JSON.stringify(currentValue)).toBe(
        equal,
    );
});
