import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deriveApplication } from "../application/derive.ts";
import { present } from "../semantic/test-support.ts";
import legacy from "./fixtures/legacy-source.ts";
import { parseSource } from "./frontend.ts";
import { highlight } from "./highlight.ts";
import { lintSource } from "./lint.ts";
import { loadSource } from "./load.ts";

const text = readFileSync(
  new URL("./fixtures/schema-groups.domain", import.meta.url),
  "utf8"
);

const parse = (s: string) => parseSource(s, { filename: "groups.domain" });

test("expanded bounds and multi-enum, schema reuse and safe derived IDs execute", () => {
  const { declaration, sourceMap } = parse(text);
  const model = declaration.domain;

  assert.deepEqual(present(model.resources["supply"]).fields["balance"], {
    type: "integer",
    min: 0,
    max: 30,
  });
  assert.deepEqual(present(model.resources["supply"]).fields["status"], {
    type: "string",
    enum: ["ready", "held", "spent"],
  });
  assert.deepEqual(
    present(model.actions["supply.adjust"]).inputs["balance"],
    present(model.resources["supply"]).fields["balance"]
  );
  assert.notEqual(
    present(model.actions["supply.adjust"]).inputs["balance"],
    present(model.resources["supply"]).fields["balance"]
  );
  assert.equal(
    present(present(model.actions["supply.adjust"]).bindings[0]).id,
    "supply.adjust.item"
  );
  assert.ok(sourceMap["supply.adjust.item"]);
  assert.deepEqual(model.relationships, [
    { id: "supply.supervisor", resource: "supply", field: "manager" },
  ]);

  const d = deriveApplication(declaration);

  const invoke = (balance: number, status = "held") =>
    d.runtime.execute(d.initialState, {
      id: "adjust",
      action: "supply.adjust",
      actor: "sam",
      clock: 1,
      args: { key: "depot", balance, status },
    });

  assert.equal(invoke(30).status, "committed");

  for (const [balance, status] of [
    [-1, "held"],
    [31, "held"],
    [1, "unknown"],
  ] as const) {
    const outcome = invoke(balance, status);
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.code, "schema");
  }

  assert.deepEqual(lintSource(text), []);
});

test("inline and expanded schemas are exact sugar; legacy singular forms remain accepted", () => {
  const inline = text
    .replace(
      "balance\n      type integer\n      min 0\n      max 30\n    end",
      "balance integer min 0 max 30"
    )
    .replace(
      'status\n      type string\n      enum "ready" "held" "spent"\n    end',
      'status string enum "ready" "held" "spent"'
    );

  assert.deepEqual(parse(inline).declaration, parse(text).declaration);

  const legacy = inline
    .replace("  fields\n", "")
    .replace("    title string", "  field title string")
    .replace(
      "    balance integer min 0 max 30",
      "  field balance integer min 0 max 30"
    )
    .replace("    status string enum", "  field status string enum")
    .replace("    manager string\n  end", "  field manager string")
    .replace(
      'relationships\n  supply.manager id "supply.supervisor"\nend',
      'relationship "supply.supervisor" from supply.manager'
    )
    .replace(
      "  inputs\n    key string\n    balance like supply.balance\n    status like supply.status\n  end",
      "  input key string\n  input balance like supply.balance\n  input status like supply.status"
    )
    .replace(
      "  bindings\n    item from supply key input.key\n  end",
      '  bind item from supply key input.key id "supply.adjust.item"'
    )
    .replace(
      '  requires\n    require balance <= 30 id "supply.capacity"\n  end',
      '  require balance <= 30 id "supply.capacity"'
    )
    .replace(
      '  policies\n    allow when actor == item.manager id "supply.manager-only"\n  end',
      '  policy "supply.manager-only" allow when actor == item.manager'
    )
    .replace("  changes\n", "")
    .replace("    end\n  end\n  observations", "    end\n  observations")
    .replace(
      '  observations\n    item through "supply.supervisor"\n  end',
      '  observe item through "supply.supervisor"'
    );

  assert.deepEqual(parse(legacy).declaration, parse(text).declaration);
});

