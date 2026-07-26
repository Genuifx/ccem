const REQUIRED_JOB = 'build-desktop';

function fail(message) {
  throw new Error(`[windows-mode2-smoke] ${message}`);
}

export function exactRunNumber(value, label) {
  if (!/^\d+$/u.test(value ?? '')) fail(`${label} must be a GitHub run number`);
  return value;
}

export function exactRepository(value, label) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value ?? '')) {
    fail(`${label} must be an exact owner/name`);
  }
  return value;
}

export function exactWorkflowRef(value, repository, label) {
  if (
    typeof value !== 'string'
    || !value.startsWith(`${repository}/.github/workflows/`)
    || !/\.ya?ml@refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(value)
  ) fail(`${label} must be an exact repository-bound workflow ref`);
  return value;
}

export function exactProducerWorkflowRef(value, repository, label) {
  const exact = exactWorkflowRef(value, repository, label);
  if (!exact.startsWith(
    `${repository}/.github/workflows/mode2-signed-producer.yml@refs/`,
  )) fail(`${label} must identify mode2-signed-producer.yml`);
  return exact;
}

export function exactJob(value, label) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value ?? '')) fail(`${label} is invalid`);
  if (value !== REQUIRED_JOB) fail(`${label} must identify the signed producer build job`);
  return value;
}

export function createWindowsMode2GithubRunIdentity(environment) {
  const repository = exactRepository(environment.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  return {
    id: exactRunNumber(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    attempt: exactRunNumber(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    repository,
    workflowRef: exactWorkflowRef(
      environment.GITHUB_WORKFLOW_REF,
      repository,
      'GITHUB_WORKFLOW_REF',
    ),
    producerWorkflowRef: exactProducerWorkflowRef(
      environment.CCEM_MODE2_PRODUCER_WORKFLOW_REF,
      repository,
      'CCEM_MODE2_PRODUCER_WORKFLOW_REF',
    ),
    job: exactJob(environment.GITHUB_JOB, 'GITHUB_JOB'),
  };
}
