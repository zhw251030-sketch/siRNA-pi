import test from 'node:test';
import assert from 'node:assert/strict';
import * as lifecycle from '../apps/api/service-lifecycle.mjs';
import {createGoalVerificationRuntime} from '../packages/extensions/goal/goal-verification-runtime.mjs';

test('disabled Goal verification runtime does not create storage or a coordinator', () => {
  assert.equal(createGoalVerificationRuntime({enabled: false}), undefined);
});

test('optional Goal verification starts only after HTTP listening and drains before stores close', async () => {
  const events = [];
  const server = {
    listening: false,
    close(callback) { events.push('http-close'); callback(); },
    waitForTaskCompletion: async () => { events.push('messages'); },
  };
  const goalVerification = {
    start() { events.push('verification-start'); },
    stop() { events.push('verification-stop'); },
  };

  assert.throws(() => lifecycle.startApiServices({server, goalVerification}));
  assert.deepEqual(events, []);

  server.listening = true;
  lifecycle.startApiServices({server, goalVerification});
  assert.deepEqual(events, ['verification-start']);

  await lifecycle.createApiShutdown({
    server,
    goalVerification,
    stores: [{close() { events.push('store-close'); }}],
  })();
  assert.deepEqual(events, ['verification-start', 'verification-stop', 'http-close', 'messages', 'store-close']);
});
