import { rangeOf } from "../../jsonc/jsonc";
import { elements, isObject, member, members, type Field } from "../../model/model";
import { covers, inRange, isPattern, MAX_PORT, parsePort, type PortSpec } from "../../model/port";
import type { Pass } from "../rule";
import { keyOf, REFERENCE, rule } from "../util";

const DOCS = `${REFERENCE}#port-attributes`;

type Forwarded = { field: Field<unknown>; spec: PortSpec };

/** `forwardPorts` and `appPort` entries that parse as ports. */
function forwarded(pass: Pass, which: "forwardPorts" | "appPort" | "both" = "both"): Forwarded[] {
  const out: Forwarded[] = [];
  for (const name of which === "both" ? (["forwardPorts", "appPort"] as const) : [which]) {
    const f = pass.model.get(name);
    if (!f) continue;
    const fields = f.node.type === "array" ? elements(f.node) : [f];
    for (const field of fields) {
      // appPort also takes "host:container" docker mappings; only the container side forwards
      const value =
        name === "appPort" && typeof field.value === "string"
          ? field.value.split(":").at(-1)
          : field.value;
      const spec = parsePort(value);
      if (spec) out.push({ field, spec });
    }
  }
  return out;
}

type Attribute = {
  name: string;
  field: Field<unknown>;
  spec: PortSpec | undefined;
  pattern: boolean;
};

function attributes(pass: Pass): Attribute[] {
  const attrs = pass.model.object("portsAttributes");
  if (!attrs) return [];
  return members(attrs.node).map(({ name, field }) => ({
    name,
    field,
    spec: parsePort(name, true),
    pattern: isPattern(name),
  }));
}

export const outOfRange = rule({
  id: "port/out-of-range",
  description: "Port is not in 1–65535",
  explain: `TCP ports run from 1 to 65535; 0 means "any free port" to the OS, and nothing
above 65535 exists. A port outside that range can't be forwarded or published.

    "forwardPorts": [3000, 70000]          // 70000 isn't a port
    "portsAttributes": { "0": { ... } }    // nor is 0

Usually a typo; check the number.`,
  defaultSeverity: "error",
  justification: "no port outside 1-65535 can be forwarded; Docker rejects it as an appPort",
  check(pass) {
    const bad = (spec: PortSpec) =>
      !inRange(spec.port) ||
      (spec.end !== undefined && (!inRange(spec.end) || spec.end < spec.port));
    for (const { field, spec } of forwarded(pass)) {
      if (!bad(spec)) continue;
      pass.report({
        range: rangeOf(field.node),
        message: `${spec.port} isn't a port; ports run from 1 to ${MAX_PORT}`,
        docsUrl: DOCS,
      });
    }
    for (const a of attributes(pass)) {
      if (!a.spec || !bad(a.spec)) continue;
      const message =
        a.spec.end !== undefined && inRange(a.spec.port) && inRange(a.spec.end)
          ? `Port range "${a.name}" ends before it starts`
          : `"${a.name}" isn't a port; ports run from 1 to ${MAX_PORT}`;
      pass.report({ range: keyOf(a.field.node), message, docsUrl: DOCS });
    }
  },
});

export const duplicateForward = rule({
  id: "port/duplicate-forward",
  description: 'Port listed twice in "forwardPorts"',
  explain: `Each port only forwards once; listing it twice (3000 and "localhost:3000"
are the same port) does nothing extra, and usually means the list was edited in two
places.

    "forwardPorts": [3000, 5432, 3000]

Remove the repeat.`,
  defaultSeverity: "warning",
  check(pass) {
    const seen = new Map<string, Forwarded>();
    for (const f of forwarded(pass, "forwardPorts")) {
      const id = `${f.spec.host}:${f.spec.port}`;
      const first = seen.get(id);
      if (!first) {
        seen.set(id, f);
        continue;
      }
      pass.report({
        range: rangeOf(f.field.node),
        message: `Port ${f.spec.port} is already forwarded`,
        help: "remove the repeat",
        related: [{ range: rangeOf(first.field.node), message: "first forwarded here" }],
        docsUrl: DOCS,
      });
    }
  },
});

export const invalidAttributeKey = rule({
  id: "port/invalid-attribute-key",
  description: '"portsAttributes" key is not a port, "host:port", range, or pattern',
  explain: `Each "portsAttributes" key says which ports its settings apply to: a port
("3000"), a host and port ("db:5432"), a range ("40000-55000"), or a regular expression
matched against the port. A key that's none of those matches nothing, so its settings
never apply.

    "portsAttributes": {
      "3000": { "label": "app" },
      "web": { "label": "web" }      // not a port
    }`,
  defaultSeverity: "error",
  justification: "the attributes never match a port, so the config does nothing",
  check(pass) {
    for (const a of attributes(pass)) {
      if (a.spec || a.pattern) continue;
      pass.report({
        range: keyOf(a.field.node),
        message: `"${a.name}" isn't a port, a host:port, a range or a pattern`,
        help: 'use a port number like "3000", or a range like "3000-3010"',
        docsUrl: DOCS,
      });
    }
  },
});

export const attributesOrphan = rule({
  id: "port/attributes-orphan",
  description: '"portsAttributes" entry for a port that is never forwarded',
  explain: `Attributes for a port only matter once that port is forwarded. With an
explicit "forwardPorts" list, an attribute for a port missing from it applies only if
the editor happens to detect and auto-forward that port.

    "forwardPorts": [3000],
    "portsAttributes": { "8080": { "label": "admin" } }    // 8080 isn't forwarded

Add the port to "forwardPorts", or drop the attributes. This is informational: relying
on auto-forwarding is sometimes the intent.`,
  defaultSeverity: "info",
  check(pass) {
    if (!pass.model.get("forwardPorts") && !pass.model.get("appPort")) return;
    const ports = forwarded(pass).map((f) => f.spec);
    for (const a of attributes(pass)) {
      if (!a.spec || !inRange(a.spec.port) || ports.some((p) => covers(a.spec!, p))) continue;
      pass.report({
        range: keyOf(a.field.node),
        message: `Attributes for "${a.name}", which "forwardPorts" doesn't forward`,
        help: 'add it to "forwardPorts", or remove these attributes',
        docsUrl: DOCS,
      });
    }
  },
});

export const privilegedWithoutElevate = rule({
  id: "port/privileged-without-elevate",
  description: 'Port below 1024 without "elevateIfNeeded"',
  explain: `Ports below 1024 are privileged: on Linux and macOS, binding one on the host
side of a forward needs root. Without "elevateIfNeeded", the editor forwards it to a
different local port instead, and a URL hard-coded to the original port won't work.

    "forwardPorts": [80],
    "portsAttributes": { "80": { "elevateIfNeeded": true } }`,
  defaultSeverity: "info",
  check(pass) {
    const attrs = attributes(pass);
    for (const { field, spec } of forwarded(pass, "forwardPorts")) {
      if (!inRange(spec.port) || spec.port >= 1024) continue;
      const elevated = attrs.some((a) => {
        if (!a.spec || !covers(a.spec, spec) || !isObject(a.field)) return false;
        return member(a.field.node, "elevateIfNeeded")?.value === true;
      });
      if (elevated) continue;
      pass.report({
        range: rangeOf(field.node),
        message: `Port ${spec.port} is privileged; forwarding it locally needs "elevateIfNeeded"`,
        help: `add "portsAttributes": { "${spec.port}": { "elevateIfNeeded": true } }`,
        docsUrl: DOCS,
      });
    }
  },
});
