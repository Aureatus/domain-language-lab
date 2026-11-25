// Trusted host adapter registry. Configuration never supplies executable code.
export function businessDays(start,end) {
  const parse=value=>{
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('Choose valid dates in YYYY-MM-DD format.');
    const d=new Date(`${value}T00:00:00Z`);
    if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==value)throw Error('Choose real calendar dates.');
    return +d;
  };
  const a=parse(start),b=parse(end);
  if(b<a)throw Error('The end date must be on or after the start date.');
  if((b-a)/86400000>3660)throw Error('Choose a date range shorter than ten years.');
  let days=0;for(let t=a;t<=b;t+=86400000)if(![0,6].includes(new Date(t).getUTCDay()))days++;
  if(!days)throw Error('Choose at least one weekday.');
  return days;
}
export const adapters={
  'utc-weekday-range/v1':{
    validate(mapping,inputs){
      if(Object.keys(mapping).sort().join(',')!=='end,output,start')throw Error('Date adapter requires start, end, output mappings.');
      if(new Set(Object.values(mapping)).size!==3)throw Error('Date adapter mappings must be distinct.');
      for(const name of Object.values(mapping))if(!inputs[name])throw Error(`Unknown adapter input ${name}`);
      if(inputs[mapping.start].type!=='string'||inputs[mapping.end].type!=='string'||inputs[mapping.output].type!=='integer')throw Error('Date adapter schema mismatch.');
    },
    apply(args,mapping){
      const days=businessDays(args[mapping.start],args[mapping.end]);
      if(args[mapping.output]!==undefined&&args[mapping.output]!==days)throw Error('The number of days must match the weekdays in these dates.');
      args[mapping.output]=days;
    },
  },
};
