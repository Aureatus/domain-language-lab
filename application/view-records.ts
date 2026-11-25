// Select records exactly as the declared summary/list does, before formatting.
interface RecordView {resource:string;key?:string;ownerField?:string}
export function viewRecords<R extends {values:Record<string,unknown>}>(snapshot:{state:{records:Record<string,Record<string,R>>}},view:RecordView,actor:string){
  return Object.entries(snapshot.state.records[view.resource]).filter(([id,r])=>
    (!view.key||id===(view.key==='$actor'?actor:view.key))&&
    (!view.ownerField||r.values[view.ownerField]===actor));
}
