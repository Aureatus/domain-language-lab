# Standalone text frontend (experimental)

Author **[`leave/time-away.domain`](../leave/time-away.domain)**. `.domain` is a
temporary descriptive suffix for the unnamed language. `leave/model.mjs` is a
compatibility loading bridge, not another authoring language.

The real lexer/parser elaborates text into the unchanged `semantic-core/v2` domain,
initial state and `model-application/v1` metadata. This closed vertical slice has
no author imports, functions, callbacks, executable payloads or eval fallback.
See [syntax ergonomics](syntax-ergonomics.md) for the grouping and checking decisions.

## Run

```sh
npm run syntax:check -- leave/time-away.domain
npm run syntax:lint -- leave/time-away.domain --strict
npm run syntax:test
npm run syntax:reader:test
npm run syntax:browser
npm run leave
```

The generic `npm run syntax:serve -- leave/time-away.domain` defaults to port 4174
and `artifacts/syntax-data/application.sqlite`; `PORT` and `APPLICATION_DIR` override
these. `npm run leave` retains `LEAVE_DIR` and its existing database name. Restart
after edits; no hot reload or model migration is implied. Never reset a user database
to hide a changed model binding.

## Grouped authoring

This exact excerpt is part of the executed time-away source:

```domain
resource employee
  fields
    name string
    balance
      type integer
      min 0
    end
    manager string
  end
end
```

Actions group `inputs`, `bindings`, `preconditions` (or `requires`), `policies`,
`changes`, and `observations`. Rows omit the repeated singular keyword. Changes
contain `update` and `create`; an update contains `set` rows. All expressions in
the atomic group read the same prestate, irrespective of visual nesting/order.
Preconditions do not grant access; policies retain deny/allow/approval semantics.

```domain
relationships
  employee.manager
  leave.owner
  leave.manager
  settings.manager
end
```

Relationship IDs derive as `resource.field`. An optional `id "explicit.id"` overrides
this. Binding IDs derive as `actionId.alias` if omitted; existing time-away binding
IDs remain explicit to preserve durable bindings. Policy, precondition, update and
create IDs remain explicit: changing their identity is not a formatting operation.

## Closed grammar profile

- One statement per line; whitespace indentation is visual, not grammar. Blocks
  close with `end` alone on a line. Blank lines and `#` comments are ignored outside
  strings; CRLF is supported. `end string`, `end like leave.end`, `end = input.end`
  and adapter `end end` are not terminators. A field literally named `end` must use
  inline schema syntax (its name alone would close the containing block).
- Names are ASCII letters/underscore/dollar followed by these or digits. Quote
  IDs containing dots/hyphens. Reference dots are punctuation. Double-quoted strings
  support escaped quote, slash, newline, carriage return and tab. Numeric literals
  are safe integers; negative expression/initial literals are supported.
- Resource `fields` rows use `NAME SCHEMA`. Schemas are `string`, `integer`,
  `boolean`; inline integer bounds use `min INTEGER max INTEGER` in that order;
  string enum lists accept multiple quoted values. Expanded rows put the name on
  its own line, then `type`, optional `min`/`max` or `enum`, then `end`. Expanded
  properties may be ordered freely; duplicate properties fail. Bound tokens in
  this frontend are nonnegative; incompatible members/inverted bounds fail.
- `NAME like RESOURCE.FIELD` copies that declared schema, not its stored value.
  Resources must already be declared. No implicit fields/inputs or narrowing based
  on cross-field intent. Schema overrides after `like` are unsupported.
- Binding rows: `ALIAS from RESOURCE key EXPR [id ID]`. Input and binding names
  must be declared before expression use. Insert aliases are observation-only.
- Preconditions: `EXPR id ID` (optional leading `require` inside the group).
  Policies: `deny|allow when EXPR id ID` or
  `approve by EXPR when EXPR id ID`. They are distinct groups.
- Changes: one `update` block with `set ALIAS.FIELD = EXPR id ID`; zero or more
  `create RESOURCE key EXPR id ID as ALIAS` blocks with every `FIELD = EXPR`.
- Observations: `ALIAS through "relationship.id"`. They select explicit paths,
  not notification delivery or ORM links.
- Legacy singular `field`, `input`, `bind`, `require`, `policy ID EFFECT when EXPR`,
  `approve`, `update`, `create`, `observe`, and
  `relationship ID from RESOURCE.FIELD` remain supported and tested.
- Expressions: literals, `actor`, explicit `clock`, `input.NAME` or bare input
  names, `ALIAS.FIELD`, parentheses, `+`, `-`, `<`, `<=`, `>`, `>=`, `==`, `!=`,
  `not`, `and`, `or`. Precedence: arithmetic, ordered comparisons, equality,
  `not`, `and`, `or`; binary operators associate left. `not actor == employeeId`
  means `not (actor == employeeId)`. `>=`, `>` and `!=` normalize to reversed
  `le`, reversed `lt`, and `not eq`. No multiplication/division/functions.
