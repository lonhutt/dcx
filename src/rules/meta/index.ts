import type { Rule } from "../rule";
import { rule } from "../util";

/**
 * Registered like any rule, so it has an ID, a severity and docs; but its findings come
 * from the suppression pass in `analyze`, which runs after every other rule.
 */
export const unusedSuppression = rule({
  id: "meta/unused-suppression",
  description: "A dcx-disable-* directive suppressed nothing",
  explain: `A dcx-disable-line, dcx-disable-next-line or dcx-disable-file comment that
doesn't silence anything: the problem it was added for has been fixed, the rule ID is
misspelt, or it sits on the wrong line. Left alone, stale suppressions pile up and start
hiding new problems on the lines they cover.

    {
      // dcx-disable-next-line security/privliged   <- typo, suppresses nothing
      "privileged": true
    }

Delete the directive, or fix the rule ID or position.`,
  defaultSeverity: "warning",
  check() {},
});

export const metaRules: Rule[] = [unusedSuppression];
