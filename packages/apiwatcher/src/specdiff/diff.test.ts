import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffSpecs } from './diff.js';
import { classifyTypeChange } from './compat.js';
import { flattenOwnFields, type OpenApiSpec, type SchemaNode } from './openapi.js';

/** Minimal spec builder so each test states only what it is about. */
function spec(version: string, body: Partial<OpenApiSpec> = {}): OpenApiSpec {
  return {
    openapi: '3.0.0',
    info: { version },
    paths: {},
    components: { schemas: {} },
    ...body,
  };
}

function formBody(properties: Record<string, SchemaNode>, required: string[] = []): unknown {
  return {
    content: {
      'application/x-www-form-urlencoded': {
        schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
      },
    },
  };
}

test('flattenOwnFields treats $ref as a boundary', () => {
  const s = spec('2025-01-01', {
    components: {
      schemas: {
        parent: {
          type: 'object',
          properties: {
            own: { type: 'string' },
            child: { $ref: '#/components/schemas/child' },
          },
        },
        child: { type: 'object', properties: { deep: { type: 'string' } } },
      },
    },
  });

  const fields = flattenOwnFields(s, s.components?.schemas?.parent);
  assert.deepEqual([...fields.keys()].sort(), ['child', 'own']);
  // `child.deep` belongs to the child schema and is diffed there, not here.
  assert.equal(fields.has('child.deep'), false);
});

test('flattenOwnFields marks a field required only when every ancestor is', () => {
  const s = spec('2025-01-01', {
    components: {
      schemas: {
        root: {
          type: 'object',
          required: ['mandatory'],
          properties: {
            mandatory: { type: 'object', required: ['inner'], properties: { inner: { type: 'string' } } },
            optional: { type: 'object', required: ['inner'], properties: { inner: { type: 'string' } } },
          },
        },
      },
    },
  });

  const fields = flattenOwnFields(s, s.components?.schemas?.root);
  assert.equal(fields.get('mandatory.inner')?.requiredPath, true);
  // Required inside an optional object: only binds callers who send the parent.
  assert.equal(fields.get('optional.inner')?.required, true);
  assert.equal(fields.get('optional.inner')?.requiredPath, false);
});

test('a removed endpoint is breaking', () => {
  const before = spec('2025-01-01', { paths: { '/v1/old': { get: { operationId: 'GetOld' } } } });
  const after = spec('2025-06-01', { paths: {} });

  const cs = diffSpecs(before, after);
  assert.equal(cs.changes.length, 1);
  assert.equal(cs.changes[0]?.kind, 'removed');
  assert.equal(cs.changes[0]?.location, 'operation');
  assert.equal(cs.changes[0]?.severity, 'breaking');
  assert.equal(cs.from, '2025-01-01');
  assert.equal(cs.to, '2025-06-01');
});

test('a new endpoint is reported only with includeAdditive', () => {
  const before = spec('2025-01-01', { paths: {} });
  const after = spec('2025-06-01', { paths: { '/v1/new': { get: {} } } });

  assert.equal(diffSpecs(before, after).changes.length, 0);
  const withAdditive = diffSpecs(before, after, { includeAdditive: true });
  assert.equal(withAdditive.changes.length, 1);
  assert.equal(withAdditive.changes[0]?.severity, 'additive');
});

test('removing a request parameter does not also report its children', () => {
  const before = spec('2025-01-01', {
    paths: {
      '/v1/x': {
        post: {
          requestBody: formBody({
            tipping: {
              type: 'object',
              properties: { bgn: { type: 'object', properties: { amount: { type: 'integer' } } } },
            },
          }),
        },
      },
    },
  });
  const after = spec('2025-06-01', {
    paths: { '/v1/x': { post: { requestBody: formBody({ tipping: { type: 'object', properties: {} } }) } } },
  });

  const removed = diffSpecs(before, after).changes.filter((c) => c.kind === 'removed');
  assert.deepEqual(
    removed.map((c) => c.field),
    ['tipping.bgn'],
  );
});

test('an unrelated field pair is not mistaken for a rename', () => {
  const before = spec('2025-01-01', {
    paths: { '/v1/x': { post: { requestBody: formBody({ bgn: { type: 'string' } }) } } },
  });
  const after = spec('2025-06-01', {
    paths: { '/v1/x': { post: { requestBody: formBody({ gip: { type: 'string' } }) } } },
  });

  const kinds = diffSpecs(before, after, { includeAdditive: true })
    .changes.map((c) => c.kind)
    .sort();
  // Two unrelated currency keys: a removal and an addition, never a rename.
  assert.deepEqual(kinds, ['added', 'removed']);
});

test('a genuine rename is detected', () => {
  const before = spec('2025-01-01', {
    paths: { '/v1/x': { post: { requestBody: formBody({ risk_level: { type: 'string' } }) } } },
  });
  const after = spec('2025-06-01', {
    paths: { '/v1/x': { post: { requestBody: formBody({ level: { type: 'string' } }) } } },
  });

  const changes = diffSpecs(before, after).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, 'renamed');
  assert.equal(changes[0]?.field, 'risk_level');
  assert.equal(changes[0]?.replacement, 'level');
});

