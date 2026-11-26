import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encodeJson } from "../adapters/effect/json.ts";
import { deriveApplication } from "../application/derive.ts";
import { present } from "../semantic/test-support.ts";
import legacy from "./fixtures/legacy-source.ts";
import { parseSource } from "./frontend.ts";
import { highlight } from "./highlight.ts";
import { lintSource } from "./lint.ts";
import { loadSource } from "./load.ts";

const text = readFileSync(
  new URL("fixtures/schema-groups.domain", import.meta.url),
  "utf-8"
);

const parse = (s: string) => parseSource(s, { filename: "groups.domain" });

const explicitSchemas = text
  .replace("    balance infer", "    balance like supply.balance")
  .replace("    status infer", "    status like supply.status");

test("expanded bounds and multi-enum, inferred input schemas and safe derived IDs execute", () => {
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
  const inline = explicitSchemas
    .replace(
      "balance\n      type integer\n      min 0\n      max 30\n    end",
      "balance integer min 0 max 30"
    )
    .replace(
      'status\n      type string\n      enum "ready" "held" "spent"\n    end',
      'status string enum "ready" "held" "spent"'
    );

  assert.deepEqual(parse(inline).declaration, parse(text).declaration);

  const expandedInput = inline.replace(
    "    balance like supply.balance",
    "    balance\n      type integer\n      min 0\n      max 30\n    end"
  );

  assert.deepEqual(parse(expandedInput).declaration, parse(text).declaration);

  const legacyText = inline
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

  assert.deepEqual(parse(legacyText).declaration, parse(text).declaration);
});

test("migrated sources retain their pre-inference serialized model and contract IDs", () => {
  const contractIds = {
    "../leave/browser.domain":
      "136de0f000fc5aed5febb25583ca25c9ecdacb562bd42b50b54124f2c92d4144",
    "../leave/cli.domain":
      "87fca2c2e3c492e811ad09aa5863d8f9f8d0f7ab0c432b38ceb0a8f22376f37c",
    "../leave/mobile.domain":
      "fa0f34bc60cb868dc2c28a6394775fef3748ce93761ef0da73d6716ad815116b",
    "fixtures/schema-groups.domain":
      "b3500080a845bcf8cca4baccd698781096aa7ec6a30ba21ad5ca47c098f0f2ee",
  };

  for (const [path, expected] of Object.entries(contractIds)) {
    const { model, contract } = deriveApplication(
      loadSource(new URL(path, import.meta.url)).declaration
    );

    const id = createHash("sha256")
      .update(encodeJson({ model, contract }))
      .digest("hex");

    assert.equal(id, expected, path);
  }
});

test("inferred schemas accept agreeing direct writes and reject conflicting bounds at the input", () => {
  const secondTarget = text
    .replace(
      "    manager string",
      "    reserve integer min 0 max 30\n    manager string"
    )
    .replace(
      '      set item.status = status id "supply.status"',
      '      set item.status = status id "supply.status"\n      set item.reserve = input.balance id "supply.reserve"'
    )
    .replace(
      '      manager = "sam"',
      '      reserve = 5\n      manager = "sam"'
    );

  const { declaration } = parse(secondTarget);

  assert.deepEqual(
    present(declaration.domain.actions["supply.adjust"]).inputs["balance"],
    { type: "integer", min: 0, max: 30 }
  );

  const conflicting = secondTarget.replace(
    "reserve integer min 0",
    "reserve integer min 1"
  );

  const line = conflicting.split("\n").indexOf("    balance infer") + 1;

  assert.throws(() => parse(conflicting), {
    message: `groups.domain:${line}:5: Cannot infer input 'balance': 'supply.balance' and 'supply.reserve' have different schemas. Declare the input schema explicitly.`,
  });

  assert.doesNotThrow(() =>
    parse(conflicting.replace("balance infer", "balance integer min 1 max 30"))
  );
});

test("guards, keys and arithmetic do not supply a direct write schema", () => {
  const missingWrite = text.replace(
    "item.balance = balance",
    "item.balance = balance + 0"
  );

  const line = missingWrite.split("\n").indexOf("    balance infer") + 1;

  assert.throws(() => parse(missingWrite), {
    message: `groups.domain:${line}:5: Cannot infer input 'balance': no direct write to a resource field.`,
  });
  assert.throws(
    () => parse(text.replace("key string", "key infer")),
    /Cannot infer input 'key': no direct write/u
  );
});

for (const [label, from, to, pattern] of [
  [
    "unknown reuse",
    "like supply.balance",
    "like missing.balance",
    /Unknown schema source/u,
  ],
  ["missing type", "      type integer\n", "", /requires type/u],
  [
    "unsupported expanded type",
    "      type integer",
    "      type ids",
    /Unsupported schema/u,
  ],
  [
    "duplicate bound",
    "      min 0",
    "      min 0\n      min 1",
    /Duplicate declaration/u,
  ],
  ["inverted bounds", "      max 30", "      max 0\n", /Inverted bounds/u],
  [
    "wrong update type",
    "item.balance = balance",
    "item.balance = status",
    /Update type mismatch/u,
  ],
  [
    "unknown target",
    "item.balance = balance",
    "item.missing = balance",
    /Unknown update target/u,
  ],
  [
    "business rule in policies",
    'allow when actor == item.manager id "supply.manager-only"',
    'require true id "not-a-policy"',
    /Expected allow/u,
  ],
  [
    "policy in changes",
    "    update",
    '    allow when true id "oops"',
    /Expected update/u,
  ],
  [
    "input inside preconditions",
    '    require balance <= 30 id "supply.capacity"',
    "    input hidden string",
    /Unknown expression/u,
  ],
  [
    "binding inside observations",
    '    item through "supply.supervisor"',
    '    bind other from supply key "depot" id "other"',
    /Expected 'through'/u,
  ],
  [
    "inherited schema source",
    "like supply.balance",
    "like supply.constructor",
    /Unknown schema source/u,
  ],
  [
    "derived binding collision",
    'id "supply.capacity"',
    'id "supply.adjust.item"',
    /Duplicate semantic ID/u,
  ],
] satisfies [string, string, string, RegExp][]) {
  test(`group validation rejects ${label}`, () => {
    const changed =
      label === "inverted bounds"
        ? explicitSchemas
            .replace("      min 0", "      min 1")
            .replace(from, to)
        : explicitSchemas.replace(from, to);

    assert.notEqual(changed, explicitSchemas);
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
    "fields\n  name string\n  end like supply.title\nend\ninputs\n  end infer\nend\n"
  );

  assert.match(html, />fields<\/span>/u);
  assert.doesNotMatch(html, /class="keyword">name/u);
  assert.doesNotMatch(html, /class="keyword">end<\/span> like/u);
  assert.match(html, /\n {2}end <span class="keyword">infer<\/span>/u);
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
    "utf-8"
  );

  for (const path of ["standalone-syntax.md", "syntax-ergonomics.md"]) {
    const doc = readFileSync(
      new URL(`../docs/${path}`, import.meta.url),
      "utf-8"
    );

    for (const [, example] of doc.matchAll(/```domain\n([\s\S]*?)```/gu)) {
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
