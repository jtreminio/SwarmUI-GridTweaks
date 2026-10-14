const { createDefaultPreset } = require("ts-jest");

/** @type {import('jest').Config} */
module.exports = {
    ...createDefaultPreset({ tsconfig: "./tsconfig.jest.json" }),
    clearMocks: true,
    collectCoverageFrom: [
        "<rootDir>/frontend/**/*.ts",
        "!<rootDir>/frontend/**/*.test.ts",
        "!<rootDir>/frontend/**/*.d.ts",
    ],
    coverageDirectory: "<rootDir>/coverage",
    coverageReporters: ["json", "json-summary", "text-summary"],
    testEnvironment: "jsdom",
    testMatch: ["<rootDir>/frontend/**/*.test.ts"],
};
