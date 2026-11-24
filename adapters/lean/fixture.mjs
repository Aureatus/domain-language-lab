// Independent generic fixture using the shared semantic-core/v1 declarations.
const lit = value => ({op: 'literal', value});
const field = name => ({op: 'field', binding: 'capacity.record', field: name});
const input = name => ({op: 'input', name});
export const model = {
  format: 'semantic-core/v1', id: 'numeric-capacity.v1',
  resources: {capacity: {fields: {remaining: {type: 'integer', min: 0}, previous: {type: 'integer', min: 0}}}},
  relationships: [],
  actions: {'capacity.take': {
    inputs: {amount: {type: 'integer', min: 1}},
    bindings: [{id: 'capacity.record', resource: 'capacity', key: lit('main')}],
    policies: [{id: 'capacity.allow', effect: 'allow', when: lit(true)}],
    preconditions: [{id: 'capacity.available', when: {op: 'le', left: input('amount'), right: field('remaining')}}],
    updates: [
      {id: 'capacity.decrement', target: 'capacity.record', field: 'remaining', value: {op: 'sub', left: field('remaining'), right: input('amount')}},
      {id: 'capacity.remember', target: 'capacity.record', field: 'previous', value: field('remaining')},
    ], observe: [],
  }},
};
export const obligation = {
  format: 'numeric-law/v1', id: 'capacity.safe-decrement.v1',
  action: 'capacity.take',
  // Laws are independent of the generated update equations.
  ensures: {op: 'and', left: {op: 'le', left: lit(0), right: {op: 'post', field: 'remaining'}}, right: {
    op: 'eq', left: {op: 'add', left: {op: 'post', field: 'remaining'}, right: input('amount')}, right: {op: 'pre', field: 'remaining'},
  }},
  witness: {pre: {remaining: 10, previous: 0, revision: 0, version: 0}, inputs: {amount: 3, clock: 0}, post: {remaining: 7, previous: 10, revision: 1, version: 1}},
};