test('a newly required nested parameter says what it is conditional on', () => {
  const before = spec('2025-01-01', {
    paths: {
      '/v1/x': {
        post: {
          requestBody: formBody({
            cfg: { type: 'object', properties: { a: { type: 'string' } } },
          }),
        },
      },
    },
  });
  const after = spec('2025-06-01', {
    paths: {
      '/v1/x': {
        post: {
          requestBody: formBody({
            cfg: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
          }),
        },
      },
    },
  });

  const changes = diffSpecs(before, after).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, 'required');
  assert.match(changes[0]?.note ?? '', /whenever "cfg" is provided/);
});

test('a top-level newly required parameter is stated unconditionally', () => {
  const before = spec('2025-01-01', {
    paths: { '/v1/x': { post: { requestBody: formBody({ a: { type: 'string' } }) } } },
  });
  const after = spec('2025-06-01', {
    paths: { '/v1/x': { post: { requestBody: formBody({ a: { type: 'string' } }, ['a']) } } },
  });

  const changes = diffSpecs(before, after).changes;
  assert.equal(changes[0]?.kind, 'required');
  assert.doesNotMatch(changes[0]?.note ?? '', /whenever/);
});

test('response changes are attributed to the endpoints returning the resource', () => {
  const build = (props: Record<string, SchemaNode>, version: string): OpenApiSpec =>
    spec(version, {
      paths: {
        '/v1/widgets/{id}': {
          get: {
            responses: {
              '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/widget' } } } },
            },
          },
        },
      },
      components: {
        schemas: { widget: { type: 'object', 'x-resourceId': 'widget', properties: props } },
      },
    });

  const cs = diffSpecs(
    build({ keep: { type: 'string' }, gone: { type: 'string' } }, '2025-01-01'),
    build({ keep: { type: 'string' } }, '2025-06-01'),
  );

  assert.equal(cs.changes.length, 1);
  const change = cs.changes[0];
  assert.equal(change?.kind, 'removed');
  assert.equal(change?.location, 'response');
  assert.equal(change?.resource, 'widget');
  assert.equal(change?.field, 'gone');
  assert.deepEqual(change?.endpoints, [{ method: 'get', path: '/v1/widgets/{id}' }]);
  assert.deepEqual(change?.fieldPaths, ['gone']);
});

test('a nested resource change cites the path a caller reads it through', () => {
  const build = (childProps: Record<string, SchemaNode>, version: string): OpenApiSpec =>
    spec(version, {
      paths: {
        '/v1/parents': {
          get: {
            responses: {
              '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/parent' } } } },
            },
          },
        },
      },
      components: {
        schemas: {
          parent: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/item' } },
            },
          },
          item: { type: 'object', properties: childProps },
        },
      },
    });

  const cs = diffSpecs(
    build({ amount: { type: 'integer' }, legacy: { type: 'string' } }, '2025-01-01'),
    build({ amount: { type: 'integer' } }, '2025-06-01'),
  );

  const change = cs.changes.find((c) => c.resource === 'item');
  assert.ok(change, 'expected a change on the item schema');
  assert.equal(change?.field, 'legacy');
  // Reported once against `item`, but citeable at the path callers actually use.
  assert.deepEqual(change?.fieldPaths, ['items[].legacy']);
});

test('a removed webhook event is breaking', () => {
  const withEvents = (events: string[], version: string): OpenApiSpec =>
    spec(version, {
      components: {
        schemas: Object.fromEntries(events.map((e) => [e, { 'x-stripeEvent': { type: e } }])),
      },
    });

  const cs = diffSpecs(withEvents(['a.b', 'c.d'], '2025-01-01'), withEvents(['a.b'], '2025-06-01'));
  assert.equal(cs.changes.length, 1);
  assert.equal(cs.changes[0]?.location, 'event');
  assert.equal(cs.changes[0]?.event, 'c.d');
  assert.equal(cs.changes[0]?.severity, 'breaking');
});

// --- type compatibility ----------------------------------------------------

test('enum widening is additive, narrowing breaks only the sending side', () => {
  const narrow = 'enum(a|b)';
  const wide = 'enum(a|b|c)';

  assert.equal(classifyTypeChange(narrow, wide, 'request').severity, 'additive');
  assert.equal(classifyTypeChange(narrow, wide, 'response').severity, 'additive');

  // Losing an accepted value breaks callers who send it.
  assert.equal(classifyTypeChange(wide, narrow, 'request').severity, 'breaking');
  // Losing a returned value only leaves a dead branch behind.
  assert.equal(classifyTypeChange(wide, narrow, 'response').severity, 'additive');
});

