import {loadSource} from '../syntax/load.mjs';
import {deriveApplication} from './derive.mjs';
import {loadingPlan,loadingPresentation} from './loading.mjs';
import {encodeJsonPretty} from '../adapters/effect/json.mjs';

const entry=process.argv[2];
if(!entry)throw Error('Usage: node application/inspect-loading.mjs VIEW.domain');
const {contract}=deriveApplication(loadSource(entry).declaration);
const examples=[
  ['before request',false,false,false], ['retry pending after failure',false,true,true],
  ['first request',false,true,false], ['first response',true,false,false],
  ['background refresh',true,true,false], ['refresh failed',true,false,true],
  ['identity changed, awaiting its data',false,true,false], ['no usable response',false,false,true]
];
console.log(encodeJsonPretty(loadingPlan(contract).map(region=>({...region,scenarios:examples.map(([event,owned,pending,failed])=>({event,facts:{owned,pending,failed},...loadingPresentation(region.strategy,{owned,pending,failed})}))}))));
