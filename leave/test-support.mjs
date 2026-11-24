import declaration from './model.mjs';
import {deriveApplication,buildInvocation} from '../application/derive.mjs';
export {businessDays} from '../application/inputs.mjs';
const {contract}=deriveApplication(declaration);
export const requestInvocation=({id,actor,start,end,days,clock=1})=>buildInvocation(contract,{id,actor,clock,action:'leave.request',args:{start,end,...(days===undefined?{}:{days})}});
