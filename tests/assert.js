// Tiny test helpers for the gjs unit tests (run with tests/run.sh).
let failures = 0;
let checks = 0;

export function equal(actual, expected, label = '') {
    checks++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        failures++;
        print(`  FAIL ${label}: expected ${e}, got ${a}`);
    }
}

export function ok(condition, label = '') {
    equal(Boolean(condition), true, label);
}

export function done(name) {
    print(`${name}: ${checks - failures}/${checks} checks passed`);
    if (failures > 0)
        imports.system.exit(1);
}
