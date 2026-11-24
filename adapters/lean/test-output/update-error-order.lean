import Std
namespace Generated
-- Adapter shared-ir-lean-numeric/1; projection single-static-record-numeric-kernel/1
-- Source SHA256 2f7ba63e63f51f2f4320fc49cb43cbd67e60bd5d6dce8446ba7f299f27b7c92f; law SHA256 092b109e71eb7d9d2ea21d86427369571093df82d1074225a1206e6e9e7ad725
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
  if ((safe s.remaining) ∧ ((0 : Int) ≤ s.remaining)) ∧ ((safe s.previous) ∧ ((0 : Int) ≤ s.previous)) ∧ ((safe i.amount) ∧ ((1 : Int) ≤ i.amount)) ∧ (safe s.revision) ∧ (0 ≤ s.revision) ∧ (safe s.version) ∧ (0 ≤ s.version) ∧ (safe i.clock) ∧ (0 ≤ i.clock) then
    if (safe (s.remaining - i.amount)) then
      if (safe (s.remaining - i.amount)) ∧ ((0 : Int) ≤ (s.remaining - i.amount)) then
        if (safe ((9007199254740991 : Int) + (1 : Int))) then
          if (safe ((9007199254740991 : Int) + (1 : Int))) ∧ ((0 : Int) ≤ ((9007199254740991 : Int) + (1 : Int))) then
            if (safe (s.revision + 1)) ∧ (safe (s.version + 1)) then .committed { remaining := (s.remaining - i.amount), previous := ((9007199254740991 : Int) + (1 : Int)), revision := s.revision + 1, version := s.version + 1 }
            else .overflow
          else .schema
        else .overflow
      else .schema
    else .overflow
  else .invalid

-- runtime cross-check update-error-order/0
example : step { remaining := (2 : Int), previous := (0 : Int), revision := (0 : Int), version := (0 : Int) } { amount := (3 : Int), clock := 0 } = .schema := by decide
end Generated
