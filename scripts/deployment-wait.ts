export const DEPLOYMENT_VERIFY_ATTEMPTS = 25;

export function deploymentVerifyDelay(completedAttempt: number): number {
  return Math.min(1000 * 2 ** completedAttempt, 5000);
}