test('a scalar type swap is breaking in both directions', () => {
  for (const direction of ['request', 'response'] as const) {
    const verdict = classifyTypeChange('integer', 'string', direction);
    assert.equal(verdict.changed, true);
    assert.equal(verdict.severity, 'breaking');
  }
});

test('identical signatures are not a change', () => {
  assert.equal(classifyTypeChange('enum(a|b)', 'enum(b|a)', 'request').changed, false);
  assert.equal(classifyTypeChange('string', 'string', 'response').changed, false);
});

test('a required field inside a newly added parent is a new feature, not a break', () => {
  const before = spec('2025-01-01', {
    paths: { '/v1/x': { post: { requestBody: formBody({ existing: { type: 'string' } }) } } },
  });
  const after = spec('2025-06-01', {
    paths: {
      '/v1/x': {
        post: {
          requestBody: formBody({
            existing: { type: 'string' },
            // Whole object is new; nobody could have been sending it.
            custom_fields: {
              type: 'array',
              items: { type: 'object', required: ['name', 'value'], properties: { name: { type: 'string' }, value: { type: 'string' } } },
            },
          }),
        },
      },
    },
  });

  const breaking = diffSpecs(before, after).changes.filter((c) => c.severity === 'breaking');
  assert.deepEqual(breaking, [], `expected no breaking changes, got ${JSON.stringify(breaking.map((c) => c.field))}`);
});

test('an enum inside an array widening is additive, narrowing breaks only senders', () => {
  const narrow = 'array<enum(a|b)>';
  const wide = 'array<enum(a|b|c)>';
  assert.equal(classifyTypeChange(narrow, wide, 'request').severity, 'additive');
  assert.equal(classifyTypeChange(narrow, wide, 'response').severity, 'additive');
  assert.equal(classifyTypeChange(wide, narrow, 'request').severity, 'breaking');
  assert.equal(classifyTypeChange(wide, narrow, 'response').severity, 'additive');
  assert.match(classifyTypeChange(narrow, wide, 'request').detail, /^items /);
});

test('union members are split at depth zero, not inside nested signatures', () => {
  // The nested enum's `|` must not be mistaken for a union separator.
  const a = 'union(array<enum(x|y)>|string)';
  const b = 'union(array<enum(x|y|z)>|string)';
  const verdict = classifyTypeChange(a, b, 'request');
  // One member changed (the array's enum widened); nothing was removed.
  assert.equal(verdict.severity, 'additive');
});

test('an array whose element type genuinely changes is still breaking', () => {
  assert.equal(classifyTypeChange('array<string>', 'array<integer>', 'response').severity, 'breaking');
});

test('a format annotation appearing is not a type change', () => {
  assert.equal(classifyTypeChange('string', 'string:currency', 'request').changed, false);
  assert.equal(classifyTypeChange('integer', 'integer:unix-time', 'response').changed, false);
});

test('a string becoming an enum restricts senders but not readers', () => {
  assert.equal(classifyTypeChange('string', 'enum(a|b)', 'request').severity, 'breaking');
  assert.equal(classifyTypeChange('string', 'enum(a|b)', 'response').changed, false);
});

test('a type that becomes a union still containing it is widening', () => {
  // An id string that can now also arrive expanded.
  const v = classifyTypeChange('string', 'union(object(price)|string)', 'response');
  assert.equal(v.severity, 'additive');
});

test('union members that each widened are one widening, not a swap', () => {
  const a = 'union(array<enum(x|y)>|enum(x|y))';
  const b = 'union(array<enum(x|y|z)>|enum(x|y|z))';
  assert.equal(classifyTypeChange(a, b, 'request').severity, 'additive');
  // But a member that genuinely narrowed still breaks a sender.
  assert.equal(classifyTypeChange(b, a, 'request').severity, 'breaking');
});

test('a renamed ref with identical fields produces no change; a lost field is reported under the field path', () => {
  const build = (refName: string, props: Record<string, SchemaNode>, version: string): OpenApiSpec =>
    spec(version, {
      paths: {
        '/v1/x': { post: { requestBody: formBody({ tip: { $ref: `#/components/schemas/${refName}` } }) } },
      },
      components: { schemas: { [refName]: { type: 'object', properties: props } } },
    });

  const renamedOnly = diffSpecs(
    build('tip_v1', { amount: { type: 'integer' } }, '2025-01-01'),
    build('tip_v2', { amount: { type: 'integer' } }, '2025-06-01'),
  );
  assert.deepEqual(renamedOnly.changes, [], 'a schema rename alone is not an API change');

  const lostField = diffSpecs(
    build('tip_v1', { amount: { type: 'integer' }, note: { type: 'string' } }, '2025-01-01'),
    build('tip_v2', { amount: { type: 'integer' } }, '2025-06-01'),
  );
  assert.equal(lostField.changes.length, 1);
  assert.equal(lostField.changes[0]?.kind, 'removed');
  assert.equal(lostField.changes[0]?.field, 'tip.note');
});
