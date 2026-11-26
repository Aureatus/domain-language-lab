import { createInterpreter, validateState } from "../semantic/v2/core.ts";
// Framework loading bridge; authored domain, records and views live in text modules.
import { loadSource } from "../syntax/load.ts";

const loaded = loadSource(new URL("browser.domain", import.meta.url));
const { application: present } = loaded.declaration;

if (!present) {
  throw new Error("Missing time-away application declaration.");
}

const application = present;
const { domain } = loaded.declaration;
export const { sourceMap } = loaded;
export const leaveModel = domain;
export const runtime = createInterpreter(domain);

export const initialState = validateState(
  domain,
  loaded.declaration.initialState
);

export default { domain, initialState, application };
