import oxfmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { defineConfig } from "vite-plus";

const generated = [
  "adapters/lean/generated/**",
  "adapters/lean/test-output/**",
];

export default defineConfig({
  fmt: {
    ...oxfmt,
    // Builds and tests match CSS and HTML as text, and prose keeps its authored line breaks.
    // Builds and tests match CSS, HTML and prose as literal text.
    ignorePatterns: [
      ...oxfmt.ignorePatterns,
      ...generated,
      "**/*.css",
      "**/*.html",
      "**/*.md",
    ],
  },
  lint: {
    env: { ...core.env, node: true },
    extends: [core, antiSlop],
    ignorePatterns: [...core.ignorePatterns, ...generated],
    overrides: [
      {
        // Browser drivers, recorders and tests step through one shared page or server in order.
        files: [
          "**/*.test.ts",
          "**/*-test.ts",
          "**/test.ts",
          "**/browser-scenario.ts",
          "**/test-browser.ts",
          "**/record-demo.ts",
          "**/video.ts",
        ],
        rules: {
          "no-await-in-loop": "off",
          // Async fakes stand in for async APIs such as fetch.
          "require-await": "off",
          // Tests deliberately build malformed inputs and read known-present map entries.
          "anti-slop/no-chained-type-assertions": "off",
          "anti-slop/require-safety-comment-for-type-assertion": "off",
          // Fakes implement only the browser and Worker members a test touches.
          "max-classes-per-file": "off",
          "accessor-pairs": "off",
          "class-methods-use-this": "off",
          "typescript/no-extraneous-class": "off",
          "no-empty-function": "off",
          // Malformed-input cases build sparse arrays, shared fills and raw patterns on purpose.
          "unicorn/new-for-builtins": "off",
          "unicorn/no-new-array": "off",
          "no-sparse-arrays": "off",
          "unicorn/no-array-fill-with-reference-type": "off",
          "unicorn/no-object-as-default-parameter": "off",
          "no-new": "off",
          "require-unicode-regexp": "off",
          // An explicit undefined default keeps a trailing optional parameter after defaults.
          "unicorn/no-useless-undefined": "off",
          "anti-slop/no-object-parameters": "off",
          // Playwright locators expose innerText(); the DOM text-content rule misreads them.
          "unicorn/prefer-dom-node-text-content": "off",
          "typescript/no-invalid-void-type": "off",
          "anti-slop/no-reflect-apply": "off",
          "anti-slop/no-reflect-get": "off",
          "anti-slop/no-unknown-returns": "off",
          "unicorn/no-array-reduce": "off",
          "unicorn/no-unreadable-array-destructuring": "off",
        },
      },
      {
        // Generates Premise source, where `shape` is a keyword and `${}` belongs to emitted templates.
        files: ["adapters/exact/generate.ts"],
        rules: {
          "anti-slop/no-shape-in-symbol-names": "off",
          "no-template-curly-in-string": "off",
        },
      },
      {
        // Replays, recursive module visits and content hashes must run in order.
        files: [
          "adapters/exact/generate.ts",
          "application/action-walkthrough.ts",
          "application/checker-build.ts",
          "application/count.ts",
          "inventory/v2/demo.ts",
          "inventory/v2/generated.ts",
          "prototype/demo.ts",
          "workbench/build.ts",
        ],
        rules: {
          "no-await-in-loop": "off",
          // Replay fakes keep the async signatures of the durable runtime.
          "require-await": "off",
        },
      },
      {
        // Seeded PRNGs and hashes for generated tests.
        files: [
          "inventory/v2/generated.ts",
          "live/generated.ts",
          "prototype/property.ts",
        ],
        rules: {
          "no-bitwise": "off",
          // `| 0` wraps to int32; Math.trunc does not.
          "unicorn/prefer-math-trunc": "off",
        },
      },
    ],
    rules: {
      // Source and model assertions follow validation of the same ids earlier in the pass.
      // Fire-and-forget handlers in synchronous callbacks report rejections with .catch.
      "promise/prefer-await-to-callbacks": "off",
      // DOM listeners created in loops read module state when the event fires.
      "no-loop-func": "off",
      // Type assertions and non-null assertions stay banned everywhere; narrow or decode instead.
      "typescript/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "typescript/no-non-null-assertion": "error",
      // exactOptionalPropertyTypes requires omitting absent optional fields; a conditional spread is how the typed code does that.
      "anti-slop/no-conditional-empty-object-spread": "off",
      // Explicit annotations are the strict-types contracts: lookup tables indexed by arbitrary keys and `asserts` helpers taking unknown.
      "anti-slop/no-known-value-widening": "off",
      // Exhaustive switches over typed unions mark the omission with a "no default" comment.
      "default-case": ["error", { commentPattern: "^no default" }],
      // Every postMessage here targets a Worker, which takes no target origin.
      "unicorn/require-post-message-target-origin": "off",
      // JSON modules expose only a default export.
      "import/no-named-as-default-member": "off",
      // Error subclasses are distinguished by instanceof, and message text is asserted by tests.
      "unicorn/custom-error-definition": "off",
      // Records keyed by resource ids are plain dictionaries.
      "typescript/no-dynamic-delete": "off",
      // Filtering before mapping keeps each step's intent visible.
      "anti-slop/no-array-filter-map": "off",
      // Function declarations hoist; converting them to expressions risks TDZ errors at module load.
      "func-style": ["error", "declaration", { allowArrowFunctions: true }],
      // Closures may read later bindings; same-scope temporal-dead-zone reads stay errors.
      "no-use-before-define": ["error", { functions: false, variables: false }],
      // Positional reads such as process.argv[2] are clearer than array holes.
      "prefer-destructuring": ["error", { array: false, object: true }],
      "unicorn/import-style": [
        "error",
        { styles: { "node:path": { named: true } } },
      ],
      // Most sources are untyped JavaScript validating untrusted JSON; typeof is the runtime guard.
      "anti-slop/no-runtime-typeof": "off",
      // `(await readFile(url)).toString()` reads better than a single-use temporary.
      "unicorn/no-await-expression-member": "off",
      // JSON round-trips deliberately assert JSON-serialisable, unfrozen copies; structuredClone does neither.
      "unicorn/prefer-structured-clone": "off",
      // Oxfmt indents ternary chains; expression-position chains would otherwise need temporaries.
      "no-nested-ternary": "off",
      // Interpreters and validators are deliberately one branch per language construct.
      complexity: "off",
      // Wrapping Node callback and event APIs needs the Promise constructor.
      "promise/avoid-new": "off",
      // Positional groups are read immediately by index in short parsers.
      "prefer-named-capture-group": "off",
      // ES modules are strict, so block-level function declarations are block-scoped.
      "no-inner-declarations": "off",
      // Shrinking loops advance their bounds through closures such as accepts().
      "no-unmodified-loop-condition": "off",
      // Validators and canonicalisers take untrusted input, which `unknown` describes honestly.
      "anti-slop/no-unknown-parameters": "off",
      "anti-slop/no-unsafe-dictionary-type": "off",
      // Helpers stay beside their only caller.
      "unicorn/consistent-function-scoping": "off",
      // `next()` is the seeded PRNG, not a callback.
      "node/callback-return": "off",
      // Files that import node:path's resolve name promise settlers resolveX/rejectX.
      "promise/param-names": [
        "error",
        { resolvePattern: "^_?resolve", rejectPattern: "^_?reject" },
      ],
    },
  },
});
