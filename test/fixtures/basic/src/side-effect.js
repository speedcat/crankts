if (process.env.CRANKTS_FIXTURE_SHOULD_NOT_RUN === "yes") {
    throw new Error("Analyzed source was executed.");
}
export function safeFixtureFunction() {
    return 1;
}
