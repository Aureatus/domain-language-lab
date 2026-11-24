// Tiny non-leave MODEL TEST fixture; not another shipped application.
const literal=value=>({op:'literal',value}),input=name=>({op:'input',name}),field=name=>({op:'field',binding:'selected',field:name});
export const fixture={
  domain:{format:'semantic-core/v2',id:'supplies-test',resources:{cabinet:{fields:{caption:{type:'string'},stock:{type:'integer',min:0},reviewer:{type:'string'}}}},relationships:[],actions:{
    'supply.take':{inputs:{cabinetKey:{type:'string'},quantity:{type:'integer',min:1,max:10},reason:{type:'string',enum:['Workshop','Repair']},tracked:{type:'boolean'}},
      bindings:[{id:'selected',resource:'cabinet',key:input('cabinetKey')}],preconditions:[{id:'supply.available',when:{op:'le',left:input('quantity'),right:field('stock')}}],
      policies:[{id:'supply.small',effect:'allow',when:{op:'lt',left:input('quantity'),right:literal(2)}},{id:'supply.review',effect:'approval-required',when:{op:'le',left:literal(2),right:input('quantity')},approvers:field('reviewer')}],
      updates:[{id:'supply.spend',target:'selected',field:'stock',value:{op:'sub',left:field('stock'),right:input('quantity')}}],inserts:[],deletes:[],observe:[]},
  }},
  initialState:{revision:0,records:{cabinet:{tools:{version:0,values:{caption:'Tool cabinet',stock:8,reviewer:'quinn'}}}}},
  application:{version:'model-application/v1',title:'Supply fixture',actors:[{id:'nora',label:'Nora'},{id:'quinn',label:'Quinn'}],actions:{'supply.take':{fields:{cabinetKey:{reference:{resource:'cabinet',labelField:'caption'}},quantity:{default:1}}}}},
};
export function renamedFixture(){
  const names={cabinet:'rack',caption:'description',stock:'remaining',reviewer:'checker',selected:'chosen','supply.take':'kit.issue',cabinetKey:'rackId',quantity:'units',reason:'purpose',tracked:'logged',nora:'ari',quinn:'devon',tools:'parts','supply.review':'kit.authorization','supply.small':'kit.direct','supply.available':'kit.available','supply.spend':'kit.spend'};
  const rename=x=>Array.isArray(x)?x.map(rename):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[names[k]??k,rename(v)])):names[x]??x;
  return rename(fixture);
}
export function extendedFixture(){
  const x=structuredClone(fixture);
  x.application.actors.push({id:'rory',label:'Rory'});
  x.domain.actions['supply.take'].inputs.memo={type:'string'};
  x.domain.actions['supply.take'].policies[1].approvers={op:'literal',value:'rory'};
  x.domain.actions['supply.audit']={inputs:{note:{type:'string'}},bindings:[],preconditions:[],policies:[{id:'supply.audit-allowed',effect:'allow',when:literal(true)}],updates:[],inserts:[],deletes:[],observe:[]};
  return x;
}
