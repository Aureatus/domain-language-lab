// Framework loading bridge; authored domain, records and views live in text modules.
import {loadSource} from '../syntax/load.mjs';
import {createInterpreter,validateState} from '../semantic/v2/core.mjs';
const loaded=loadSource(new URL('./browser.domain',import.meta.url));
export const {domain,application}=loaded.declaration;
export const sourceMap=loaded.sourceMap;
export const leaveModel=domain;
export const runtime=createInterpreter(domain);
export const initialState=validateState(domain,loaded.declaration.initialState);
export default {domain,initialState,application};
