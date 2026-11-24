import Std
namespace Generated
-- Adapter shared-ir-lean-numeric/1; projection single-static-record-numeric-kernel/1
-- Source SHA256 edbc27aaabe6f6ef1b7801576dff8036d24946770938a13f9b854f9cc0241493; law SHA256 092b109e71eb7d9d2ea21d86427369571093df82d1074225a1206e6e9e7ad725
-- Stable source IDs: numeric-capacity.v1, capacity, capacity.take, capacity.record, capacity.decrement, capacity.remember
abbrev safe (x : Int) : Prop := -9007199254740991 ≤ x ∧ x ≤ 9007199254740991
structure State where
  remaining : Int
  previous : Int
  revision : Int
  version : Int
  deriving DecidableEq, Repr
structure Inputs where
  amount : Int
  clock : Int
  deriving Repr
inductive Result where
  | invalid | overflow | precondition | schema
  | committed (state : State)
  deriving DecidableEq, Repr
-- Every arithmetic subtree is checked, including eager boolean operands.
def step (s : State) (i : Inputs) : Result :=
  if ((safe s.remaining)) ∧ ((safe s.previous)) ∧ ((safe i.amount) ∧ ((1 : Int) ≤ i.amount)) ∧ (safe s.revision) ∧ (0 ≤ s.revision) ∧ (safe s.version) ∧ (0 ≤ s.version) ∧ (safe i.clock) ∧ (0 ≤ i.clock) then
    if (safe (s.remaining - i.amount)) then
      if (safe (s.remaining - i.amount)) then
        if True then
          if (safe s.remaining) then
            if (safe (s.revision + 1)) ∧ (safe (s.version + 1)) then .committed { remaining := (s.remaining - i.amount), previous := s.remaining, revision := s.revision + 1, version := s.version + 1 }
            else .overflow
          else .schema
        else .overflow
      else .schema
    else .overflow
  else .invalid

-- runtime cross-check signed-boundary/0
example : step { remaining := (-9007199254740990 : Int), previous := (0 : Int), revision := (0 : Int), version := (0 : Int) } { amount := (1 : Int), clock := 0 } = .committed { remaining := (-9007199254740991 : Int), previous := (-9007199254740990 : Int), revision := (1 : Int), version := (1 : Int) } := by decide
-- runtime cross-check signed-boundary/1
example : step { remaining := (-9007199254740991 : Int), previous := (0 : Int), revision := (0 : Int), version := (0 : Int) } { amount := (1 : Int), clock := 0 } = .overflow := by decide
end Generated
