// Select records exactly as the declared summary/list does, before formatting.
export function viewRecords(snapshot,view,actor){
  return Object.entries(snapshot.state.records[view.resource]).filter(([id,r])=>
    (!view.key||id===(view.key==='$actor'?actor:view.key))&&
    (!view.ownerField||r.values[view.ownerField]===actor));
}
