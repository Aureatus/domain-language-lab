/-!
An intentionally small mathematical model of approval-bound commit.
This is not generated from, nor a proof about, the TypeScript interpreter.
-/

namespace ApprovalPilot

structure State where
  ticketVersion : Nat
  arguments : Nat
  policyRevision : Nat
  approval : Option (Nat × Nat × Nat)
  committed : Bool
  deriving DecidableEq, Repr

def currentBinding (s : State) : Nat × Nat × Nat :=
  (s.ticketVersion, s.arguments, s.policyRevision)

inductive Step : State → State → Prop where
  | approve (s : State) (h : s.committed = false) :
      Step s { s with approval := some (currentBinding s) }
  | editArguments (s : State) (args : Nat) (h : s.committed = false) :
      Step s { s with arguments := args }
  | editTicket (s : State) (version : Nat) (h : s.committed = false) :
      Step s { s with ticketVersion := version }
  | changePolicy (s : State) (revision : Nat) (h : s.committed = false) :
      Step s { s with policyRevision := revision }
  | commit (s : State)
      (hOpen : s.committed = false)
      (hApproval : s.approval = some (currentBinding s)) :
      Step s { s with committed := true }

-- Any transition that commits must have had an approval bound to its exact
-- pre-state version, arguments and policy revision.
theorem commit_requires_current_binding {before after : State}
    (h : Step before after) (commits : after.committed = true) :
    before.approval = some (currentBinding before) := by
  cases h with
  | approve hOpen => simp_all
  | editArguments args hOpen => simp_all
  | editTicket version hOpen => simp_all
  | changePolicy revision hOpen => simp_all
  | commit hOpen hApproval => exact hApproval

def initial : State :=
  { ticketVersion := 1, arguments := 7, policyRevision := 3,
    approval := none, committed := false }

def approved : State :=
  { initial with approval := some (currentBinding initial) }

def completed : State := { approved with committed := true }

-- A successful approval-then-commit path is reachable (non-vacuity witness).
theorem successful_path_exists :
    ∃ middle final, Step initial middle ∧ Step middle final ∧ final.committed = true := by
  refine ⟨approved, completed, ?_, ?_, rfl⟩
  · simpa [approved, initial] using
      (Step.approve initial rfl : Step initial approved)
  · exact Step.commit approved rfl (by simp [approved, initial, currentBinding])

-- A concrete stale approval after argument modification is rejected: no commit
-- constructor can satisfy the current-binding premise.
def stale : State := { approved with arguments := 8 }

theorem stale_approval_cannot_commit :
    stale.approval ≠ some (currentBinding stale) := by
  simp [stale, approved, initial, currentBinding]

#print axioms commit_requires_current_binding
#print axioms successful_path_exists
#print axioms stale_approval_cannot_commit

end ApprovalPilot
