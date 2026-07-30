// Streaming token observer/accumulator for the P1 stress harness.
//
// Why this exists: `tmux history-limit 2000` means a single final pane
// capture cannot retain 100 trial tokens. A final-only verdict would report
// spurious "lost" tokens that were delivered fine but scrolled out of the
// captured window. Instead we capture after every completed send (and on
// failures / final) and ACCUMULATE evidence across snapshots.
//
// Accumulation rules (see docs/STRESS.md):
//   - First-seen order: the order in which a token first appears across all
//     snapshots. This is the honest chronological delivery order and feeds the
//     reorder check.
//   - Max simultaneous count: for each token, the maximum number of times it
//     appeared in any ONE snapshot. A token that persists in scrollback across
//     many snapshots (count 1 each) stays max-count 1 -> NOT a duplicate. Two
//     copies of the same token in a single snapshot -> max-count 2 -> duplicate
//     (real evidence of a double injection).
//   - Foreign/unexpected tokens are retained (they surface as "extra" against
//     the planned set in computeVerdict).
//
// The effective observed multiset fed to computeVerdict expands each first-seen
// token by its max simultaneous count, in first-seen order.
//
// Residual limitation (documented, not hidden): max-snapshot counting can miss
// two occurrences of a token that NEVER coexist in one retained snapshot. The
// at-most-once injection model and the command journal make that case unlikely,
// but this is not a perfect exactly-once proof.

export function createTokenObserver({ pattern }) {
  if (!pattern || typeof pattern.exec !== "function") {
    throw new Error("createTokenObserver requires a RegExp pattern");
  }
  const global = pattern.flags.includes("g")
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);

  const firstSeenOrder = [];
  const seenSet = new Set();
  const maxCount = new Map();
  const snapshotLog = [];
  let captureErrors = 0;
  let lastCaptureError = null;
  let totalIngested = 0;

  function extract(text) {
    if (text == null) return [];
    global.lastIndex = 0;
    const ids = [];
    let match;
    while ((match = global.exec(String(text))) !== null) {
      ids.push(match[1] ?? match[0]);
      if (match.index === global.lastIndex) global.lastIndex += 1;
    }
    return ids;
  }

  // Ingest one pane snapshot. Returns { observed, distinct } for this snapshot.
  function ingestText(text, meta = {}) {
    const ids = extract(text);
    const counts = new Map();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) {
      if (!seenSet.has(id)) {
        seenSet.add(id);
        firstSeenOrder.push(id);
      }
      if (n > (maxCount.get(id) ?? 0)) maxCount.set(id, n);
    }
    totalIngested += ids.length;
    snapshotLog.push({
      phase: meta.phase ?? null,
      observed: ids.length,
      distinct: counts.size,
      error: null,
    });
    return { observed: ids.length, distinct: counts.size };
  }

  // Record a capture failure instead of dropping the observation. The run must
  // fail closed on any capture error (summary.captureErrors > 0).
  function ingestError(error, meta = {}) {
    captureErrors += 1;
    lastCaptureError = error?.message ?? String(error);
    snapshotLog.push({
      phase: meta.phase ?? null,
      observed: 0,
      distinct: 0,
      error: lastCaptureError,
    });
  }

  // Effective observed multiset: each first-seen token repeated by its max
  // simultaneous count, in first-seen order.
  function effectiveObserved() {
    const out = [];
    for (const id of firstSeenOrder) {
      const n = maxCount.get(id) ?? 0;
      for (let i = 0; i < n; i += 1) out.push(id);
    }
    return out;
  }

  function maxConcurrent() {
    let m = 0;
    for (const n of maxCount.values()) if (n > m) m = n;
    return m;
  }

  function summary() {
    return {
      mode: "streaming",
      snapshots: snapshotLog.length,
      captureErrors,
      lastCaptureError,
      distinctTokens: firstSeenOrder.length,
      maxConcurrent: maxConcurrent(),
      firstSeenSample: firstSeenOrder.slice(0, 8),
    };
  }

  return {
    ingestText,
    ingestError,
    effectiveObserved,
    summary,
    get snapshotLog() {
      return snapshotLog.map((s) => ({ ...s }));
    },
    get firstSeenOrder() {
      return [...firstSeenOrder];
    },
  };
}
