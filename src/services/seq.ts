/**
 * Sequence recovery.
 *
 * The posting engine, the invoice service and the audit trail all hold their
 * counters in memory. That is fine for the life of one process and WRONG the
 * moment the process restarts against books that already exist: the counter
 * begins at zero, the next generated id collides with a stored one, and
 * `MemoryRepository.saveEntry` correctly refuses it ("Entry AS-0001 is
 * immutable"). The symptom is that the first posting after every restart or
 * serverless cold start fails.
 *
 * The fix is to recover each counter from the ids already persisted. Ids are
 * `PREFIX-0000`, so the highest trailing number is the watermark. Anything that
 * does not match the prefix is ignored rather than guessed at.
 */

export function highestSeq(ids: readonly string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
