/** Second consumer, illustrative issue data; no dependency on or edits to live/. */
export const issueModel = {
  format: 'semantic-core/v1', id: 'issues.v1',
  resources: {
    issues: {fields: {status: {type: 'string', enum: ['open', 'resolved']}, assignee: {type: 'string'}, watchers: {type: 'ids'}, updatedAt: {type: 'integer', min: 0}}},
    counters: {fields: {resolved: {type: 'integer', min: 0}}},
  },
  relationships: [{id: 'issue.assignee', resource: 'issues', field: 'assignee'}, {id: 'issue.watchers', resource: 'issues', field: 'watchers'}],
  actions: {
    'issue.resolve': {
      inputs: {issueId: {type: 'string'}},
      bindings: [{id: 'resolve.issue', resource: 'issues', key: {op: 'input', name: 'issueId'}}, {id: 'resolve.counter', resource: 'counters', key: {op: 'literal', value: 'global'}}],
      preconditions: [{id: 'resolve.open', when: {op: 'eq', left: {op: 'field', binding: 'resolve.issue', field: 'status'}, right: {op: 'literal', value: 'open'}}}],
      policies: [{id: 'resolve.assignee', effect: 'allow', when: {op: 'eq', left: {op: 'actor'}, right: {op: 'field', binding: 'resolve.issue', field: 'assignee'}}}],
      updates: [
        {id: 'resolve.status', target: 'resolve.issue', field: 'status', value: {op: 'literal', value: 'resolved'}},
        {id: 'resolve.time', target: 'resolve.issue', field: 'updatedAt', value: {op: 'clock'}},
        {id: 'resolve.count', target: 'resolve.counter', field: 'resolved', value: {op: 'add', left: {op: 'field', binding: 'resolve.counter', field: 'resolved'}, right: {op: 'literal', value: 1}}},
      ],
      observe: [{binding: 'resolve.issue', relationship: 'issue.assignee'}, {binding: 'resolve.issue', relationship: 'issue.watchers'}],
    },
  },
};
export const issueState = {revision: 0, records: {
  issues: {i1: {version: 0, values: {status: 'open', assignee: 'maya', watchers: ['maya', 'jon', 'jon'], updatedAt: 0}}},
  counters: {global: {version: 0, values: {resolved: 0}}},
}};
