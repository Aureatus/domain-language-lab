import declaration from './model.ts';
import {deriveApplication,buildInvocation} from '../application/derive.ts';
export {businessDays} from '../application/inputs.ts';
const {contract}=deriveApplication(declaration);
export const requestInvocation=({id,actor,start,end,days,clock=1})=>buildInvocation(contract,{id,actor,clock,action:'leave.request',args:{start,end,...(days===undefined?{}:{days})}});
