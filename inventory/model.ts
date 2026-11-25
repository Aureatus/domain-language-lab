import {createInterpreter, validateState} from '../semantic/core.ts';
import type {Action, Expr, FieldSchema, Model} from '../semantic/core.ts';
import {bin, field, input, integer, lit} from './declarations.ts';

const string: FieldSchema = {type:'string'};
function action(kind: string): Action {
  const prefix = `reservation.${kind}`, stock = `${prefix}.stock`, slot = `${prefix}.slot`;
  const s = (name:string) => field(stock,name), r = (name:string) => field(slot,name);
  const condition = (name:string,when:Expr) => ({id:`${prefix}.${name}`,when});
  const update = (target:string,name:string,value:Expr) => ({id:`${prefix}.set.${name}`,target,field:name,value});
  const reserve = kind === 'reserve';
  return {
    inputs:{stockId:string,slotId:string,...(reserve ? {quantity:integer(1),expiresAt:integer(0)} : {})},
    bindings:[{id:stock,resource:'stock',key:input('stockId')},{id:slot,resource:'reservation',key:input('slotId')}],
    policies:[{id:`${prefix}.ownership`,effect:'allow',when:bin('eq',{op:'actor'},kind === 'expire' ? s('operator') : r('owner'))}],
    preconditions:[condition('matchingStock',bin('eq',r('stockId'),input('stockId'))),
      condition('expectedStatus',bin('eq',r('status'),lit(reserve ? 'free':'active'))),
      ...(reserve ? [condition('capacity',bin('le',input('quantity'),s('available'))),condition('futureExpiry',bin('lt',{op:'clock'},input('expiresAt')))]
        : kind === 'expire' ? [condition('expiryBoundary',bin('le',r('expiresAt'),{op:'clock'}))] : [])],
    updates:[update(stock,'available',bin(reserve?'sub':'add',s('available'),reserve?input('quantity'):r('quantity'))),
      update(slot,'status',lit(reserve?'active':kind === 'cancel'?'cancelled':'expired')),
      ...(reserve ? [update(slot,'quantity',input('quantity')),update(slot,'expiresAt',input('expiresAt'))] : [])],
    observe:[{binding:stock,relationship:'stock.watchers'},{binding:slot,relationship:'reservation.owner'}]
  };
}
export const inventoryModel = {
  format:'semantic-core/v1',id:'inventory.v1',
  resources:{stock:{fields:{capacity:integer(0),available:integer(0),watchers:{type:'ids'},operator:string}},
    reservation:{fields:{stockId:string,owner:string,quantity:integer(0),expiresAt:integer(0),status:{type:'string',enum:['free','active','cancelled','expired']}}}},
  relationships:[{id:'stock.watchers',resource:'stock',field:'watchers'},{id:'reservation.owner',resource:'reservation',field:'owner'}],
  actions:Object.fromEntries(['reserve','cancel','expire'].map(k=>[`reservation.${k}`,action(k)]))
} satisfies Model;
export const runtime = createInterpreter(inventoryModel);
const record = (values:Record<string,Scalar|string[]>) => ({version:0,values});
export const initialState = validateState(inventoryModel,{revision:0,records:{stock:{camera:record({capacity:5,available:5,watchers:['warehouse','alice','bob'],operator:'warehouse'})},reservation:{
  slotA:record({stockId:'camera',owner:'alice',quantity:0,expiresAt:0,status:'free'}),
  slotB:record({stockId:'camera',owner:'bob',quantity:0,expiresAt:0,status:'free'}),
  slotC:record({stockId:'camera',owner:'alice',quantity:0,expiresAt:0,status:'free'})
}}});
export function invocation(id: string,kind: string,slotId='slotA',actor='alice',clock=10,quantity=3,expiresAt=30) {
  const args = {stockId:'camera',slotId,...(kind==='reserve'?{quantity,expiresAt}:{})};
  return {id,action:`reservation.${kind}`,actor,clock,args};
}
