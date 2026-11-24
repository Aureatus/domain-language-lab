// Test declaration: one inherited mode, three overrides, one atomic snapshot.
import leave from '../../leave/model.mjs';
const fixture=structuredClone(leave);
fixture.application.loading='icon';
fixture.application.views=[undefined,'text','skeleton','wait'].map((loading,i)=>({
  ...leave.application.views[0],label:`Record group ${i}`, ...(loading?{loading}:{})
}));
export default fixture;
