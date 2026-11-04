// tests/check.js
// A tiny test helper shared by the test files.

let failures = 0;

export function check(name, ok, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
}

/** Call at the end of a test file. Exits with an error code if anything failed. */
export function finish() {
  console.log(failures === 0 ? "\nAll tests passed." : "\n" + failures + " test(s) FAILED.");
  process.exit(failures === 0 ? 0 : 1);
}
