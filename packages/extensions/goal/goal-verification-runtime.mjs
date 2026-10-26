import path from 'node:path';
import {GoalVerificationStore} from './goal-verification-store.mjs';
import {GoalVerificationBundleBuilder} from './goal-verification-bundle.mjs';
import {GoalVerificationCoordinator} from './goal-verification-coordinator.mjs';

// The reference project creates this optional extension beside the Goal API.
// Keeping construction here means the ordinary task service can remain unaware
// of verification storage and can keep running when the feature is disabled.
export function createGoalVerificationRuntime({root, taskStore, workspaceFiles, goalStore, verifier, enabled = false, autoRun = true} = {}) {
  if (!enabled || !verifier) return undefined;
  const store = new GoalVerificationStore({root});
  const bundles = new GoalVerificationBundleBuilder(taskStore, {
    workspaceFiles,
    snapshotRoot: path.join(root, 'runtime', 'goal-verifications'),
  });
  const coordinator = new GoalVerificationCoordinator(goalStore, store, bundles, verifier, {autoRun});
  const port = {
    request: (goal, trigger = 'completion_request') => coordinator.request(goal, trigger),
    list: taskId => store.listForTask(taskId),
    get: (taskId, verificationId) => {
      const run = store.get(verificationId);
      return run?.taskId === taskId ? run : undefined;
    },
  };
  return {store, bundles, coordinator, port, start: () => coordinator.start(), stop: () => coordinator.stop(), close: () => store.close()};
}
