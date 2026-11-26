// TEST ONLY: fixed pre-text-frontend declaration, not imported by production.
// Kept independently from the parser/source so parity detects semantic drift.
import type {Scalar} from '../../semantic/v2/types.ts';
const literal=(value:Scalar)=>({op:'literal',value});
const input=(name:string)=>({op:'input',name});
const field=(binding:string,name:string)=>({op:'field',binding,field:name});
const bin=<L,R>(op:string,left:L,right:R)=>({op,left,right});
const actor={op:'actor'},string={type:'string'},integer=(min:number)=>({type:'integer',min});
const e=(name:string)=>field('request.employee',name),threshold=field('request.settings','threshold');
const domain={
  format:'semantic-core/v2',id:'time-away',
  resources:{employee:{fields:{name:string,balance:integer(0),manager:string}},settings:{fields:{threshold:integer(1),manager:string}},leave:{fields:{owner:string,manager:string,start:string,end:string,days:integer(1),status:{type:'string',enum:['approved']}}}},
  relationships:[{id:'employee.manager',resource:'employee',field:'manager'},{id:'leave.owner',resource:'leave',field:'owner'},{id:'leave.manager',resource:'leave',field:'manager'},{id:'settings.manager',resource:'settings',field:'manager'}],
  actions:{
    'leave.request':{
      inputs:{employeeId:string,leaveId:string,start:string,end:string,days:integer(1)},
      bindings:[{id:'request.employee',resource:'employee',key:input('employeeId')},{id:'request.settings',resource:'settings',key:literal('leave-rule')}],
      preconditions:[{id:'leave.enough-days',when:bin('le',input('days'),e('balance'))}],
      policies:[
        {id:'leave.owner-only',effect:'deny',when:{op:'not',value:bin('eq',actor,input('employeeId'))}},
        {id:'leave.short-break',effect:'allow',when:bin('lt',input('days'),threshold)},
        {id:'leave.manager-approval',effect:'approval-required',when:bin('le',threshold,input('days')),approvers:e('manager')},
      ],
      updates:[{id:'leave.deduct-days',target:'request.employee',field:'balance',value:bin('sub',e('balance'),input('days'))}],
      inserts:[{id:'leave.create',resource:'leave',key:input('leaveId'),values:{owner:input('employeeId'),manager:e('manager'),start:input('start'),end:input('end'),days:input('days'),status:literal('approved')}}],
      deletes:[],observe:[{binding:'request.employee',relationship:'employee.manager'},{binding:'leave.create',relationship:'leave.owner'},{binding:'leave.create',relationship:'leave.manager'}],
    },
    'settings.change':{
      inputs:{threshold:integer(1)},bindings:[{id:'edit.settings',resource:'settings',key:literal('leave-rule')}],preconditions:[],
      policies:[{id:'settings.manager-only',effect:'allow',when:bin('eq',actor,field('edit.settings','manager'))}],
      updates:[{id:'settings.set-threshold',target:'edit.settings',field:'threshold',value:input('threshold')}],inserts:[],deletes:[],observe:[{binding:'edit.settings',relationship:'settings.manager'}],
    },
  },
};
const initialState={revision:0,records:{employee:{maya:{version:0,values:{name:'Maya Chen',balance:5,manager:'sam'}},leo:{version:0,values:{name:'Leo Martin',balance:5,manager:'sam'}}},settings:{'leave-rule':{version:0,values:{threshold:3,manager:'sam'}}},leave:{}}};
const application={
  version:'model-application/v1',title:'Time away',eyebrow:'A little room for what matters',subtitle:'Plan a break. We’ll take care of the paperwork.',scope:'Local identity simulation · Monday–Friday only · no holiday calendar',
  actors:[{id:'maya',label:'Maya Chen · employee',name:'Maya Chen'},{id:'leo',label:'Leo Martin · employee',name:'Leo Martin'},{id:'sam',label:'Sam Rivera · manager',name:'Sam Rivera'}],
  actions:{
    'leave.request':{label:'Request time off',description:'Choose your dates. Your balance changes only when the request is completed.',fields:{employeeId:{binding:{source:'actor'}},leaveId:{binding:{source:'operation-id'}},start:{label:'First day',default:'2026-11-20'},end:{label:'Last day',default:'2026-11-20'},days:{label:'Weekdays'}},adapters:[{name:'utc-weekday-range/v1',mapping:{start:'start',end:'end',output:'days'}}]},
    'settings.change':{label:'Save approval rule',description:'Requests at or above this many weekdays need approval. Shorter breaks are approved automatically.',fields:{threshold:{label:'Approval needed from (days)',default:{resource:'settings',key:'leave-rule',field:'threshold'}}}},
  },
  views:[
    {kind:'summary',resource:'employee',key:'$actor',label:'Your time to recharge',fields:[{field:'name',label:'Team member'},{field:'balance',label:'Days remaining'}]},
    {kind:'summary',resource:'settings',key:'leave-rule',label:'The current rule',fields:[{field:'threshold',label:'Days or more need approval'}]},
    {kind:'list',resource:'leave',label:'Saved time off',columns:[{field:'owner',label:'Team member'},{field:'start',label:'First day',format:'date'},{field:'end',label:'Last day',format:'date'},{field:'days',label:'Weekdays'},{field:'status',label:'Status'}]},
  ],
};
export default {domain,initialState,application};
