import { rangeOf } from "../../jsonc/jsonc";
import {
  lifecycleCommands,
  parallelForms,
  shellOperators,
  type LifecycleCommand,
} from "../../model/lifecycle";
import { members } from "../../model/model";
import { REFERENCE, rule } from "../util";

const DOCS = `${REFERENCE}#lifecycle-scripts`;
const where = (c: LifecycleCommand) => (c.name ? `"${c.property}.${c.name}"` : `"${c.property}"`);
const SHELLS = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh$/;

export const shellSyntaxInArrayForm = rule({
  id: "lifecycle/shell-syntax-in-array-form",
  description: 'Array form bypasses the shell; "&&", "|", ">" become literal arguments',
  explain: `The array form of a lifecycle command runs the program directly, with no
shell, so shell syntax in it isn't interpreted: "&&" is just an argument passed to the
first program.

    "postCreateCommand": ["npm", "install", "&&", "npm", "test"]   // runs npm with "&&" as an arg
    "postCreateCommand": "npm install && npm test"                 // the string form uses a shell
    "postCreateCommand": ["sh", "-c", "npm install && npm test"]   // or ask for one

An argument that only contains an operator inside quotes is fine.`,
  defaultSeverity: "warning",
  check(pass) {
    for (const c of lifecycleCommands(pass.model)) {
      if (c.form !== "array") continue;
      const args = c.argv.map((a) => (typeof a.value === "string" ? a.value : ""));
      // "sh -c <script>": the script is the shell's to read
      if (SHELLS.test(args[0] ?? "") && args[1] === "-c") continue;
      const bad = c.argv.find((a, i) => {
        const s = args[i]!;
        const ops = shellOperators(s);
        // an operator on its own, or a program name with a whole pipeline in it
        return (
          /^(?:&&|\|\||\||;|>>?|<|&|2>&1|[>|<]\S+)$/.test(s) ||
          (i === 0 && /\s/.test(s) && ops.length > 0)
        );
      });
      if (!bad) continue;
      pass.report({
        range: rangeOf(bad.node),
        message: `${where(c)} is in array form, so ${JSON.stringify(bad.value)} is passed as a literal argument, not run by a shell`,
        help: 'use the string form, or ["sh", "-c", "..."]',
        docsUrl: DOCS,
      });
    }
  },
});

export const parallelNonStringValue = rule({
  id: "lifecycle/parallel-non-string-value",
  description: "Object (parallel) form requires string or array values",
  explain: `The object form runs several commands in parallel, one per key. Each value
is a command: a string, or an array of strings. Anything else (a number, a nested
object) isn't run.

    "postCreateCommand": {
      "deps": "npm install",
      "db": ["./scripts/db.sh", "--seed"],
      "bad": { "cmd": "make" }     // not a command
    }`,
  defaultSeverity: "error",
  justification: "the CLI rejects the command object, so none of its commands run",
  check(pass) {
    for (const { property, field } of parallelForms(pass.model)) {
      for (const { name, field: value } of members(field.node)) {
        const ok =
          typeof value.value === "string" ||
          (Array.isArray(value.value) && value.value.every((v) => typeof v === "string"));
        if (ok) continue;
        pass.report({
          range: rangeOf(value.node),
          message: `"${property}.${name}" must be a command string or an array of strings`,
          docsUrl: DOCS,
        });
      }
    }
  },
});

/** Signs a command expects to be in the container, which initializeCommand isn't. */
const IN_CONTAINER = [
  /\$\{containerWorkspaceFolder(?:Basename)?\}/,
  /\$\{containerEnv:/,
  /(?:^|[\s"'])\/workspaces?\//,
  /\b(?:apt-get|apt|apk|yum|dnf)\s+(?:install|add|update)\b/,
];

export const initializeRunsOnHost = rule({
  id: "lifecycle/initialize-runs-on-host",
  description: '"initializeCommand" executes on the host, not in the container',
  explain: `"initializeCommand" is the one lifecycle command that runs on the host
machine, before the container exists. Container paths, container variables and the
container's package manager aren't available to it.

    "initializeCommand": "apt-get install -y jq"          // runs on your laptop
    "postCreateCommand": "apt-get install -y jq"          // runs in the container

Move container setup to "onCreateCommand" or "postCreateCommand".`,
  defaultSeverity: "info",
  check(pass) {
    for (const c of lifecycleCommands(pass.model)) {
      if (c.property !== "initializeCommand") continue;
      const text =
        c.form === "string"
          ? c.field.value
          : c.form === "array"
            ? c.argv.map((a) => String(a.value)).join(" ")
            : "";
      if (!IN_CONTAINER.some((re) => re.test(text))) continue;
      pass.report({
        range: rangeOf(c.field.node),
        message: `${where(c)} runs on the host, but this looks like it expects the container`,
        help: 'move container setup to "onCreateCommand" or "postCreateCommand"',
        docsUrl: DOCS,
      });
    }
  },
});

export const emptyCommand = rule({
  id: "lifecycle/empty-command",
  description: "Empty command",
  explain: `An empty lifecycle command does nothing; usually it's a placeholder left
behind, or a value that got deleted by mistake.

    "postCreateCommand": ""
    "postStartCommand": []

Remove the property, or put the command back.`,
  defaultSeverity: "warning",
  check(pass) {
    const empty = (c: LifecycleCommand) =>
      (c.form === "string" && !c.field.value.trim()) ||
      (c.form === "array" &&
        (!c.argv.length || (typeof c.argv[0]!.value === "string" && !c.argv[0]!.value.trim())));
    for (const c of lifecycleCommands(pass.model)) {
      if (!empty(c)) continue;
      pass.report({
        range: rangeOf(c.field.node),
        message: `${where(c)} is empty`,
        help: "remove it, or fill it in",
        docsUrl: DOCS,
      });
    }
    for (const { property, field } of parallelForms(pass.model)) {
      if (members(field.node).length) continue;
      pass.report({
        range: rangeOf(field.node),
        message: `"${property}" has no commands`,
        help: "remove it, or fill it in",
        docsUrl: DOCS,
      });
    }
  },
});
