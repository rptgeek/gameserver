const { test } = require('node:test');
const assert = require('node:assert/strict');

test('bootstrap template is normalized to LF even when sourced with CRLF', () => {
  process.env.BOOTSTRAP_TEMPLATE = '#!/usr/bin/env bash\r\nset -euo pipefail\r\necho ok\r\n';
  try {
    const { bootstrapTemplate } = require('../dist/routes.js');
    assert.equal(bootstrapTemplate(), '#!/usr/bin/env bash\nset -euo pipefail\necho ok\n');
  } finally {
    delete process.env.BOOTSTRAP_TEMPLATE;
  }
});

test('bundled bootstrap template contains no carriage returns', () => {
  const { bootstrapTemplate } = require('../dist/routes.js');
  assert.ok(!bootstrapTemplate().includes('\r'));
});
