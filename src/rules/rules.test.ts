import { RULES } from "./index";
import { runFixtures } from "./rulestest/harness";

// one describe per rule, one test per fixture case; a rule with no fixtures fails
for (const rule of RULES) runFixtures(rule);