- `initial revision INTEGER`: `records RESOURCE` containing `record KEY version
  INTEGER` blocks of literal assignments. Empty collections need no records.
- `application`: quoted title/eyebrow/subtitle/scope; simulation actors;
  `present ACTION` with label/description, input `field` blocks and named `adapter`
  mappings; `view summary|list RESOURCE [key TEXT] label TEXT` with field rows.
  Field metadata supports label, widget, host bind, literal/record-field default.
  `utc-weekday-range/v1` adapter mappings use start/end/output input names.
  Explicit reference overrides and ownerField view filters are not exposed here.

Unknown constructs, names, duplicates, schema/type/metadata errors fail closed.
Filename and 1-based UTF-16 line/column identify lexer/parser failures; unstructured
core/application failures honestly point to the domain header with the diagnostic.
`parseSource` returns declaration, semantic-ID sourceMap, top-level sections and
parser-owned inputLocations used by lint diagnostics (including grouped inputs).

## Reader, lint and editor

[Whole highlighted source](../artifacts/time-away-highlighted.html): one continuous
code region, **every line and ID visible by default**, including initial data and
interface. No folds, cards replacing syntax, compact mode or hide-ID control.
Outline links navigate without removing text. Copy/download preserve exact source;
clipboard denial exposes a text fallback. Long lines scroll locally on mobile.
Invalid source is escaped and accompanied by a diagnostic, not styled as verified.

```sh
node syntax/highlight.mjs leave/time-away.domain artifacts/time-away-highlighted.html
node syntax/highlight.mjs leave/time-away.domain artifacts/time-away-highlighted-inline.html --inline
```

The self-contained inline variant is at most 728px wide and uses theme variables.
Chromium tests at 1440/728/390px assert exact full text, every code line visible,
all IDs retained, no document overflow, navigation, download and clipboard/fallback.
Screenshots/reports are under `artifacts/time-away-source-*`. This is sampled
browser evidence, not all-browser/assistive-technology proof.

`lintSource` yields filename, line, column, severity, stable ruleId and message.
Parser and authoritative model/application errors are errors. Trailing whitespace,
tab indentation and genuinely unused AST inputs are advisory warnings. Adapter
mappings and hidden host bindings count as intentional input use. `--json` outputs
structured diagnostics; `--strict` exits 1 for warnings too. No repairs, suppression,
unused-binding inference or safety proof. Use `node syntax/lint.mjs PATH --json`
for JSON without npm's banner.

`syntax/editor/` is a local VS Code-compatible `.domain` grammar, not an installed
language server. It includes grouped keywords and contextual schema-row names.
JSON/regex tests do not establish editor-host rendering. Try with
`code --extensionDevelopmentPath="$(pwd)/syntax/editor" "$(pwd)/leave/time-away.domain"`.

## Evidence and limits

`syntax/fixtures/prior-leave.mjs` is independently retained test-only pre-migration
data. Full deep equality compares the entire domain, state and application
metadata—not a regenerated output snapshot. The SQLite test creates an old-model
pending request, reopens with migrated text and successfully grants/resumes. This
exact syntactic migration preserves durable binding; actual semantic edits do not.
`syntax/fixtures/schema-groups.domain` exercises both bounds, three enum values,
schema reuse, derived binding IDs and explicit relationship overrides without
inventing leave states. Tests also cover rollback, group prestate, invalid names,
types, bounds, grouping, source spans, lint locations and source-only form edits.

The frontend does not expose delete, ids schemas, self-approval configuration or
arbitrary custom/regex validation. No compiler correspondence proof or v2 theorem.
Node, parser, semantic interpreter, framework/input adapters/renderer, Effect/SQLite,
host clock/identity and filesystem are trusted. The date adapter is trusted
framework JavaScript; direct core callers must uphold that contract. Deterministic
elaboration says nothing about deterministic external I/O or scheduling.

Read depth: full README, standalone syntax, application derivation and v2 contract;
source inspection of parser/lint/highlighter/editor/tests and v2 validation.
No external research, delegation, new proof audit or video recording.

### Executed checkpoint — November 14, 2026

- `npm test`: **225 passed, 0 failed** (existing Lean checks retain their v1 scope).
- `npm run syntax:test`: **56 passed, 0 failed**.
- Strict actual-source lint: **0 errors, 0 warnings**.
- Source-reader browser, syntax source-edit mapping browser and full time-off
  browser: passed. Desktop/action/mobile source screenshots were inspected.
- Regenerated `artifacts/model-derived-application-count.json`: author source
  **185 physical / 173 nonblank lines / 4,335 bytes**; including 10-line bridge and
  11-line optional launcher, **3 files / 206 physical / 194 nonblank / 5,679 bytes**.
  These are present-source counts, not savings or compiler-complexity measures.
