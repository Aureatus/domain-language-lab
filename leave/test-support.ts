import { deriveApplication, buildInvocation } from "../application/derive.ts";
import declaration from "./model.ts";

export { businessDays } from "../application/inputs.ts";

const { contract } = deriveApplication(declaration);

export const requestInvocation = ({
  id,
  actor,
  start,
  end,
  days,
  clock = 1,
}: {
  id: string;
  actor: string;
  start: string;
  end: string;
  days?: number;
  clock?: number;
}) =>
  buildInvocation(contract, {
    id,
    actor,
    clock,
    action: "leave.request",
    args: { start, end, ...(days !== undefined && { days }) },
  });