for (const [label, from, to, pattern] of [
  [
    "unknown reuse",
    "like supply.balance",
    "like missing.balance",
    /Unknown schema source/,
  ],
  ["missing type", "      type integer\n", "", /requires type/],
  [
    "unsupported expanded type",
    "      type integer",
    "      type ids",
    /Unsupported schema/,
  ],
  [
    "duplicate bound",
    "      min 0",
    "      min 0\n      min 1",
    /Duplicate declaration/,
  ],
  ["inverted bounds", "      max 30", "      max 0\n", /Inverted bounds/],
  [
    "wrong update type",
    "item.balance = balance",
    "item.balance = status",
    /Update type mismatch/,
  ],
  [
    "unknown target",
    "item.balance = balance",
    "item.missing = balance",
    /Unknown update target/,
  ],
  [
    "business rule in policies",
    'allow when actor == item.manager id "supply.manager-only"',
    'require true id "not-a-policy"',
    /Expected allow/,
  ],
  [
    "policy in changes",
    "    update",
    '    allow when true id "oops"',
    /Expected update/,
  ],
  [
    "input inside preconditions",
    '    require balance <= 30 id "supply.capacity"',
    "    input hidden string",
    /Unknown expression/,
  ],
  [
    "binding inside observations",
    '    item through "supply.supervisor"',
    '    bind other from supply key "depot" id "other"',
    /Expected 'through'/,
  ],
  [
    "inherited schema source",
    "like supply.balance",
    "like supply.constructor",
    /Unknown schema source/,
  ],
  [
    "derived binding collision",
    'id "supply.capacity"',
    'id "supply.adjust.item"',
    /Duplicate semantic ID/,
  ],
] satisfies [string, string, string, RegExp][]) {
  test(`group validation rejects ${label}`, () => {
    const changed =
      label === "inverted bounds"
        ? text.replace("      min 0", "      min 1").replace(from, to)
        : text.replace(from, to);

    assert.notEqual(changed, text);
    assert.throws(() => parse(changed), pattern);
  });
}

test("grouped input lint locations and keyword-looking identifiers are contextual", () => {
  const edited = text.replace(
    "    key string",
    "    unused like supply.title\n    key string"
  );

  const warning = lintSource(edited).find(
    (d) => d.ruleId === "usage/unused-input"
  );

  assert.ok(warning);
  assert.equal(
    warning.line,
    edited.split("\n").indexOf("    unused like supply.title") + 1
  );
  assert.equal(warning.column, 5);

  const html = highlight(
    "fields\n  name string\n  end like supply.title\nend\n"
  );

  assert.match(html, />fields<\/span>/);
  assert.doesNotMatch(html, /class="keyword">name/);
  assert.doesNotMatch(html, /class="keyword">end<\/span> like/);
});

test("quoted end supports an expanded field without ambiguity with block termination", () => {
  const inline = text
    .replace("    title string", "    end string")
    .replace("      title =", "      end =");

  const expanded = inline.replace(
    "    end string",
    '    "end"\n      type string\n    end'
  );

  assert.deepEqual(parse(expanded).declaration, parse(inline).declaration);
});

test("every documented domain example is an exact excerpt of a fully parsed fixture", () => {
  const leave = readFileSync(
    new URL("../leave/time-away.domain", import.meta.url),
    "utf8"
  );

  for (const path of ["standalone-syntax.md", "syntax-ergonomics.md"]) {
    const doc = readFileSync(
      new URL(`../docs/${path}`, import.meta.url),
      "utf8"
    );

    for (const [, example] of doc.matchAll(/```domain\n([\s\S]*?)```/g)) {
      const owner = [leave, text, legacy].find((source) =>
        source.includes(present(example).trimEnd())
      );

      assert.ok(owner, `${path}: example must be an exact source excerpt`);

      if (owner === leave) {
        loadSource(new URL("../leave/browser.domain", import.meta.url));
      } else {
        parse(owner);
      }
    }
  }
});
