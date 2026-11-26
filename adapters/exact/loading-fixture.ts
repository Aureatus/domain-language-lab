// Test declaration: one inherited mode, three overrides, one atomic snapshot.
import leave from "../../leave/model.ts";

const fixture = structuredClone(leave);

fixture.application.loading = "icon";

const [view] = leave.application.views;

if (!view) {
  throw new Error("Missing leave view fixture");
}

fixture.application.views = [undefined, "text", "skeleton", "wait"].map(
  (loading, i) => ({
    ...view,
    label: `Record group ${i}`,
    ...(loading ? { loading } : {}),
  })
);

export default fixture;
