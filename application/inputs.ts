// Trusted host adapter registry. Configuration never supplies executable code.
import type { FieldSchema } from "../semantic/v2/types.ts";

interface DateMapping {
  start: string;
  end: string;
  output: string;
}

export function businessDays(start: unknown, end: unknown) {
  const parse = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      throw new Error("Choose valid dates in YYYY-MM-DD format.");
    }

    const d = new Date(`${value}T00:00:00Z`);

    if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value) {
      throw new Error("Choose real calendar dates.");
    }

    return +d;
  };

  const a = parse(start);
  const b = parse(end);

  if (b < a) {
    throw new Error("The end date must be on or after the start date.");
  }

  if ((b - a) / 86_400_000 > 3660) {
    throw new Error("Choose a date range shorter than ten years.");
  }

  let days = 0;

  for (let t = a; t <= b; t += 86_400_000) {
    if (![0, 6].includes(new Date(t).getUTCDay())) {
      days += 1;
    }
  }

  if (!days) {
    throw new Error("Choose at least one weekday.");
  }

  return days;
}

export const adapters = {
  "utc-weekday-range/v1": {
    validate(
      mapping: DateMapping,
      inputs: Readonly<Record<string, FieldSchema>>
    ) {
      if (Object.keys(mapping).toSorted().join(",") !== "end,output,start") {
        throw new Error("Date adapter requires start, end, output mappings.");
      }

      if (new Set(Object.values(mapping)).size !== 3) {
        throw new Error("Date adapter mappings must be distinct.");
      }

      for (const name of Object.values(mapping)) {
        if (!inputs[name]) {
          throw new Error(`Unknown adapter input ${name}`);
        }
      }

      if (
        inputs[mapping.start]?.type !== "string" ||
        inputs[mapping.end]?.type !== "string" ||
        inputs[mapping.output]?.type !== "integer"
      ) {
        throw new Error("Date adapter schema mismatch.");
      }
    },
    apply(args: Record<string, unknown>, mapping: DateMapping) {
      const days = businessDays(args[mapping.start], args[mapping.end]);

      if (args[mapping.output] !== undefined && args[mapping.output] !== days) {
        throw new Error(
          "The number of days must match the weekdays in these dates."
        );
      }

      args[mapping.output] = days;
    },
  },
};
