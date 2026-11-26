// Proof strategy is separate from both the transition declarations and source law.
// A failed tactic is a rejected obligation, never a weakened proposition.
interface Template {
  adapter: string;
  projection: string;
  metadata: {
    source_sha256: string;
    obligation_sha256: string;
    declaration_ids: readonly string[];
  };
  max: number;
  fields: readonly string[];
  inputs: readonly string[];
  body: string;
  lawId: string;
  ensures: string;
  witnessPre: string;
  witnessInputs: string;
  witnessPost: string;
}

export function render({
  adapter,
  projection,
  metadata,
  max,
  fields,
  inputs,
  body,
  lawId,
  ensures,
  witnessPre,
  witnessInputs,
  witnessPost,
}: Template) {
  return `import Std
namespace Generated
-- Adapter ${adapter}; projection ${projection}
-- Source SHA256 ${metadata.source_sha256}; law SHA256 ${metadata.obligation_sha256}
-- Stable source IDs: ${metadata.declaration_ids.join(", ")}
abbrev safe (x : Int) : Prop := -${max} ≤ x ∧ x ≤ ${max}
structure State where
${[...fields, "revision", "version"].map((k) => `  ${k} : Int`).join("\n")}
  deriving DecidableEq, Repr
structure Inputs where
${[...inputs, "clock"].map((k) => `  ${k} : Int`).join("\n")}
  deriving Repr
inductive Result where
  | invalid | overflow | precondition | schema
  | committed (state : State)
  deriving DecidableEq, Repr
-- Every arithmetic subtree is checked, including eager boolean operands.
def step (s : State) (i : Inputs) : Result :=
  ${body.split("\n").join("\n  ")}

-- Independent source obligation: ${lawId}
def law (s : State) (i : Inputs) (t : State) : Prop := ${ensures}
theorem preserves (s : State) (i : Inputs) (t : State)
    (h : step s i = .committed t) : law s i t := by
  unfold step at h
  repeat' split at h
  all_goals cases h
  all_goals simp_all [law, safe] <;> omega

theorem positive_witness : step ${witnessPre} ${witnessInputs} = .committed ${witnessPost} := by decide
#print axioms preserves
#print axioms positive_witness
end Generated
`;
}
