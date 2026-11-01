#!/usr/bin/env bash
# Acceptance checklist. Every phase either runs or fails the build; a phase that
# cannot run is a red result, never a skip. A script that prints ALL CHECKS
# PASSED after executing nothing is worse than one that errors.
set -uo pipefail
cd "$(dirname "$0")"

NODE=${NODE:-$(command -v node || true)}
STATUS=0
report() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; STATUS=1; }

# Flags belong to specific phases, so pull them out here rather than handing
# every phase the whole argument list. `--update` and `--engine` continue on to
# the golden screenshots via "$@"; `--engines` is consumed here.
ENGINES_FLAG=()
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ ${args[$i]} == '--engines' ]]; then
    ENGINES_FLAG=(--engines "${args[$((i + 1))]:-}")
    if [[ -z ${args[$((i + 1))]:-} ]]; then
      echo "--engines needs a value, for example --engines firefox,chromium" >&2
      exit 2
    fi
  fi
done

if [[ -z $NODE ]]; then
  fail "node is not on PATH. Run inside the project shell: nix develop --command ./check.sh"
  exit $STATUS
fi

# 1. Build. Tests read the artifact, so a stale artifact must not be able to pass.
report "1/5 build artifact"
if "$NODE" tools/build.mjs; then
  :
else
  fail "build failed"
fi

# 2. Bundles and tools must parse. Cheap, and it localises a syntax error to the
#    file that has it rather than to whichever test happened to import it first.
report "2/5 syntax"
for file in src/*.js tools/*.mjs tests/*.mjs; do
  if ! "$NODE" --experimental-vm-modules -e '
    const fs = require("fs"), vm = require("vm");
    const file = process.argv[1];
    try { new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file }); }
    catch (error) { console.error(`${file}: ${error.message}`); process.exit(1); }
  ' "$file"; then
    fail "syntax error in $file"
  fi
done

# 3. Unit and interaction tests, using Node's own test runner.
#
# Each file is run directly rather than via `--test`, because `--test` reports one
# result per *file*, so its "# pass" line counts files and could read 3 while the
# suite inside it had failed to even load. Running the files and summing their own
# counts is what makes the minimum-test-count guard below mean something.
report "3/5 unit + interaction tests"
: >.tmp/test-output.txt
PASSED_TOTAL=0
for spec in tests/sim.test.mjs tests/app.test.mjs tests/build.test.mjs; do
  if "$NODE" "$spec" >.tmp/one-test.txt 2>&1; then
    :
  else
    fail "$spec failed (output below)"
    cat .tmp/one-test.txt
  fi
  passed=$(grep -E '^# pass [0-9]+$' .tmp/one-test.txt | tail -n 1 | awk '{print $3}')
  failed=$(grep -E '^# fail [0-9]+$' .tmp/one-test.txt | tail -n 1 | awk '{print $3}')
  passed=${passed:-0}
  failed=${failed:-0}
  PASSED_TOTAL=$((PASSED_TOTAL + passed))
  printf '%-26s %s passed, %s failed\n' "$spec" "$passed" "$failed"
  if [[ $failed -ne 0 ]]; then
    fail "$spec reported $failed failure(s)"
  fi
  echo "----- $spec -----" >>.tmp/test-output.txt
  cat .tmp/one-test.txt >>.tmp/test-output.txt
done
printf 'total: %s tests passed\n' "$PASSED_TOTAL"
if [[ $PASSED_TOTAL -lt 40 ]]; then
  fail "expected at least 40 tests to pass, counted $PASSED_TOTAL"
fi

# 4. Engine coverage. The goldens are painted by one engine, which says nothing
#    about whether the app runs in the others people actually use, so each
#    required engine is booted and played with in turn. See tools/browser.mjs for
#    which ones can start in which sandbox.
#
# `--engines` narrows this list, for a machine where an engine cannot start at
# all - Chromium needs user-namespace syscalls that some sandboxes deny. It is
# given only to this phase: forwarding every flag to every phase would let
# `--engine`, which the screenshots take, reach the tests that do not read it.
report "4/5 engine coverage"
if [[ -n ${PLAYWRIGHT_ENTRY:-} && -n ${PLAYWRIGHT_BROWSERS_PATH:-} ]]; then
  if "$NODE" tests/engines.test.mjs "${ENGINES_FLAG[@]}"; then
    :
  else
    fail "engine coverage failed"
  fi
else
  fail "browser toolchain is not configured, so no engine beyond none was checked"
fi

# 5. Golden screenshots. Needs a browser, which needs privileges the plain
#    sandbox does not grant; without it the visual contract is unverified, so
#    this is a failure and not a skip.
report "5/5 golden screenshots"
if [[ -n ${PLAYWRIGHT_ENTRY:-} && -n ${PLAYWRIGHT_BROWSERS_PATH:-} ]]; then
  if "$NODE" tests/golden.test.mjs "$@"; then
    :
  else
    fail "golden screenshot comparison failed"
  fi
else
  fail "browser toolchain is not configured (PLAYWRIGHT_ENTRY / PLAYWRIGHT_BROWSERS_PATH unset), so no page was painted. Run: nix develop --command ./check.sh"
fi

printf '\n'
if [[ $STATUS -eq 0 ]]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit $STATUS
