# Loading policy for data views

An `application` block can declare `loading text`, `loading icon`, `loading skeleton`, or `loading wait`. Each resource `view` block may override the application. Omission inherits; with no declarations the effective policy is `text`. These are presentation settings in a view entry, not domain rules or stored application data. This is an excerpt from a possible view module:

```text
application
  loading skeleton
  view list leave label "Time off"
    loading wait
    field start label "From" format date
  end
end
```

`wait` defers revealing that region until its data is ready: no placeholder, no blocked siblings, and no suppression of failures. It is not a whole-page navigation barrier. All strategies currently share the same snapshot request boundary. They do not turn a snapshot into independent queries per panel.

The lifecycle observations are: is there a request pending, has it failed, and is there a usable response for the selected identity? `owned` describes the **response**, not the number of rows: zero records is a successful result. When a request is pending, it takes precedence over a previous failure. While the same person's response is usable, content stays visible through refresh and refresh failure. A previous person's response cannot count as usable for a new identity. This is a presentation boundary; server authorization remains separate.

Inspect a module without a server or a slow network:

The generic demo browser already has an all-actor snapshot and can project the newly selected person's records immediately. Exact instead loads an actor-specific screen; during that switch, it gates retained rows on the response owner.

```sh
node application/inspect-loading.mjs leave/browser.domain
```

The inspector uses the same phase table and policy resolution as the implementation. Its scenarios are examples of input facts and expected presentation, not screenshots or recorded execution. The browser and Exact supply different transports (SSE snapshots vs polling), so they need not enter every phase on every interaction. The policy describes declared data views; action forms and submission feedback have separate lifecycles.
